/**
 * #949 / #945 unit edges the payout harness does not isolate:
 *
 *   - `readChainVerdict` over several recorded attempts (#949 round 5): one
 *     landed anywhere ⇒ paid; every one POSITIVELY dead (found failed, or
 *     dead by the fresh verdict) ⇒ not paid; a history read's absence
 *     (`expired`) is never dead; the fresh verdict is recorded durably at
 *     the moment it is read and a positive one is final; a window that
 *     closed with nothing recorded is `no_positive_evidence`; a read that
 *     throws is an rpc_error, never absence; the sweep records verdicts for
 *     processing, chain-recorded payouts only.
 *   - batch: a terminal write that loses its `firing` CAS writes no door;
 *     a row this process is still firing is never "recovered" as stale;
 *     a stale row whose rail is no longer registered is parked on the
 *     conservative (sent, 24h) door; the loop tick rethrows so the
 *     supervisor records a failed tick.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import type { GuestRail, WithdrawalResult } from "@motebit/sdk";
import {
  OperatorSolanaTransfer,
  type FreshSignatureVerdict,
  type SignatureOutcome,
  type SignedTransactionRef,
} from "@motebit/wallet-solana";
import type { DatabaseDriver } from "@motebit/persistence";

import type { SyncRelay } from "../index.js";
import { creditAccount } from "../accounts.js";
import {
  enqueuePendingWithdrawal,
  evaluateAndFireRail,
  recoverStaleFiring,
  runBatchWithdrawalTick,
  startBatchWithdrawalLoop,
  type BatchWithdrawalConfig,
} from "../batch-withdrawals.js";
import {
  getPayoutAttempts,
  markChainRecordedClaim,
  readChainVerdict,
  recordPayoutAttempt,
  runFreshVerdictSweep,
} from "../withdrawal-chain-payouts.js";
import { UNDECLARED_PAYOUT_HORIZON_MS } from "../payout-horizon.js";
import { LoopSupervisor } from "../loop-supervisor.js";
import { AUTH_HEADER, createTestRelay } from "./test-helpers.js";

let relay: SyncRelay | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  await relay?.close();
  relay = undefined;
});

async function db(): Promise<DatabaseDriver> {
  relay = await createTestRelay({ enableDeviceAuth: false });
  return relay.moteDb.db;
}

/**
 * A reader over per-signature HISTORY outcomes and FRESH verdicts. Unlisted
 * signatures: history `pending`, fresh `too_early`.
 */
function reader(
  outcomes: Record<string, SignatureOutcome | Error>,
  fresh: Record<string, FreshSignatureVerdict | Error> = {},
) {
  const calls: string[] = [];
  const freshCalls: string[] = [];
  return {
    calls,
    freshCalls,
    getSignatureOutcome(tx: SignedTransactionRef): Promise<SignatureOutcome> {
      calls.push(tx.signature);
      const o = outcomes[tx.signature];
      if (o instanceof Error) return Promise.reject(o);
      return Promise.resolve(o ?? { status: "pending" });
    },
    getFreshSignatureVerdict(tx: SignedTransactionRef): Promise<FreshSignatureVerdict> {
      freshCalls.push(tx.signature);
      const f = fresh[tx.signature];
      if (f instanceof Error) return Promise.reject(f);
      return Promise.resolve(f ?? { status: "too_early" });
    },
  };
}

const DEAD: FreshSignatureVerdict = { status: "dead_fresh", contextSlot: 9_000 };
const PASSED: FreshSignatureVerdict = { status: "window_passed" };

function attempt(d: DatabaseDriver, w: string, signature: string, lastValid: number, at: number) {
  recordPayoutAttempt(d, w, { signature, lastValidBlockHeight: lastValid }, at);
}

