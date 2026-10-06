/**
 * Anchor-submit pacing harness (the staging 429 storm, 2026-10-05).
 *
 * Every anchoring stream shares one on-chain submitter. On each cycle the
 * relay used to retry its WHOLE backlog of signed-but-unsubmitted anchors at
 * once — ~47 full sign/submit paths in ~1-2 s. Against a rate-limited RPC that
 * is a 429 storm in which nothing lands and which repeats every cycle; against
 * an unfunded fee payer it is one guaranteed-failing RPC round trip per anchor,
 * every cycle, with no circuit.
 *
 * The contract pinned here: submissions are serial and capped per cycle; a
 * rate-limit / unavailability error stops the cycle and backs off across
 * cycles (exponential, jittered, bounded); a deterministic error that fails
 * every anchor (unfunded fee payer) stops the cycle after ONE attempt with ONE
 * warning; a healthy RPC still anchors everything, oldest first, exactly once.
 * The backoff is shared by every stream on the same submitter.
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
import { attemptTransparencyAnchor } from "../transparency.js";
import { createAnchoringTables, submitAnchorOnChain } from "../anchoring.js";
import {
  createCredentialAnchoringTables,
  submitCredentialAnchorOnChain,
} from "../credential-anchoring.js";
import { classifyAnchorSubmitError } from "../anchor-submit-pacing.js";

const BACKLOG = 50;
/** Upper bound on submit attempts one stream may make in one cycle. */
const PER_CYCLE_BOUND = 5;

const RATE_LIMITED = "failed to get recent blockhash: 429 Too Many Requests";
const UNFUNDED =
  "Simulation failed. Message: Transaction simulation failed: Attempt to debit an account but found no record of a prior credit.";

interface FakeRpc {
  submitter: ChainAnchorSubmitter & {
    submitTransparencyAnchor: (hashHex: string) => Promise<{ txHash: string }>;
    address: string;
  };
  /** Submit attempts that reached the (fake) RPC. */
  calls: () => number;
  /** Roots that landed, in landing order. */
  landed: string[];
}

/**
 * A fake RPC behind a ChainAnchorSubmitter. `fail(n)` decides, per attempt
 * (0-based), whether that attempt throws and with what message.
 */
function fakeRpc(fail: (attempt: number) => string | null): FakeRpc {
  let n = 0;
  const landed: string[] = [];
  const attempt = (label: string): { txHash: string } => {
    const i = n++;
    const msg = fail(i);
    if (msg) throw new Error(msg);
    landed.push(label);
    return { txHash: `tx-${i}` };
  };
  const submitter = {
    chain: "solana",
    network: "solana:devnet",
    address: "FakeRelayAddress1111111111111111111111111111",
    isAvailable: async () => true,
    submitMerkleRoot: async (root: string) => attempt(root),
    submitTransparencyAnchor: async (hash: string) => attempt(`transparency:${hash}`),
  };
  return { submitter, calls: () => n, landed };
}

