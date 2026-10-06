/**
 * Incident harness: an RPC without websocket `signatureSubscribe`.
 *
 * Production: the relay's RPC answered `signatureSubscribe` with JSON-RPC
 * -32601. The memo submitter sent each memo and then waited on web3.js
 * `confirmTransaction`, which subscribes over a websocket — so every confirm
 * threw AFTER the memo had landed. The anchor row kept `tx_hash` NULL and every
 * cycle sent a new memo for the same root (the same root ~1,086 times in six
 * hours, draining the fee payer).
 *
 * Driven here through a REAL `SolanaMemoSubmitter` whose connection is a fake
 * RPC: `sendRawTransaction` succeeds and lands, the websocket confirm rejects
 * -32601, and HTTP `getSignatureStatuses` reports the truth. The anchoring
 * streams run through their real exported submit functions and the real
 * identity-log / transparency / revocation paths, cycle after cycle.
 *
 * The contract: one memo per root across many cycles, the row confirmed with
 * the signature that landed; a memo that never lands is re-sent exactly once
 * after its blockhash expires; a memo that landed with an error is a failure
 * (not a success) and is replaced by exactly one new memo on a later cycle;
 * overlapping ticks send once; a restart reconciles the recorded signature.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { generateKeypair, bytesToHex } from "@motebit/crypto";
import { base58Encode } from "@motebit/protocol";
import { openMotebitDatabase, type DatabaseDriver } from "@motebit/persistence";
import {
  SolanaMemoSubmitter,
  SolanaNetworkResolver,
  SOLANA_DEVNET_GENESIS_HASH,
} from "@motebit/wallet-solana";
import { randomBytes } from "node:crypto";
import type { RelayIdentity } from "../federation.js";
import {
  createIdentityLogAnchorTables,
  runIdentityLogAnchorTick,
} from "../identity-log-anchoring.js";
import {
  createAnchoringTables,
  submitAgentAnchorOnChain,
  submitAnchorOnChain,
} from "../anchoring.js";
import {
  createCredentialAnchoringTables,
  submitCredentialAnchorOnChain,
} from "../credential-anchoring.js";
import { drainAnchorBacklog } from "../anchor-submit-pacing.js";
import { attemptTransparencyAnchor } from "../transparency.js";

type Status = {
  slot: number;
  confirmations: number | null;
  err: unknown;
  confirmationStatus: string;
};

/**
 * A fake Solana RPC. Every sent memo lands (`land`) unless told otherwise;
 * the websocket confirm always fails the way the production RPC did.
 */
class FakeRpc {
  height = 10;
  lastValidSpan = 150;
  /** Every memo sent, in order: its signature and the anchored root / hash. */
  sends: { sig: string; memo: string }[] = [];
  statuses = new Map<string, Status | null>();
  /**
   * What happens to the next sends: "land" | "never" | "err" | "late" (not
   * visible when sent; the test lands it later with `land(sig)`).
   */
  plan: Array<"land" | "never" | "err" | "late"> = [];
  /** Signatures whose NEXT status read returns null once (a lagging load-balanced node). */
  absentOnce = new Set<string>();
  /** While set, every status read fails with an HTTP 500. */
  statusError = false;
  websocketConfirmCalls = 0;