describe("readChainVerdict (#949 round 5: positive evidence only)", () => {
  it("no recorded attempt ⇒ not paid (nothing was ever broadcast), without a chain read", async () => {
    const d = await db();
    const r = reader({});
    expect(await readChainVerdict(d, "w-none", r)).toEqual({ kind: "not_paid", attempts: 0 });
    expect(r.calls).toEqual([]);
    expect(r.freshCalls).toEqual([]);
  });

  it("a landed attempt anywhere ⇒ paid by that signature, even beside a dead one", async () => {
    const d = await db();
    attempt(d, "w1", "a", 10, 1);
    attempt(d, "w1", "b", 20, 2);
    const v = await readChainVerdict(
      d,
      "w1",
      reader({ a: { status: "expired" }, b: { status: "landed", slot: 7 } }, { a: DEAD }),
    );
    expect(v).toMatchObject({ kind: "paid", signature: "b", slot: 7, landed: ["b"] });
  });

  it("two landed attempts are both reported (the relay paid twice — logged by the door)", async () => {
    const d = await db();
    attempt(d, "w2", "a", 10, 1);
    attempt(d, "w2", "b", 20, 2);
    const v = await readChainVerdict(
      d,
      "w2",
      reader({ a: { status: "landed", slot: 1 }, b: { status: "landed", slot: 2 } }),
    );
    expect(v).toMatchObject({ kind: "paid", signature: "a", landed: ["a", "b"] });
  });

  it("a history absence (`expired`) is NEVER dead: without a fresh verdict it stays undecided", async () => {
    const d = await db();
    attempt(d, "wx", "a", 10, 1);
    expect(await readChainVerdict(d, "wx", reader({ a: { status: "expired" } }))).toMatchObject({
      kind: "undecided",
      reason: "pending",
      signature: "a",
    });
    expect(
      await readChainVerdict(d, "wx", reader({ a: { status: "expired" } }, { a: PASSED })),
    ).toMatchObject({ kind: "undecided", reason: "no_positive_evidence", signature: "a" });
    expect(getPayoutAttempts(d, "wx")[0]!.fresh_verdict).toBe("window_passed");
  });

  it("found failed, or dead by the fresh verdict ⇒ not paid; one pending ⇒ undecided; a throwing read ⇒ rpc_error", async () => {
    const d = await db();
    attempt(d, "w3", "a", 10, 1);
    attempt(d, "w3", "b", 20, 2);
    expect(
      await readChainVerdict(
        d,
        "w3",
        reader({ a: { status: "failed" }, b: { status: "pending" } }),
      ),
    ).toMatchObject({
      kind: "undecided",
      reason: "pending",
      signature: "b",
      lastValidBlockHeight: 20,
    });
    expect(
      await readChainVerdict(d, "w3", reader({ b: new Error("socket") }, { b: new Error("503") })),
    ).toMatchObject({ kind: "undecided", reason: "rpc_error", signature: "b", detail: "503" });
    expect(
      await readChainVerdict(d, "w3", reader({ b: { status: "expired" } }, { b: DEAD })),
    ).toEqual({ kind: "not_paid", attempts: 2 });
  });

  it("the fresh verdict is recorded at the moment it is read, and a positive one is final", async () => {
    const d = await db();
    attempt(d, "wf", "a", 10, 1);
    expect(await readChainVerdict(d, "wf", reader({}, { a: DEAD }))).toEqual({
      kind: "not_paid",
      attempts: 1,
    });
    const rec = getPayoutAttempts(d, "wf")[0]!;
    expect(rec.fresh_verdict).toBe("dead_fresh");
    expect(rec.fresh_context_slot).toBe(9_000);
    // Later the window has passed and history shows nothing: the recorded
    // evidence still decides it, with no chain read at all.
    const later = reader({ a: { status: "expired" } }, { a: PASSED });
    expect(await readChainVerdict(d, "wf", later)).toEqual({ kind: "not_paid", attempts: 1 });
    expect(later.calls).toEqual([]);
    expect(later.freshCalls).toEqual([]);
  });

  it("a found landed status is recorded too, so a pruned history later still reads paid", async () => {
    const d = await db();
    attempt(d, "wl", "a", 10, 1);
    await readChainVerdict(d, "wl", reader({ a: { status: "landed", slot: 5 } }));
    expect(getPayoutAttempts(d, "wl")[0]).toMatchObject({
      fresh_verdict: "landed",
      fresh_landed_slot: 5,
    });
    expect(
      await readChainVerdict(d, "wl", reader({ a: { status: "expired" } }, { a: PASSED })),
    ).toMatchObject({ kind: "paid", signature: "a", slot: 5 });
  });

  it("seen-in-a-block is persisted; the fresh verdict (finalized, whole landing range) still decides it", async () => {
    const d = await db();
    attempt(d, "w4", "a", 10, 1);
    expect(
      await readChainVerdict(d, "w4", reader({ a: { status: "pending", seen: true } })),
    ).toMatchObject({ kind: "undecided", reason: "pending" });
    expect(getPayoutAttempts(d, "w4")[0]!.seen_in_block).toBe(1);
    expect(
      await readChainVerdict(d, "w4", reader({ a: { status: "landed", slot: 3 } })),
    ).toMatchObject({ kind: "paid", signature: "a" });
  });

  it("window_passed yields to a later found status, never the other way", async () => {
    const d = await db();
    attempt(d, "wp", "a", 10, 1);
    await readChainVerdict(d, "wp", reader({}, { a: PASSED }));
    expect(getPayoutAttempts(d, "wp")[0]!.fresh_verdict).toBe("window_passed");
    expect(await readChainVerdict(d, "wp", reader({ a: { status: "failed" } }))).toEqual({
      kind: "not_paid",
      attempts: 1,
    });
    expect(getPayoutAttempts(d, "wp")[0]!.fresh_verdict).toBe("failed");
  });

  it("precedence: pending beats rpc_error beats no_positive_evidence", async () => {
    const d = await db();
    attempt(d, "wq", "a", 10, 1);
    attempt(d, "wq", "b", 20, 2);
    attempt(d, "wq", "c", 30, 3);
    expect(
      await readChainVerdict(
        d,
        "wq",
        reader({}, { a: PASSED, b: new Error("x"), c: { status: "too_early" } }),
      ),
    ).toMatchObject({ reason: "pending", signature: "c" });
    expect(
      await readChainVerdict(d, "wq", reader({ c: { status: "failed" } }, { b: new Error("x") })),
    ).toMatchObject({ reason: "rpc_error", signature: "b" });
  });

  it("re-recording the same signature is a no-op (a re-sign over the same blockhash is the same transaction)", async () => {
    const d = await db();
    attempt(d, "w5", "a", 10, 1);
    attempt(d, "w5", "a", 10, 2);
    expect(getPayoutAttempts(d, "w5")).toHaveLength(1);
  });
});

