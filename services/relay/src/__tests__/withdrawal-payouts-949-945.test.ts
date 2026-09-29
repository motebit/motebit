/**
 * #949 / #945 unit edges the payout harness does not isolate:
 *
 *   - `readChainVerdict` over several recorded attempts: one landed anywhere
 *     ⇒ paid; every one failed or expired ⇒ not paid; anything still able to
 *     land or unreadable ⇒ undecided; `seen` is sticky and persisted, so a
 *     later "expired" read for a transaction some node saw in a block is not
 *     trusted (#885 round 5); a read that throws is an rpc_error, never
 *     absence.
 *   - batch: a terminal write that loses its `firing` CAS writes no door;
 *     a row this process is still firing is never "recovered" as stale;
 *     a stale row whose rail is no longer registered is parked on the
 *     conservative (sent, 24h) door; the loop tick rethrows so the
 *     supervisor records a failed tick.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import type { GuestRail, WithdrawalResult } from "@motebit/sdk";
import type { SignatureOutcome, SignedTransactionRef } from "@motebit/wallet-solana";
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
  readChainVerdict,
  recordPayoutAttempt,
} from "../withdrawal-chain-payouts.js";
import { UNDECLARED_PAYOUT_HORIZON_MS } from "../payout-horizon.js";
import { LoopSupervisor } from "../loop-supervisor.js";
import { createTestRelay } from "./test-helpers.js";

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

/** Recorded attempts carry the slot read before signing; the node holds history from `firstAvailable`. */
const RECENT = 1_000_000;

function reader(
  outcomes: Record<string, SignatureOutcome | Error>,
  firstAvailable: number | Error = 0,
) {
  const calls: string[] = [];
  return {
    calls,
    getSignatureOutcome(tx: SignedTransactionRef): Promise<SignatureOutcome> {
      calls.push(tx.signature);
      const o = outcomes[tx.signature];
      if (o instanceof Error) return Promise.reject(o);
      return Promise.resolve(o ?? { status: "pending" });
    },
    getLocalLedgerFirstSlot(): Promise<number> {
      return firstAvailable instanceof Error
        ? Promise.reject(firstAvailable)
        : Promise.resolve(firstAvailable);
    },
  };
}