  getGenesisHash = async (): Promise<string> => SOLANA_DEVNET_GENESIS_HASH;
  getLatestBlockhash = async (): Promise<{ blockhash: string; lastValidBlockHeight: number }> => ({
    blockhash: base58Encode(new Uint8Array(randomBytes(32))),
    lastValidBlockHeight: this.height + this.lastValidSpan,
  });
  sendRawTransaction = async (raw: Uint8Array): Promise<string> => {
    // Wire format: compact-u16 signature count (1), then the 64-byte fee-payer signature.
    const bytes = Buffer.from(raw);
    const sig = base58Encode(new Uint8Array(bytes.subarray(1, 65)));
    const memo = /motebit:[a-z]+:v1:[0-9a-f]+(?::\d+)?/.exec(bytes.toString("latin1"))?.[0] ?? "";
    this.sends.push({ sig, memo });
    const fate = this.plan.shift() ?? "land";
    this.statuses.set(
      sig,
      fate === "never" || fate === "late"
        ? null
        : {
            slot: 1_000 + this.sends.length,
            confirmations: null,
            err: fate === "err" ? { InstructionError: [0, { Custom: 1 }] } : null,
            confirmationStatus: "finalized",
          },
    );
    return sig;
  };
  /** web3.js 1.98: waits on a websocket `signatureSubscribe` this RPC does not implement. */
  confirmTransaction = async (): Promise<never> => {
    this.websocketConfirmCalls++;
    throw new Error(
      "signatureSubscribe error for argument [...]: -32601 Method 'signatureSubscribe' not found",
    );
  };
  getSignatureStatuses = async (
    sigs: string[],
  ): Promise<{ context: { slot: number }; value: (Status | null)[] }> => {
    if (this.statusError) throw new Error("500 Internal Server Error");
    return {
      context: { slot: 2_000 },
      value: sigs.map((s) => {
        if (this.absentOnce.delete(s)) return null;
        return this.statuses.get(s) ?? null;
      }),
    };
  };
  /** A "late" memo lands now (finalized, no error). */
  land(sig: string): void {
    this.statuses.set(sig, {
      slot: 1_500,
      confirmations: null,
      err: null,
      confirmationStatus: "finalized",
    });
  }
  getBlockHeight = async (): Promise<number> => this.height;
  getBalance = async (): Promise<number> => 1_000_000_000;
  getMinimumBalanceForRentExemption = async (): Promise<number> => 890_880;

  sendsOf(needle: string): string[] {
    return this.sends.filter((s) => s.memo.includes(needle)).map((s) => s.sig);
  }
}

/** A real memo submitter wired to the fake RPC (the connection field is replaced after construction). */
function memoSubmitterOn(rpc: FakeRpc): SolanaMemoSubmitter {
  const submitter = new SolanaMemoSubmitter({
    rpcUrl: "http://127.0.0.1:1",
    identitySeed: new Uint8Array(randomBytes(32)),
    // One status read per send: an undecided memo hands back immediately.
    confirm: { maxWaitMs: 0, pollMs: 1 },
    networkResolver: new SolanaNetworkResolver(() => rpc.getGenesisHash()),
  });
  (submitter as unknown as { connection: FakeRpc }).connection = rpc;
  return submitter;
}

interface Stream {
  name: string;
  table: string;
  idCol: string;
  submit: (db: DatabaseDriver, id: string, s: SolanaMemoSubmitter) => Promise<boolean>;
}

const STREAMS: Stream[] = [
  { name: "fed", table: "relay_anchor_batches", idCol: "batch_id", submit: submitAnchorOnChain },
  {
    name: "agent",
    table: "relay_agent_anchor_batches",
    idCol: "batch_id",
    submit: submitAgentAnchorOnChain,
  },
  {
    name: "cred",
    table: "relay_credential_anchor_batches",
    idCol: "batch_id",
    submit: submitCredentialAnchorOnChain,
  },
];

