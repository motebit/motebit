/**
 * Anchor-submit exactly-once harness (overlapping ticks on a slow RPC).
 *
 * The pacer serializes every anchoring stream through one chain. A stream's
 * tick reads its `status = 'signed'` backlog, then waits its turn in that
 * chain. `superviseInterval` does not stop a new tick while the previous one is
 * still draining, so once queued work across streams exceeds one tick the next
 * tick re-reads rows that are still waiting (or in flight) and enqueues them
 * again. Without an executor-side check every re-enqueued copy runs after the
 * first landed — a second onchain memo for the same root.
 *
 * The contract pinned here: however ticks overlap, every signed root reaches
 * the RPC EXACTLY once. Ticks are driven the way the loops drive them — fired
 * on an interval, never awaited by the next one — through the real exported
 * submit functions, the real `drainAnchorBacklog`, and the real identity-log
 * tick.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { generateKeypair, bytesToHex } from "@motebit/crypto";
import { openMotebitDatabase, type DatabaseDriver } from "@motebit/persistence";
import type { ChainAnchorSubmitter } from "@motebit/sdk";
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

const TICK_MS = 1_000;

interface Stream {
  name: string;
  table: string;
  idCol: string;
  submit: (db: DatabaseDriver, id: string, s: ChainAnchorSubmitter) => Promise<boolean>;
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

/** A fake RPC whose every submit takes `latencyMs`; records each root that reached it. */
function slowRpc(latencyMs: number): { submitter: ChainAnchorSubmitter; calls: string[] } {
  const calls: string[] = [];
  const submitter: ChainAnchorSubmitter = {
    chain: "solana",
    network: "solana:devnet",
    isAvailable: async () => true,
    submitMerkleRoot: async (root: string) => {
      calls.push(root);
      await new Promise((r) => setTimeout(r, latencyMs));
      return { txHash: `tx-${calls.length}` };
    },
  };
  return { submitter, calls };
}