describe("readChainVerdict (#949)", () => {
  it("no recorded attempt ⇒ not paid (nothing was ever broadcast), without a chain read", async () => {
    const d = await db();
    const r = reader({});
    expect(await readChainVerdict(d, "w-none", r)).toEqual({ kind: "not_paid", attempts: 0 });
    expect(r.calls).toEqual([]);
  });

  it("a landed attempt anywhere ⇒ paid by that signature, even after an expired one", async () => {
    const d = await db();
    recordPayoutAttempt(
      d,
      "w1",
      { signature: "a", lastValidBlockHeight: 10, recentSlot: RECENT },
      1,
    );
    recordPayoutAttempt(
      d,
      "w1",
      { signature: "b", lastValidBlockHeight: 20, recentSlot: RECENT },
      2,
    );
    const v = await readChainVerdict(
      d,
      "w1",
      reader({ a: { status: "expired" }, b: { status: "landed", slot: 7 } }),
    );
    expect(v).toMatchObject({ kind: "paid", signature: "b", slot: 7, landed: ["b"] });
  });

  it("two landed attempts are both reported (the relay paid twice — logged by the door)", async () => {
    const d = await db();
    recordPayoutAttempt(
      d,
      "w2",
      { signature: "a", lastValidBlockHeight: 10, recentSlot: RECENT },
      1,
    );
    recordPayoutAttempt(
      d,
      "w2",
      { signature: "b", lastValidBlockHeight: 20, recentSlot: RECENT },
      2,
    );
    const v = await readChainVerdict(
      d,
      "w2",
      reader({ a: { status: "landed", slot: 1 }, b: { status: "landed", slot: 2 } }),
    );
    expect(v).toMatchObject({ kind: "paid", signature: "a", landed: ["a", "b"] });
  });

  it("failed and expired only ⇒ not paid; one pending ⇒ undecided; a throwing read ⇒ rpc_error", async () => {
    const d = await db();
    recordPayoutAttempt(
      d,
      "w3",
      { signature: "a", lastValidBlockHeight: 10, recentSlot: RECENT },
      1,
    );
    recordPayoutAttempt(
      d,
      "w3",
      { signature: "b", lastValidBlockHeight: 20, recentSlot: RECENT },
      2,
    );
    expect(
      await readChainVerdict(
        d,
        "w3",
        reader({ a: { status: "failed" }, b: { status: "expired" } }),
      ),
    ).toEqual({ kind: "not_paid", attempts: 2 });
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
      await readChainVerdict(d, "w3", reader({ a: new Error("socket"), b: { status: "expired" } })),
    ).toMatchObject({ kind: "undecided", reason: "rpc_error", signature: "a", detail: "socket" });
  });

  it("seen-in-a-block is sticky and persisted: a later expired read for it stays undecided", async () => {
    const d = await db();
    recordPayoutAttempt(
      d,
      "w4",
      { signature: "a", lastValidBlockHeight: 10, recentSlot: RECENT },
      1,
    );
    expect(
      await readChainVerdict(d, "w4", reader({ a: { status: "pending", seen: true } })),
    ).toMatchObject({ kind: "undecided", reason: "pending" });
    expect(getPayoutAttempts(d, "w4")[0]!.seen_in_block).toBe(1);
    expect(await readChainVerdict(d, "w4", reader({ a: { status: "expired" } }))).toMatchObject({
      kind: "undecided",
      reason: "pending",
    });
    // A landed read still decides it.
    expect(
      await readChainVerdict(d, "w4", reader({ a: { status: "landed", slot: 3 } })),
    ).toMatchObject({ kind: "paid", signature: "a" });
  });

  // #949 round 2: absence of evidence is evidence of absence only inside the
  // node's retained history.
  it("PR1: an expired read on a node whose history no longer reaches the landing window is history_pruned, never not_paid", async () => {
    const d = await db();
    recordPayoutAttempt(
      d,
      "wp",
      { signature: "a", lastValidBlockHeight: 10, recentSlot: RECENT },
      1,
    );
    // History starts after the transaction could have landed.
    expect(
      await readChainVerdict(d, "wp", reader({ a: { status: "expired" } }, RECENT + 5)),
    ).toMatchObject({ kind: "undecided", reason: "history_pruned", signature: "a" });
    // Just inside the margin is still pruned; far enough back decides it.
    expect(
      await readChainVerdict(d, "wp", reader({ a: { status: "expired" } }, RECENT - 4_607)),
    ).toMatchObject({ kind: "undecided", reason: "history_pruned" });
    expect(
      await readChainVerdict(d, "wp", reader({ a: { status: "expired" } }, RECENT - 4_608)),
    ).toEqual({ kind: "not_paid", attempts: 1 });
    // The retention edge unreadable ⇒ never not_paid.
    expect(
      await readChainVerdict(d, "wp", reader({ a: { status: "expired" } }, new Error("down"))),
    ).toMatchObject({ kind: "undecided", reason: "history_pruned" });
    // An adapter that itself reports the pruned history is read the same way.
    expect(
      await readChainVerdict(
        d,
        "wp",
        reader({ a: { status: "rpc_error", reason: "pruned", historyPruned: true } }),
      ),
    ).toMatchObject({ kind: "undecided", reason: "history_pruned" });
  });

  it("C1: an attempt recorded without its landing window still has a door — decided on a node holding deep history, undecided on a recent one", async () => {
    const d = await db();
    const L = 50_000;
    recordPayoutAttempt(d, "wn", { signature: "a", lastValidBlockHeight: L }, 1);
    // Every block's slot is at least its height, so the floor is L - 310; the
    // local ledger must reach 4 096 slots (the local-edge margin) below that.
    expect(await readChainVerdict(d, "wn", reader({ a: { status: "expired" } }, 0))).toEqual({
      kind: "not_paid",
      attempts: 1,
    });
    expect(
      await readChainVerdict(d, "wn", reader({ a: { status: "expired" } }, L - 4_406)),
    ).toEqual({
      kind: "not_paid",
      attempts: 1,
    });
    expect(
      await readChainVerdict(d, "wn", reader({ a: { status: "expired" } }, L - 4_405)),
    ).toMatchObject({ kind: "undecided", reason: "history_pruned" });
  });

  it("T2r: a node whose local ledger starts inside the landing margin (512) or the local-edge margin (4 096) is never read as not_paid", async () => {
    const d = await db();
    recordPayoutAttempt(
      d,
      "wm",
      { signature: "a", lastValidBlockHeight: 10, recentSlot: RECENT },
      1,
    );
    for (const edge of [RECENT - 1, RECENT - 100, RECENT - 511, RECENT - 4_607]) {
      expect(
        await readChainVerdict(d, "wm", reader({ a: { status: "expired" } }, edge)),
      ).toMatchObject({ kind: "undecided", reason: "history_pruned" });
    }
    expect(
      await readChainVerdict(d, "wm", reader({ a: { status: "expired" } }, RECENT - 4_608)),
    ).toEqual({ kind: "not_paid", attempts: 1 });
  });

  it("precedence: pending beats rpc_error beats history_pruned", async () => {
    const d = await db();
    recordPayoutAttempt(
      d,
      "wq",
      { signature: "a", lastValidBlockHeight: 10, recentSlot: RECENT },
      1,
    );
    recordPayoutAttempt(
      d,
      "wq",
      { signature: "b", lastValidBlockHeight: 20, recentSlot: RECENT },
      2,
    );
    recordPayoutAttempt(
      d,
      "wq",
      { signature: "c", lastValidBlockHeight: 30, recentSlot: RECENT },
      3,
    );
    const pruned = RECENT + 1;
    expect(
      await readChainVerdict(
        d,
        "wq",
        reader({ a: { status: "expired" }, b: new Error("x"), c: { status: "pending" } }, pruned),
      ),
    ).toMatchObject({ reason: "pending", signature: "c" });
    expect(
      await readChainVerdict(
        d,
        "wq",
        reader({ a: { status: "expired" }, b: new Error("x"), c: { status: "failed" } }, pruned),
      ),
    ).toMatchObject({ reason: "rpc_error", signature: "b" });
  });

  it("re-recording the same signature is a no-op (a re-sign over the same blockhash is the same transaction)", async () => {
    const d = await db();
    recordPayoutAttempt(
      d,
      "w5",
      { signature: "a", lastValidBlockHeight: 10, recentSlot: RECENT },
      1,
    );
    recordPayoutAttempt(
      d,
      "w5",
      { signature: "a", lastValidBlockHeight: 10, recentSlot: RECENT },
      2,
    );
    expect(getPayoutAttempts(d, "w5")).toHaveLength(1);
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