describe("anchoring on an RPC without websocket signatureSubscribe", () => {
  let db: DatabaseDriver;
  let relayIdentity: RelayIdentity;
  let rpc: FakeRpc;
  let submitter: SolanaMemoSubmitter;
  const roots: Record<string, string> = {};

  beforeEach(async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    db = (await openMotebitDatabase(":memory:")).db;
    for (const [t, cols] of [
      [
        "agent_registry",
        "motebit_id TEXT PRIMARY KEY, public_key TEXT NOT NULL, registered_at INTEGER NOT NULL",
      ],
      [
        "identity_keys",
        "motebit_id TEXT PRIMARY KEY, public_key TEXT NOT NULL, guardian_public_key TEXT, source TEXT NOT NULL, first_seen INTEGER, updated_at INTEGER NOT NULL",
      ],
    ] as const) {
      db.exec(`DROP TABLE IF EXISTS ${t}`);
      db.exec(`CREATE TABLE ${t} (${cols})`);
    }
    db.exec(
      "CREATE TABLE IF NOT EXISTS devices (device_id TEXT PRIMARY KEY, motebit_id TEXT NOT NULL, device_token TEXT, public_key TEXT NOT NULL, registered_at INTEGER NOT NULL)",
    );
    db.exec(
      "CREATE TABLE IF NOT EXISTS relay_key_successions (id INTEGER PRIMARY KEY, motebit_id TEXT NOT NULL, old_public_key TEXT NOT NULL, new_public_key TEXT NOT NULL, timestamp INTEGER NOT NULL, reason TEXT, old_key_signature TEXT, new_key_signature TEXT NOT NULL, recovery INTEGER DEFAULT 0, guardian_signature TEXT)",
    );
    createIdentityLogAnchorTables(db);
    createAnchoringTables(db);
    createCredentialAnchoringTables(db);
    db.exec(`CREATE TABLE IF NOT EXISTS relay_agent_anchor_batches (
      batch_id TEXT PRIMARY KEY, relay_id TEXT NOT NULL, merkle_root TEXT NOT NULL,
      leaf_count INTEGER NOT NULL, first_settled_at INTEGER NOT NULL, last_settled_at INTEGER NOT NULL,
      signature TEXT NOT NULL, tx_hash TEXT, network TEXT, anchored_at INTEGER,
      status TEXT NOT NULL DEFAULT 'signed', created_at INTEGER NOT NULL)`);
    const kp = await generateKeypair();
    relayIdentity = {
      relayMotebitId: "relay-test",
      publicKey: kp.publicKey,
      privateKey: kp.privateKey,
      publicKeyHex: bytesToHex(kp.publicKey),
      did: "did:key:test",
    };
    rpc = new FakeRpc();
    submitter = memoSubmitterOn(rpc);
    let k = 0;
    for (const s of STREAMS) {
      const extra =
        s.name === "cred" ? "first_issued_at, last_issued_at" : "first_settled_at, last_settled_at";
      const root = (0xa000 + k++).toString(16).padStart(64, "0");
      roots[s.name] = root;
      db.prepare(
        `INSERT INTO ${s.table} (batch_id, relay_id, merkle_root, leaf_count, ${extra}, signature, status, created_at)
         VALUES (?, 'relay-test', ?, 1, 1, 1, 'sig', 'signed', 1000)`,
      ).run(`${s.name}-0`, root);
    }
    roots.idlog = (0xb000).toString(16).padStart(64, "0");
    db.prepare(
      `INSERT INTO relay_identity_log_anchors (anchor_id, relay_id, merkle_root, leaf_count, signature, status, created_at)
       VALUES ('idlog-0', 'relay-test', ?, 1, 'sig', 'signed', 1000)`,
    ).run(roots.idlog);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function row(name: string): { status: string; tx_hash: string | null } {
    if (name === "idlog") {
      return db
        .prepare(
          "SELECT status, tx_hash FROM relay_identity_log_anchors WHERE anchor_id = 'idlog-0'",
        )
        .get() as { status: string; tx_hash: string | null };
    }
    const s = STREAMS.find((x) => x.name === name)!;
    return db
      .prepare(`SELECT status, tx_hash FROM ${s.table} WHERE ${s.idCol} = ?`)
      .get(`${name}-0`) as {
      status: string;
      tx_hash: string | null;
    };
  }

  /** One anchoring cycle: every stream's tick, as its loop runs it. */
  async function cycle(): Promise<void> {
    for (const s of STREAMS) {
      const ids = (
        db
          .prepare(
            `SELECT ${s.idCol} AS id FROM ${s.table} WHERE status = 'signed' AND tx_hash IS NULL`,
          )
          .all() as { id: string }[]
      ).map((r) => r.id);
      await drainAnchorBacklog(submitter, ids, (id) => s.submit(db, id, submitter));
    }
    await runIdentityLogAnchorTick(db, relayIdentity, { submitter }).catch(() => undefined);
  }

  it("a landed memo whose websocket confirm fails is sent ONCE per root across many cycles, confirmed with its signature", async () => {
    for (let i = 0; i < 6; i++) await cycle();
    const counts = Object.fromEntries(
      Object.entries(roots).map(([name, root]) => [name, rpc.sendsOf(root).length]),
    );
    expect(counts).toEqual({ fed: 1, agent: 1, cred: 1, idlog: 1 });
    for (const [name, root] of Object.entries(roots)) {
      const r = row(name);
      expect(r.status).toBe("confirmed");
      expect(r.tx_hash).toBe(rpc.sendsOf(root)[0]);
    }
    expect(rpc.websocketConfirmCalls).toBe(0);
  });

  it("a memo that never lands is re-sent exactly once after its blockhash expires", async () => {
    rpc.plan = ["never"]; // the first memo sent (fed) is dropped
    await cycle(); // sent; undecided
    await cycle(); // undecided, blockhash still valid: nothing sent
    await cycle();
    expect(rpc.sendsOf(roots.fed!)).toHaveLength(1);
    expect(row("fed").tx_hash).toBeNull();
    rpc.height += 1_000; // past lastValidBlockHeight: it can never land
    await cycle(); // exactly one replacement, which lands
    await cycle();
    await cycle();
    const sent = rpc.sendsOf(roots.fed!);
    expect(sent).toHaveLength(2);
    expect(row("fed")).toEqual({ status: "confirmed", tx_hash: sent[1] });
  });

  it("one absent status read past expiry does not re-send a memo that landed late", async () => {
    rpc.plan = ["late"]; // fed's memo is undecided when the confirm wait ends
    await cycle();
    const [first] = rpc.sendsOf(roots.fed!);
    expect(first).toBeDefined();
    rpc.land(first!); // it lands (finalized, no error)…
    rpc.height += 1_000; // …and the chain moves past its lastValidBlockHeight
    rpc.absentOnce.add(first!); // one lagging node answers [null] once
    await cycle();
    await cycle();
    await cycle();
    expect(rpc.sendsOf(roots.fed!)).toEqual([first]);
    expect(row("fed")).toEqual({ status: "confirmed", tx_hash: first });
  });

  it("a memo that never lands is replaced only after expiry is seen on two cycles, then never again", async () => {
    rpc.plan = ["never"];
    await cycle(); // sent; undecided
    rpc.height += 1_000; // past lastValidBlockHeight
    await cycle(); // first expiry observation: recorded, nothing sent
    expect(rpc.sendsOf(roots.fed!)).toHaveLength(1);
    expect(row("fed").tx_hash).toBeNull();
    await cycle(); // second observation: exactly one replacement, which lands
    await cycle();
    await cycle();
    await cycle();
    const sent = rpc.sendsOf(roots.fed!);
    expect(sent).toHaveLength(2);
    expect(row("fed")).toEqual({ status: "confirmed", tx_hash: sent[1] });
  });

  it("a status-lookup error past expiry is never an expiry observation", async () => {
    rpc.plan = ["never"];
    await cycle();
    rpc.height += 1_000;
    rpc.statusError = true;
    for (let i = 0; i < 5; i++) await cycle();
    expect(rpc.sendsOf(roots.fed!)).toHaveLength(1);
    expect(row("fed").tx_hash).toBeNull();
  });

  it("a memo that landed with an error is a failure, not a success, and is replaced by exactly one new memo", async () => {
    rpc.plan = ["err"]; // fed's memo lands with an InstructionError
    await cycle();
    expect(rpc.sendsOf(roots.fed!)).toHaveLength(1);
    expect(row("fed").tx_hash).toBeNull(); // never recorded as anchored
    await cycle(); // the recorded signature failed: one new memo, which lands
    await cycle();
    await cycle();
    const sent = rpc.sendsOf(roots.fed!);
    expect(sent).toHaveLength(2);
    expect(row("fed")).toEqual({ status: "confirmed", tx_hash: sent[1] });
  });

  it("overlapping ticks over an undecided memo send once", async () => {
    rpc.plan = ["never", "never", "never", "never"];
    await Promise.all([cycle(), cycle(), cycle()]);
    await Promise.all([cycle(), cycle()]);
    for (const root of Object.values(roots)) expect(rpc.sendsOf(root)).toHaveLength(1);
  });

  it("transparency: a restart reconciles the recorded signature instead of sending a new memo", async () => {
    const first = await attemptTransparencyAnchor(
      { anchored: false },
      relayIdentity,
      submitter,
      db,
    );
    expect(first).not.toBeNull();
    // A restart: fresh in-memory state, same database.
    const again = await attemptTransparencyAnchor(
      { anchored: false },
      relayIdentity,
      submitter,
      db,
    );
    expect(again?.txHash).toBe(first?.txHash);
    expect(rpc.sends.filter((s) => s.memo.startsWith("motebit:transparency:"))).toHaveLength(1);
  });
});