describe("runFreshVerdictSweep (#949 round 5)", () => {
  function processingWithdrawal(d: DatabaseDriver, mid: string, chainRecorded: boolean): string {
    creditAccount(d, mid, 5_000_000, "deposit", `${mid}-dep`, "seed");
    const id = `wd-${mid}`;
    d.prepare(
      `INSERT INTO relay_withdrawals (withdrawal_id, motebit_id, amount, currency, destination, status, requested_at, claimed_at)
       VALUES (?, ?, 1000000, 'USDC', 'GJmrQzyZumWWkdBuVH3Z1hnGvjrcDMbx7ptF5t5UAAAA', 'processing', ?, ?)`,
    ).run(id, mid, Date.now(), Date.now());
    if (chainRecorded) markChainRecordedClaim(d, id, "solana", Date.now());
    return id;
  }

  it("records the fresh verdict for each undecided attempt of a processing, chain-recorded payout — and settles nothing", async () => {
    const d = await db();
    const id = processingWithdrawal(d, "zzs-a", true);
    attempt(d, id, "a", 10, 1);
    attempt(d, id, "b", 20, 2);
    const r = reader({}, { a: DEAD, b: { status: "too_early" } });
    expect(await runFreshVerdictSweep(d, r)).toBe(2);
    const [a, b] = getPayoutAttempts(d, id);
    expect(a!.fresh_verdict).toBe("dead_fresh");
    expect(b!.fresh_verdict).toBeNull();
    const row = d
      .prepare("SELECT status FROM relay_withdrawals WHERE withdrawal_id = ?")
      .get(id) as {
      status: string;
    };
    expect(row.status).toBe("processing");
    // A recorded attempt is not read again.
    const r2 = reader({}, { b: DEAD });
    expect(await runFreshVerdictSweep(d, r2)).toBe(1);
    expect(r2.freshCalls).toEqual(["b"]);
  });

  it("never reads attempts of an unrecorded claim or a settled withdrawal", async () => {
    const d = await db();
    const legacy = processingWithdrawal(d, "zzs-l", false);
    attempt(d, legacy, "a", 10, 1);
    const done = processingWithdrawal(d, "zzs-d", true);
    attempt(d, done, "b", 10, 1);
    d.prepare("UPDATE relay_withdrawals SET status = 'completed' WHERE withdrawal_id = ?").run(
      done,
    );
    const r = reader({}, { a: DEAD, b: DEAD });
    expect(await runFreshVerdictSweep(d, r)).toBe(0);
    expect(r.freshCalls).toEqual([]);
  });

  it("the relay starts the sweep, supervised, whenever it has a Solana transfer (activation, not just definition)", async () => {
    const transfer = new OperatorSolanaTransfer({
      honorsBroadcastHooks: true,
      ownAddress: "RelayTreasuryAddressBase58",
      getUsdcBalance: () => Promise.resolve(0n),
      getUsdcBalanceOf: () => Promise.resolve(0n),
      getSolBalance: () => Promise.resolve(0n),
      sendUsdc: () => Promise.reject(new Error("unused")),
      sendUsdcBatch: () => Promise.resolve([]),
      getTransaction: () => Promise.resolve({ status: "not_found" as const }),
      getSignatureOutcome: () => Promise.resolve({ status: "pending" as const }),
      getFreshSignatureVerdict: () => Promise.resolve({ status: "too_early" as const }),
      isReachable: () => Promise.resolve(true),
    });
    relay = await createTestRelay({ enableDeviceAuth: false, operatorSolanaTransfer: transfer });
    const res = await relay.app.request("/api/v1/admin/health", { headers: AUTH_HEADER });
    const health = (await res.json()) as { loops: Array<{ name: string }> };
    expect(health.loops.map((l) => l.name)).toContain("withdrawal-fresh-verdict");
  });

  it("a read that throws records nothing and the attempt is retried next pass", async () => {
    const d = await db();
    const id = processingWithdrawal(d, "zzs-e", true);
    attempt(d, id, "a", 10, 1);
    await runFreshVerdictSweep(d, reader({}, { a: new Error("down") }));
    expect(getPayoutAttempts(d, id)[0]!.fresh_verdict).toBeNull();
    await runFreshVerdictSweep(d, reader({}, { a: DEAD }));
    expect(getPayoutAttempts(d, id)[0]!.fresh_verdict).toBe("dead_fresh");
  });
});

