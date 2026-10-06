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
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from "vitest";
import { generateKeypair, bytesToHex } from "@motebit/crypto";
import { base58Encode } from "@motebit/protocol";
import { openMotebitDatabase, type DatabaseDriver } from "@motebit/persistence";
import {
  SolanaMemoSubmitter,
  SolanaNetworkResolver,
  SOLANA_DEVNET_GENESIS_HASH,
} from "@motebit/wallet-solana";
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import * as broadcasts from "../anchor-broadcasts.js";
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
  /** Harness hooks (interleaving matrix): override a status read, a height read, or a send. */
  onStatus?: (sig: string) => Status | null | undefined;
  onBlockHeight?: () => number;
  /** Called with each signed transaction's signature; "before" / "after" stop the process around the send. */
  onSend?: (sig: string) => "crash-before-send" | "crash-after-send" | undefined;

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
    const stop = this.onSend?.(sig);
    if (stop === "crash-before-send") throw new Error("relay process stopped before the send");
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
    if (stop === "crash-after-send") throw new Error("relay process stopped after the send");
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
        const scripted = this.onStatus?.(s);
        if (scripted !== undefined) return scripted;
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
  getBlockHeight = async (): Promise<number> => {
    if (this.onBlockHeight) this.height = this.onBlockHeight();
    return this.height;
  };
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
  let clock = 0;
  /** The chain moves on far enough for a second expiry observation to count. */
  function laterOnChain(): void {
    clock += 180_000;
    rpc.height += broadcasts.DEFAULT_MIN_EXPIRY_GAP_BLOCKS;
  }

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
    clock = 1_000_000;
    broadcasts.configureAnchorBroadcasts(db, { now: () => clock });
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
    await cycle(); // first expiry observation: nothing sent
    laterOnChain();
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

  it("a memo that never lands is replaced only after expiry is seen twice, the configured block gap apart on the chain, then never again", async () => {
    rpc.plan = ["never"];
    await cycle(); // sent; undecided
    rpc.height += 1_000; // past lastValidBlockHeight
    await cycle(); // first expiry observation: recorded, nothing sent
    expect(rpc.sendsOf(roots.fed!)).toHaveLength(1);
    expect(row("fed").tx_hash).toBeNull();
    await cycle(); // seen again at once, same height: still nothing sent
    rpc.height += 1;
    clock += 3_600_000;
    await cycle(); // higher height, an hour later on the wall clock: still nothing sent
    rpc.height += broadcasts.DEFAULT_MIN_EXPIRY_GAP_BLOCKS - 2;
    await cycle(); // one block short of the gap: still nothing sent
    rpc.height -= 100;
    await cycle(); // the finalized height went backwards: never progress
    expect(rpc.sendsOf(roots.fed!)).toHaveLength(1);
    rpc.height += 101;
    await cycle(); // exactly the gap above the first observation: one replacement, which lands
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

/**
 * Exhaustive interleaving matrix for ONE root: a landed memo must never be
 * re-sent because of absent status reads, however the reconciliation passes
 * interleave; a memo that truly expired must be replaced exactly once.
 *
 * Generated cross product (no hand-listed cells):
 *   - ticks: sequential (one pass per 60 s tick); overlapping (two passes per
 *     tick, 10 ms apart, through the same pacer — the reviewed incident); mid-drain
 *     (two passes per tick running concurrently through separate pacers, so the
 *     second starts while the first is between its status read and its write);
 *   - the first signature's status reads, past its expiry, over the passes: every
 *     length-4 sequence over {landed-finalized, landed-confirmed, pending, null,
 *     lookup-error(500)} (1, 2 and 3 consecutive nulls interleaved with landed
 *     reads among them); after the script the chain tells the truth (landed ⇒
 *     finalized, never landed ⇒ null forever);
 *   - finalized height: advancing (+150 blocks per 60 s tick, +1 per read
 *     within it), or stalled (one height) for the whole script;
 *   - restart (fresh submitter + pacer, same database): none, after record before
 *     send, after send before confirm, between the two expiry observations.
 *
 * Ground truth: the first signature landed iff it was sent and the script
 * shows it landed. Landed ⇒ exactly one send for the root, row confirmed with
 * the FIRST signature. Never landed ⇒ exactly one replacement (total sends 2,
 * or 1 when the first was recorded but never sent), row confirmed with it.
 * Absent reads of a landed memo come from a lagging node; the matrix's lags
 * stay under the replacement gap (null reads span at most 3 ticks, about 300
 * blocks < 450), which is the bound the gap is set against.
 */
type Read = "LF" | "LC" | "P" | "N" | "E";
type TickMode = "sequential" | "overlap-10ms" | "mid-drain";
type HeightMode = "advancing" | "stalled";
type RestartPoint = "none" | "after-record" | "after-send" | "between-observations";

const READS: Read[] = ["LF", "LC", "P", "N", "E"];
const TICK_MODES: TickMode[] = ["sequential", "overlap-10ms", "mid-drain"];
const HEIGHT_MODES: HeightMode[] = ["advancing", "stalled"];
const RESTARTS: RestartPoint[] = ["none", "after-record", "after-send", "between-observations"];
const SCRIPT_LEN = 4;
const TICK_MS = 60_000;

function scripts(len: number): Read[][] {
  if (len === 0) return [[]];
  return scripts(len - 1).flatMap((s) => READS.map((r) => [...s, r]));
}

function statusOf(read: Exclude<Read, "N" | "E">): Status {
  return {
    slot: 1_200,
    confirmations: null,
    err: null,
    confirmationStatus: read === "LF" ? "finalized" : read === "LC" ? "confirmed" : "processed",
  };
}

describe("anchor broadcast reconciliation: exhaustive interleaving matrix", () => {
  let db: DatabaseDriver;
  let clock = 0;
  let cellNo = 0;
  const failures: string[] = [];
  let total = 0;

  beforeAll(async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    db = (await openMotebitDatabase(":memory:")).db;
    createAnchoringTables(db);
    broadcasts.configureAnchorBroadcasts(db, { now: () => clock });
  });

  afterAll(() => {
    vi.restoreAllMocks();
    const report = process.env.ANCHOR_MATRIX_REPORT;
    if (report) {
      writeFileSync(report, JSON.stringify({ total, failing: failures.length, failures }, null, 1));
    }
  });

  async function runCell(
    ticks: TickMode,
    height: HeightMode,
    restart: RestartPoint,
    script: Read[],
  ): Promise<string | null> {
    const n = cellNo++;
    const batchId = `matrix-${n}`;
    const root = (0x100000 + n).toString(16).padStart(64, "0");
    db.prepare(
      `INSERT INTO relay_anchor_batches (batch_id, relay_id, merkle_root, leaf_count, first_settled_at, last_settled_at, signature, status, created_at)
       VALUES (?, 'relay-test', ?, 1, 1, 1, 'sig', 'signed', 1000)`,
    ).run(batchId, root);

    const rpc = new FakeRpc();
    // Each submitter is a relay process: its boot reads the network (the
    // warm-up read and the supervised `solana-network` loop) before it anchors.
    const process_ = async (): Promise<SolanaMemoSubmitter> => {
      const s = memoSubmitterOn(rpc);
      await s.resolveNetwork();
      return s;
    };
    let primary = await process_();
    let secondary = await process_();
    let sig1: string | undefined;
    let sig1Sent = false;
    let reconciling = false;
    let readIdx = 0;
    let heightReads = 0;

    rpc.onSend = (sig) => {
      if (sig1 !== undefined) return undefined;
      sig1 = sig;
      if (restart === "after-record") return "crash-before-send";
      sig1Sent = true;
      return restart === "after-send" ? "crash-after-send" : undefined;
    };
    rpc.onBlockHeight = () => {
      if (!reconciling) return 10;
      heightReads++;
      if (height === "stalled" && readIdx < script.length) return 1_000;
      // About 150 blocks per 60 s tick, and one more per read within a tick.
      return 1_000 + Math.floor(clock / TICK_MS) * 150 + heightReads;
    };
    const landed = restart !== "after-record" && script.some((r) => r === "LF" || r === "LC");
    rpc.onStatus = (sig) => {
      if (sig !== sig1) return undefined;
      if (!reconciling) return null; // not visible yet when the send's own confirm reads it
      const read: Read = readIdx < script.length ? script[readIdx++]! : landed ? "LF" : "N";
      if (read === "E") throw new Error("500 Internal Server Error");
      if (read === "N" || !sig1Sent) return null;
      return statusOf(read);
    };

    const pass = (s: SolanaMemoSubmitter): Promise<boolean> => submitAnchorOnChain(db, batchId, s);
    const restartNow = async (): Promise<void> => {
      primary = await process_();
      secondary = await process_();
    };

    clock = 0;
    await pass(primary);
    if (restart === "after-record" || restart === "after-send") await restartNow();
    reconciling = true;
    let restarted = false;
    for (let k = 1; k <= SCRIPT_LEN + 8; k++) {
      clock = k * TICK_MS;
      if (ticks === "sequential") {
        await pass(primary);
      } else if (ticks === "overlap-10ms") {
        await pass(primary);
        clock += 10;
        await pass(primary);
      } else {
        await Promise.all([pass(primary), pass(secondary)]);
      }
      if (restart === "between-observations" && !restarted) {
        const r = db
          .prepare(
            "SELECT expired_seen_at FROM relay_anchor_broadcasts WHERE stream = 'federation-settlement' AND subject = ?",
          )
          .get(batchId) as { expired_seen_at: number | null } | undefined;
        if (r?.expired_seen_at != null) {
          await restartNow();
          restarted = true;
        }
      }
    }

    const sends = rpc.sendsOf(root);
    const row = db
      .prepare("SELECT status, tx_hash FROM relay_anchor_batches WHERE batch_id = ?")
      .get(batchId) as { status: string; tx_hash: string | null };
    const cell = `${ticks}/${height}/restart=${restart}/[${script.join(",")}]`;
    if (landed) {
      if (sends.length !== 1 || row.status !== "confirmed" || row.tx_hash !== sig1) {
        return `${cell}: landed first memo — sends=${sends.length}, status=${row.status}, confirmed with ${row.tx_hash === sig1 ? "first" : "another"} signature`;
      }
    } else {
      const want = sig1Sent ? 2 : 1;
      const replacement = sends[sends.length - 1];
      if (
        sends.length !== want ||
        replacement === sig1 ||
        row.status !== "confirmed" ||
        row.tx_hash !== replacement
      ) {
        return `${cell}: never-landed first memo — sends=${sends.length} (want ${want}), status=${row.status}`;
      }
    }
    return null;
  }

  for (const ticks of TICK_MODES) {
    for (const height of HEIGHT_MODES) {
      for (const restart of RESTARTS) {
        it(`${ticks} × height ${height} × restart ${restart}: every status-read script`, async () => {
          const local: string[] = [];
          for (const script of scripts(SCRIPT_LEN)) {
            total++;
            const f = await runCell(ticks, height, restart, script);
            if (f) local.push(f);
          }
          failures.push(...local);
          expect(local.slice(0, 3), `${local.length} failing cells`).toEqual([]);
        }, 120_000);
      }
    }
  }
});

/**
 * Clock × chain matrix for ONE root: the separation between the two expiry
 * observations must be measured on the CHAIN, so no wall clock — stepped,
 * jumped, or skewed between two relay processes on one database file — can
 * make a replacement happen sooner.
 *
 * Generated cross product (no hand-listed cells):
 *   - clock: monotonic (60 s per tick); a forward jump of +200 s once the first
 *     expiry observation is recorded; a backward step of −300 s at the same
 *     point; two relay processes on ONE database file, the second's clock
 *     240 s ahead (each tick: a pass in the first, then one in the second);
 *   - ticks: one pass per tick, or two (10 ms apart; in the two-process mode,
 *     one per process);
 *   - chain: the finalized height advances by +0, +1, +2, +3, +5 or +10 blocks
 *     per pass for the first 12 ticks after the memo's expiry, then at the
 *     ordinary pace (+150 blocks per pass, one 60 s tick);
 *   - the status node's lag behind the finalized height: 0, 10, 100 blocks;
 *   - the first memo landed (one block before its expiry) or never landed.
 *
 * A landed memo is invisible to the status node until that node's height
 * (finalized − lag) reaches the landing block, so the first pass past expiry
 * can read it absent. Ground truth as in the matrix above: landed ⇒ exactly
 * one send, row confirmed with the FIRST signature; never landed ⇒ exactly
 * two sends (one replacement, after genuine chain expiry), row confirmed with
 * the replacement.
 */
type ClockMode = "monotonic" | "jump-forward-200s" | "step-back-300s" | "two-processes-skew-240s";
type PassShape = "one-pass" | "two-passes";

const CLOCK_MODES: ClockMode[] = [
  "monotonic",
  "jump-forward-200s",
  "step-back-300s",
  "two-processes-skew-240s",
];
const PASS_SHAPES: PassShape[] = ["one-pass", "two-passes"];
const SMALL_ADVANCES = [0, 1, 2, 3, 5, 10];
const STATUS_LAGS = [0, 10, 100];
const SMALL_TICKS = 12;
const ORDINARY_TICKS = 10;
const ORDINARY_ADVANCE = 150;

describe("anchor broadcast reconciliation: clock × chain matrix", () => {
  let dbA: DatabaseDriver;
  let dbB: DatabaseDriver;
  let base = 0;
  let offset = 0;
  let cellNo = 0;
  const failures: string[] = [];
  let total = 0;

  beforeAll(async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(Date, "now").mockImplementation(() => base + offset);
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const file = join(mkdtempSync(join(tmpdir(), "anchor-clock-")), "relay.db");
    // Two relay processes over one database file: two connections, two clocks.
    dbA = (await openMotebitDatabase(file)).db;
    createAnchoringTables(dbA);
    dbB = (await openMotebitDatabase(file)).db;
    broadcasts.configureAnchorBroadcasts(dbA, { now: () => base + offset });
    broadcasts.configureAnchorBroadcasts(dbB, { now: () => base + offset + 240_000 });
  });

  afterAll(() => {
    vi.restoreAllMocks();
    const report = process.env.ANCHOR_CLOCK_MATRIX_REPORT;
    if (report) {
      writeFileSync(report, JSON.stringify({ total, failing: failures.length, failures }, null, 1));
    }
  });

  async function runCell(
    clockMode: ClockMode,
    shape: PassShape,
    advance: number,
    lag: number,
    landed: boolean,
  ): Promise<string | null> {
    const n = cellNo++;
    const batchId = `clock-${n}`;
    const root = (0x200000 + n).toString(16).padStart(64, "0");
    dbA
      .prepare(
        `INSERT INTO relay_anchor_batches (batch_id, relay_id, merkle_root, leaf_count, first_settled_at, last_settled_at, signature, status, created_at)
       VALUES (?, 'relay-test', ?, 1, 1, 1, 'sig', 'signed', 1000)`,
      )
      .run(batchId, root);

    const rpc = new FakeRpc();
    const proc = async (): Promise<SolanaMemoSubmitter> => {
      const s = memoSubmitterOn(rpc);
      await s.resolveNetwork();
      return s;
    };
    const a = await proc();
    const b = await proc();
    let sig1: string | undefined;
    let landAt = Infinity;
    rpc.onSend = (sig) => {
      if (sig1 === undefined) {
        sig1 = sig;
        // Lands one block before its blockhash expires (if it lands at all).
        landAt = rpc.height + rpc.lastValidSpan - 1;
      }
      return undefined;
    };
    let reconciling = false;
    rpc.onStatus = (sig) => {
      if (sig !== sig1) return undefined;
      if (!reconciling || !landed) return null;
      // The status node sees the chain `lag` blocks behind the finalized height.
      return rpc.height - lag >= landAt ? statusOf("LF") : null;
    };

    const observed = (): boolean => {
      const r = dbA
        .prepare(
          "SELECT expired_seen_height FROM relay_anchor_broadcasts WHERE stream = 'federation-settlement' AND subject = ?",
        )
        .get(batchId) as { expired_seen_height: number | null } | undefined;
      return r?.expired_seen_height != null;
    };

    base = 0;
    offset = 0;
    rpc.height = 10;
    await submitAnchorOnChain(dbA, batchId, a);
    const expiry = rpc.height + rpc.lastValidSpan;
    reconciling = true;
    rpc.height = expiry + 1; // the finalized height just passed the memo's expiry
    let stepped = false;
    const afterPass = (step: number): void => {
      rpc.height += step;
      if (!stepped && observed()) {
        stepped = true;
        if (clockMode === "jump-forward-200s") offset += 200_000;
        if (clockMode === "step-back-300s") offset -= 300_000;
      }
    };
    for (let k = 1; k <= SMALL_TICKS + ORDINARY_TICKS; k++) {
      const step = k <= SMALL_TICKS ? advance : ORDINARY_ADVANCE;
      base = k * TICK_MS;
      await submitAnchorOnChain(dbA, batchId, a);
      afterPass(step);
      if (shape === "two-passes") {
        base += 10;
        if (clockMode === "two-processes-skew-240s") await submitAnchorOnChain(dbB, batchId, b);
        else await submitAnchorOnChain(dbA, batchId, a);
        afterPass(step);
      }
    }

    const sends = rpc.sendsOf(root);
    const row = dbA
      .prepare("SELECT status, tx_hash FROM relay_anchor_batches WHERE batch_id = ?")
      .get(batchId) as { status: string; tx_hash: string | null };
    const cell = `${clockMode}/${shape}/+${advance}blk/lag=${lag}/${landed ? "landed" : "never-landed"}`;
    if (landed) {
      if (sends.length !== 1 || row.status !== "confirmed" || row.tx_hash !== sig1) {
        return `${cell}: landed first memo — sends=${sends.length}, status=${row.status}, confirmed with ${row.tx_hash === sig1 ? "first" : "another"} signature`;
      }
    } else {
      const replacement = sends[sends.length - 1];
      if (
        sends.length !== 2 ||
        replacement === sig1 ||
        row.status !== "confirmed" ||
        row.tx_hash !== replacement
      ) {
        return `${cell}: never-landed first memo — sends=${sends.length} (want 2), status=${row.status}`;
      }
    }
    return null;
  }

  for (const clockMode of CLOCK_MODES) {
    it(`clock ${clockMode}: every pass shape × chain advance × status lag × outcome`, async () => {
      const local: string[] = [];
      for (const shape of PASS_SHAPES) {
        if (clockMode === "two-processes-skew-240s" && shape === "one-pass") continue;
        for (const advance of SMALL_ADVANCES) {
          for (const lag of STATUS_LAGS) {
            for (const landed of [true, false]) {
              total++;
              const f = await runCell(clockMode, shape, advance, lag, landed);
              if (f) local.push(f);
            }
          }
        }
      }
      failures.push(...local);
      expect(local.slice(0, 3), `${local.length} failing cells`).toEqual([]);
    }, 120_000);
  }
});