describe("anchor-submit pacing", () => {
  let db: DatabaseDriver;
  let relayIdentity: RelayIdentity;
  let roots: string[];
  let stdout: string[];
  let now: number;

  beforeEach(async () => {
    now = 1_800_000_000_000;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    db = (await openMotebitDatabase(":memory:")).db;
    // No bindings: the tick only drains the backlog (cuts nothing new).
    db.exec("DROP TABLE IF EXISTS agent_registry");
    db.exec(
      "CREATE TABLE agent_registry (motebit_id TEXT PRIMARY KEY, public_key TEXT NOT NULL, registered_at INTEGER NOT NULL)",
    );
    db.exec("DROP TABLE IF EXISTS identity_keys");
    db.exec(
      "CREATE TABLE identity_keys (motebit_id TEXT PRIMARY KEY, public_key TEXT NOT NULL, guardian_public_key TEXT, source TEXT NOT NULL, first_seen INTEGER, updated_at INTEGER NOT NULL)",
    );
    db.exec(
      "CREATE TABLE IF NOT EXISTS devices (device_id TEXT PRIMARY KEY, motebit_id TEXT NOT NULL, device_token TEXT, public_key TEXT NOT NULL, registered_at INTEGER NOT NULL)",
    );
    db.exec(
      "CREATE TABLE IF NOT EXISTS relay_key_successions (id INTEGER PRIMARY KEY, motebit_id TEXT NOT NULL, old_public_key TEXT NOT NULL, new_public_key TEXT NOT NULL, timestamp INTEGER NOT NULL, reason TEXT, old_key_signature TEXT, new_key_signature TEXT NOT NULL, recovery INTEGER DEFAULT 0, guardian_signature TEXT)",
    );
    createIdentityLogAnchorTables(db);
    const kp = await generateKeypair();
    relayIdentity = {
      relayMotebitId: "relay-test",
      publicKey: kp.publicKey,
      privateKey: kp.privateKey,
      publicKeyHex: bytesToHex(kp.publicKey),
      did: "did:key:test",
    };

    // A backlog of signed-but-unsubmitted anchors, oldest first.
    roots = [];
    const insert = db.prepare(
      `INSERT INTO relay_identity_log_anchors
         (anchor_id, relay_id, merkle_root, leaf_count, signature, status, created_at)
       VALUES (?, 'relay-test', ?, 1, 'sig', 'signed', ?)`,
    );
    for (let i = 0; i < BACKLOG; i++) {
      const root = i.toString(16).padStart(64, "0");
      roots.push(root);
      // Ids deliberately NOT in created_at order, so ordering is by age.
      insert.run(`anchor-${(BACKLOG - i).toString().padStart(3, "0")}`, root, 1_000 + i);
    }

    stdout = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      stdout.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  function warnings(msgPattern: RegExp): number {
    return stdout.filter((l) => {
      try {
        const e = JSON.parse(l) as { level?: string; msg?: string };
        return e.level === "warn" && msgPattern.test(e.msg ?? "");
      } catch {
        return false;
      }
    }).length;
  }

  function confirmedCount(): number {
    return (
      db
        .prepare("SELECT COUNT(*) AS c FROM relay_identity_log_anchors WHERE status = 'confirmed'")
        .get() as { c: number }
    ).c;
  }

  function advance(ms: number): void {
    now += ms;
    vi.setSystemTime(now);
  }

  it("a 429 stops the cycle early and backs off across cycles (bounded calls, no storm)", async () => {
    // The RPC serves 2 submits, then rate-limits everything.
    const rpc = fakeRpc((i) => (i >= 2 ? RATE_LIMITED : null));

    await runIdentityLogAnchorTick(db, relayIdentity, { submitter: rpc.submitter });
    // 2 landed + the 1 attempt that hit the 429; the other 47 were NOT tried.
    expect(rpc.calls()).toBe(3);
    expect(rpc.calls()).toBeLessThanOrEqual(PER_CYCLE_BOUND);
    expect(confirmedCount()).toBe(2);
    expect(warnings(/rate_limited|backoff/)).toBe(1);

    // Next cycle (one minute later) is inside the backoff: zero RPC calls.
    advance(1_000);
    await runIdentityLogAnchorTick(db, relayIdentity, { submitter: rpc.submitter });
    expect(rpc.calls()).toBe(3);

    // Past the longest first backoff: exactly one probe, which 429s again and
    // backs off further (exponential) — still no storm.
    advance(10 * 60_000);
    await runIdentityLogAnchorTick(db, relayIdentity, { submitter: rpc.submitter });
    expect(rpc.calls()).toBe(4);
    // Exponential: the second backoff is ≥ 60 s (base 60 s, jittered into
    // [½·d, d], doubled) — 59 s later the RPC is still left alone.
    advance(59_000);
    await runIdentityLogAnchorTick(db, relayIdentity, { submitter: rpc.submitter });
    expect(rpc.calls()).toBe(4);

    // The backoff is bounded: a long outage still probes at least every 30 min.
    for (let k = 0; k < 20; k++) {
      advance(31 * 60_000);
      const before = rpc.calls();
      await runIdentityLogAnchorTick(db, relayIdentity, { submitter: rpc.submitter });
      expect(rpc.calls()).toBe(before + 1);
    }
    // Nothing was dropped: the un-landed anchors are all still signed, pending.
    expect(confirmedCount()).toBe(2);
  });

  it("the backoff is shared by every stream on the same submitter", async () => {
    const rpc = fakeRpc(() => RATE_LIMITED);
    await runIdentityLogAnchorTick(db, relayIdentity, { submitter: rpc.submitter });
    expect(rpc.calls()).toBe(1);

    // The transparency stream, same submitter, same cycle: deferred, no RPC call,
    // and it throws (not landed) so its supervised loop retries later.
    const state = { anchored: false };
    await expect(attemptTransparencyAnchor(state, relayIdentity, rpc.submitter)).rejects.toThrow();
    expect(state.anchored).toBe(false);
    expect(rpc.calls()).toBe(1);
  });

  it("settlement and credential batches are held by the same backoff (no RPC call, no per-batch warning)", async () => {
    createAnchoringTables(db);
    createCredentialAnchoringTables(db);
    db.prepare(
      `INSERT INTO relay_anchor_batches
         (batch_id, relay_id, merkle_root, leaf_count, first_settled_at, last_settled_at, signature, status, created_at)
       VALUES ('fed-1', 'relay-test', ?, 1, 1, 1, 'sig', 'signed', 1)`,
    ).run("a".repeat(64));
    db.prepare(
      `INSERT INTO relay_credential_anchor_batches
         (batch_id, relay_id, merkle_root, leaf_count, first_issued_at, last_issued_at, signature, status, created_at)
       VALUES ('cred-1', 'relay-test', ?, 1, 1, 1, 'sig', 'signed', 1)`,
    ).run("b".repeat(64));

    const rpc = fakeRpc(() => RATE_LIMITED);
    await runIdentityLogAnchorTick(db, relayIdentity, { submitter: rpc.submitter });
    expect(rpc.calls()).toBe(1);
    expect(warnings(/./)).toBe(1);

    expect(await submitAnchorOnChain(db, "fed-1", rpc.submitter)).toBe(false);
    expect(await submitCredentialAnchorOnChain(db, "cred-1", rpc.submitter)).toBe(false);
    expect(rpc.calls()).toBe(1);
    expect(warnings(/./)).toBe(1);
    // Still signed — retried on a later cycle, never dropped.
    const status = (t: string, id: string) =>
      (db.prepare(`SELECT status FROM ${t} WHERE batch_id = ?`).get(id) as { status: string })
        .status;
    expect(status("relay_anchor_batches", "fed-1")).toBe("signed");
    expect(status("relay_credential_anchor_batches", "cred-1")).toBe("signed");
  });

  it("classifies the observed RPC failures", () => {
    expect(classifyAnchorSubmitError(new Error(RATE_LIMITED))).toBe("rate_limited");
    expect(classifyAnchorSubmitError(new Error("429 Too Many Requests"))).toBe("rate_limited");
    expect(classifyAnchorSubmitError(new Error(UNFUNDED))).toBe("deterministic");
    expect(classifyAnchorSubmitError(new Error("TypeError: fetch failed"))).toBe("unavailable");
    expect(
      classifyAnchorSubmitError(new Error("failed to get recent blockhash: fetch failed")),
    ).toBe("unavailable");
    // The network-id read heals on its own supervised retry (rule 27) — never a backoff.
    expect(
      classifyAnchorSubmitError(
        new Error("SolanaMemoSubmitter refuses to write: the RPC's network is unknown (HTTP 503)"),
      ),
    ).toBe("other");
    // SolanaMemoSubmitter's network-label mismatch fails every anchor until an operator acts.
    expect(
      classifyAnchorSubmitError(
        new Error(
          "SolanaMemoSubmitter refuses to write: declared network solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1 but the RPC serves solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
        ),
      ),
    ).toBe("deterministic");
    expect(
      classifyAnchorSubmitError(
        new Error("Transaction was not confirmed in 30.00 seconds. It is unknown if it succeeded"),
      ),
    ).toBe("other");
  });

  it("an unfunded fee payer: ≤1 submit attempt per cycle and ONE warning", async () => {
    const rpc = fakeRpc(() => UNFUNDED);

    await runIdentityLogAnchorTick(db, relayIdentity, { submitter: rpc.submitter });
    expect(rpc.calls()).toBe(1);
    expect(warnings(/./)).toBe(1);

    // Retried next cycle — again a single attempt, a single warning.
    advance(60_000);
    await runIdentityLogAnchorTick(db, relayIdentity, { submitter: rpc.submitter });
    expect(rpc.calls()).toBe(2);
    expect(warnings(/./)).toBe(2);
    expect(confirmedCount()).toBe(0);
  });

  it("a healthy RPC anchors the whole backlog, in order, exactly once (paced per cycle)", async () => {
    const rpc = fakeRpc(() => null);
    let cycles = 0;
    while (confirmedCount() < BACKLOG && cycles < 100) {
      const before = rpc.calls();
      await runIdentityLogAnchorTick(db, relayIdentity, { submitter: rpc.submitter });
      expect(rpc.calls() - before).toBeLessThanOrEqual(PER_CYCLE_BOUND);
      advance(60_000);
      cycles++;
    }
    expect(confirmedCount()).toBe(BACKLOG);
    expect(rpc.landed).toEqual(roots); // oldest first, no duplicates, none missing
    expect(rpc.calls()).toBe(BACKLOG);
    expect(warnings(/./)).toBe(0);
  });
});