// ── batch (#945) ─────────────────────────────────────────────────────────

const FIRE_NOW = {
  policy: { minAggregateMicro: 0, feeJustificationMultiplier: 1, maxAgeMs: 0 },
} as unknown as BatchWithdrawalConfig;

function sentRail(name: string, withdraw: () => Promise<WithdrawalResult>) {
  return {
    name,
    railType: "protocol" as const,
    custody: "relay" as const,
    supportsDeposit: false as const,
    supportsWithdraw: true as const,
    supportsBatch: false,
    isAvailable: () => Promise.resolve(true),
    attachProof: () => Promise.resolve(),
    withdraw: vi.fn(withdraw),
  };
}

function enqueue(d: DatabaseDriver, mid: string, rail: string): string {
  creditAccount(d, mid, 5_000_000, "deposit", `${mid}-dep`, "seed");
  return enqueuePendingWithdrawal(d, {
    motebitId: mid,
    amountMicro: 1_000_000,
    destination: "GJmrQzyZumWWkdBuVH3Z1hnGvjrcDMbx7ptF5t5UAAAA",
    rail,
    source: "user",
  })!;
}

function queueRow(d: DatabaseDriver, id: string) {
  return d
    .prepare(
      "SELECT status, withdrawal_id, last_error FROM relay_pending_withdrawals WHERE pending_id = ?",
    )
    .get(id) as { status: string; withdrawal_id: string | null; last_error: string | null };
}