describe("anchor submission is exactly-once under overlapping ticks", () => {
  let db: DatabaseDriver;
  let relayIdentity: RelayIdentity;
  let roots: string[];

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(1_800_000_000_000);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    db = (await openMotebitDatabase(":memory:")).db;
    // Empty identity sources: the identity-log tick only drains its backlog.
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
    // Created by a relay migration in production; the columns the submit path reads.
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
    roots = [];
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  /** Seed `perStream` signed-but-unsubmitted anchors in each of the four streams. */
  function seed(perStream: number, identityLog = perStream): void {
    let k = 0;
    const root = (): string => {
      const r = (k++).toString(16).padStart(64, "0");
      roots.push(r);
      return r;
    };
    for (const s of STREAMS) {
      const extra =
        s.name === "cred" ? "first_issued_at, last_issued_at" : "first_settled_at, last_settled_at";
      const ins = db.prepare(
        `INSERT INTO ${s.table} (batch_id, relay_id, merkle_root, leaf_count, ${extra}, signature, status, created_at)
         VALUES (?, 'relay-test', ?, 1, 1, 1, 'sig', 'signed', ?)`,
      );
      for (let i = 0; i < perStream; i++) ins.run(`${s.name}-${i}`, root(), 1_000 + i);
    }
    const ins = db.prepare(
      `INSERT INTO relay_identity_log_anchors
         (anchor_id, relay_id, merkle_root, leaf_count, signature, status, created_at)
       VALUES (?, 'relay-test', ?, 1, 'sig', 'signed', ?)`,
    );
    for (let i = 0; i < identityLog; i++) ins.run(`idlog-${i}`, root(), 1_000 + i);
  }

  function pending(): number {
    let n = 0;
    for (const t of [...STREAMS.map((s) => s.table), "relay_identity_log_anchors"]) {
      n += (
        db.prepare(`SELECT COUNT(*) AS c FROM ${t} WHERE status = 'signed'`).get() as { c: number }
      ).c;
    }
    return n;
  }

  /** One stream's tick, as its loop runs it: read the signed backlog, drain it paced. */
  async function streamTick(s: Stream, submitter: ChainAnchorSubmitter): Promise<void> {
    const ids = (
      db
        .prepare(
          `SELECT ${s.idCol} AS id FROM ${s.table} WHERE status = 'signed' AND tx_hash IS NULL ORDER BY created_at ASC, rowid ASC`,
        )
        .all() as { id: string }[]
    ).map((r) => r.id);
    await drainAnchorBacklog(submitter, ids, (id) => s.submit(db, id, submitter));
  }

  /**
   * Fire every stream's tick each TICK_MS without awaiting the previous one
   * (superviseInterval's shape), until the backlog is gone and every in-flight
   * submit has settled. Returns the per-root RPC call counts.
   */
  async function runOverlappingTicks(latencyMs: number): Promise<Map<string, number>> {
    const rpc = slowRpc(latencyMs);
    const inflight: Promise<unknown>[] = [];
    for (let tick = 0; tick < 200 && pending() > 0; tick++) {
      for (const s of STREAMS) inflight.push(streamTick(s, rpc.submitter));
      inflight.push(runIdentityLogAnchorTick(db, relayIdentity, { submitter: rpc.submitter }));
      await vi.advanceTimersByTimeAsync(TICK_MS);
    }
    // Let everything already enqueued run to completion.
    for (let i = 0; i < 30; i++) await vi.advanceTimersByTimeAsync(10 * TICK_MS);
    await Promise.all(inflight);
    expect(pending()).toBe(0);
    const counts = new Map<string, number>();
    for (const r of rpc.calls) counts.set(r, (counts.get(r) ?? 0) + 1);
    return counts;
  }

  function expectExactlyOnce(counts: Map<string, number>): void {
    const dups = [...counts].filter(([, c]) => c > 1);
    expect({ total: [...counts.values()].reduce((a, b) => a + b, 0), dups }).toEqual({
      total: roots.length,
      dups: [],
    });
    expect([...counts.keys()].sort()).toEqual([...roots].sort());
  }

  it.each([
    { perStream: 1, latencyMs: 400 },
    { perStream: 2, latencyMs: 400 },
    { perStream: 5, latencyMs: 80 },
  ])(
    "every root lands once: $perStream/stream, RPC latency $latencyMs ms, ticks every 1 s",
    async ({ perStream, latencyMs }) => {
      seed(perStream);
      expectExactlyOnce(await runOverlappingTicks(latencyMs));
    },
  );

  it("a 47-anchor identity-log backlog beside the other streams lands each root once", async () => {
    seed(3, 47);
    expectExactlyOnce(await runOverlappingTicks(400));
  }, 60_000);

  it("two concurrent drains of one stream submit each root once", async () => {
    seed(5);
    const rpc = slowRpc(200);
    const fed = STREAMS[0]!;
    const both = Promise.all([streamTick(fed, rpc.submitter), streamTick(fed, rpc.submitter)]);
    await vi.advanceTimersByTimeAsync(60_000);
    await both;
    const fedRoots = roots.slice(0, 5);
    expect(rpc.calls).toEqual(fedRoots);
  });

  it("a direct call for a row that landed while it waited makes no RPC call", async () => {
    seed(1);
    const rpc = slowRpc(200);
    const first = submitAnchorOnChain(db, "fed-0", rpc.submitter);
    const second = submitAnchorOnChain(db, "fed-0", rpc.submitter);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await first).toBe(true);
    expect(await second).toBe(true);
    expect(rpc.calls).toEqual([roots[0]]);
  });

  it("overlapping transparency attempts anchor the declaration once", async () => {
    const calls: string[] = [];
    let land: () => void = () => {};
    const landed = new Promise<void>((r) => (land = r));
    const submitter = {
      submitTransparencyAnchor: async (hash: string) => {
        calls.push(hash);
        await landed; // the RPC is slow: both attempts are issued before it answers
        return { txHash: "tx-t" };
      },
    };
    const state = { anchored: false };
    const a = attemptTransparencyAnchor(state, relayIdentity, submitter);
    const b = attemptTransparencyAnchor(state, relayIdentity, submitter);
    await vi.waitFor(() => expect(calls).toHaveLength(1), { timeout: 5_000 });
    land();
    await Promise.all([a, b]);
    expect(await attemptTransparencyAnchor(state, relayIdentity, submitter)).toBeNull();
    expect(calls).toHaveLength(1);
  });
});