function withdrawalCount(d: DatabaseDriver, mid: string): number {
  return (
    d.prepare("SELECT COUNT(*) AS n FROM relay_withdrawals WHERE motebit_id = ?").get(mid) as {
      n: number;
    }
  ).n;
}

describe("batch settle doors (#945)", () => {
  it("a terminal write that loses its firing CAS writes no withdrawal row (logged, never a second door)", async () => {
    const d = await db();
    const id = enqueue(d, "zz945-lost", "zz945-rail");
    // While the rail call is in flight, another actor moves the queue row.
    const rail = sentRail("zz945-rail", () => {
      d.prepare(
        "UPDATE relay_pending_withdrawals SET status = 'cancelled' WHERE pending_id = ?",
      ).run(id);
      return Promise.resolve({
        amount: 1,
        currency: "USDC",
        proof: { reference: "r", railType: "protocol", confirmedAt: 0 },
      });
    });
    await evaluateAndFireRail(
      d,
      rail as unknown as Parameters<typeof evaluateAndFireRail>[1],
      FIRE_NOW,
    );
    expect(queueRow(d, id).status).toBe("cancelled");
    expect(withdrawalCount(d, "zz945-lost")).toBe(0);
  });

  it("a failed fire that loses its firing CAS writes no withdrawal row either (the markFailed CAS)", async () => {
    const d = await db();
    const id = enqueue(d, "zz945-lost-fail", "zz945-rail-f");
    // While the rail call is in flight, another actor moves the queue row;
    // then the rail throws.
    const rail = sentRail("zz945-rail-f", () => {
      d.prepare(
        "UPDATE relay_pending_withdrawals SET status = 'cancelled' WHERE pending_id = ?",
      ).run(id);
      return Promise.reject(new Error("provider 502"));
    });
    await evaluateAndFireRail(
      d,
      rail as unknown as Parameters<typeof evaluateAndFireRail>[1],
      FIRE_NOW,
    );
    expect(queueRow(d, id).status).toBe("cancelled");
    expect(withdrawalCount(d, "zz945-lost-fail")).toBe(0);
  });

  it("a row this process is still firing is never recovered as stale, however long the call takes", async () => {
    const d = await db();
    const id = enqueue(d, "zz945-slow", "zz945-slow-rail");
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const rail = sentRail("zz945-slow-rail", async () => {
      await gate;
      return {
        amount: 1,
        currency: "USDC",
        proof: { reference: "r", railType: "protocol", confirmedAt: 0 },
      };
    });
    const firing = evaluateAndFireRail(
      d,
      rail as unknown as Parameters<typeof evaluateAndFireRail>[1],
      FIRE_NOW,
    );
    // The fire is in flight; its claim is ten minutes "old".
    await vi.waitFor(() => expect(rail.withdraw).toHaveBeenCalledTimes(1));
    d.prepare("UPDATE relay_pending_withdrawals SET last_attempt_at = ? WHERE pending_id = ?").run(
      Date.now() - 10 * 60 * 1000,
      id,
    );
    expect(
      recoverStaleFiring(d, [rail as unknown as Parameters<typeof recoverStaleFiring>[1][0]]),
    ).toBe(0);
    expect(withdrawalCount(d, "zz945-slow")).toBe(0);
    release();
    await firing;
    expect(queueRow(d, id).status).toBe("fired");
    expect(withdrawalCount(d, "zz945-slow")).toBe(1);
  });

  it("a stale row whose rail is no longer registered is parked processing on the conservative 24h horizon", async () => {
    const d = await db();
    const id = enqueue(d, "zz945-orphan", "zz945-gone-rail");
    const firedAt = Date.now() - 10 * 60 * 1000;
    d.prepare(
      "UPDATE relay_pending_withdrawals SET status = 'firing', last_attempt_at = ? WHERE pending_id = ?",
    ).run(firedAt, id);
    const before = Date.now();
    expect(recoverStaleFiring(d, [])).toBe(1);
    const q = queueRow(d, id);
    expect(q.status).toBe("failed");
    const w = d
      .prepare(
        "SELECT status, claimed_at, payout_valid_until, failure_reason FROM relay_withdrawals WHERE withdrawal_id = ?",
      )
      .get(q.withdrawal_id) as {
      status: string;
      claimed_at: number;
      payout_valid_until: number;
      failure_reason: string;
    };
    expect(w.status).toBe("processing");
    // Counted from the recovery, never the old claim: every call the dead
    // process made happened before now.
    expect(w.claimed_at).toBeGreaterThanOrEqual(before);
    expect(w.payout_valid_until).toBeGreaterThanOrEqual(before + UNDECLARED_PAYOUT_HORIZON_MS);
    expect(w.failure_reason).toMatch(/unresolved payout/);
    // A second recovery finds nothing.
    expect(recoverStaleFiring(d, [])).toBe(0);
  });

  it("runBatchWithdrawalTick skips non-withdrawable rails and recovers before it fires", async () => {
    const d = await db();
    const id = enqueue(d, "zz945-tick", "zz945-tick-rail");
    d.prepare(
      "UPDATE relay_pending_withdrawals SET status = 'firing', last_attempt_at = ? WHERE pending_id = ?",
    ).run(Date.now() - 10 * 60 * 1000, id);
    const rail = sentRail("zz945-tick-rail", () =>
      Promise.resolve({
        amount: 1,
        currency: "USDC",
        proof: { reference: "r", railType: "protocol", confirmedAt: 1 },
      }),
    );
    const notWithdrawable = { ...rail, name: "zz945-nw", supportsWithdraw: false as const };
    await runBatchWithdrawalTick(
      d,
      [rail as unknown as GuestRail, notWithdrawable as unknown as GuestRail],
      FIRE_NOW,
    );
    expect(rail.withdraw).not.toHaveBeenCalled(); // recovered, never re-fired
    expect(queueRow(d, id).status).toBe("failed");
    expect(withdrawalCount(d, "zz945-tick")).toBe(1);
  });

  it("a failing tick is rethrown to the supervisor (recorded as an error, not swallowed)", async () => {
    const d = await db();
    const broken = {
      ...d,
      prepare: () => {
        throw new Error("database is locked");
      },
      transaction: d.transaction.bind(d),
    } as unknown as DatabaseDriver;
    const supervisor = new LoopSupervisor();
    const handle = startBatchWithdrawalLoop(broken, [], { intervalMs: 5 }, () => false, supervisor);
    try {
      await vi.waitFor(() => {
        const loop = supervisor.snapshot().find((l) => l.name === "batch-withdrawal")!;
        expect(loop.error_count).toBeGreaterThan(0);
        expect(loop.last_error).toMatch(/database is locked/);
      });
    } finally {
      clearInterval(handle);
    }
  });
});
