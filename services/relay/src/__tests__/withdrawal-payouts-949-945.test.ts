/**
 * #949 / #945 / #990 unit edges the harnesses do not isolate:
 *
 *   - `readChainVerdict` over recorded durable transactions (#990): a payout
 *     found FINALIZED ok ⇒ paid; finalized with an error, or a kill over the
 *     SAME nonce value finalized ⇒ not paid; nothing broadcast ⇒ not paid;
 *     anything else (absent, found but not finalized, unreadable, a kill
 *     over another nonce value) ⇒ undecided; a finalized status is recorded
 *     once and never read again; a hung read times out as unreadable.
 *   - `requestKill`: only for a durable payout, only while the lane still
 *     holds its nonce value, recorded before broadcast.
 *   - the lane: a nonce value already carried by a recorded transaction is
 *     busy; the queue is FIFO and idempotent.
 *   - batch: a terminal write that loses its `firing` CAS writes no door;
 *     a row this process is still firing is never "recovered" as stale;
 *     a stale row whose rail is no longer registered is parked on the
 *     conservative (sent, 24h) door; the loop tick rethrows so the
 *     supervisor records a failed tick.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import type { GuestRail, WithdrawalResult } from "@motebit/sdk";
import type {
  DurableNonceLane,
  DurableTransactionRef,
  FinalizedSignatureStatus,
  NonceLaneState,
} from "@motebit/wallet-solana";
import type { DatabaseDriver } from "@motebit/persistence";

import type { SyncRelay } from "../index.js";
import { creditAccount } from "../accounts.js";
import {
  enqueuePendingWithdrawal,
  evaluateAndFireRail,
  runBatchWithdrawalTick,
  startBatchWithdrawalLoop,
  type BatchWithdrawalConfig,
} from "../batch-withdrawals.js";
import {
  dequeuePayout,
  enqueuePayout,
  getPayoutAttempts,
  isNonceValueUsed,
  mapBounded,
  queuedPayouts,
  readChainVerdict,
  recordDurableAttempt,
  requestKill,
  withTimeout,
} from "../withdrawal-chain-payouts.js";
import { UNDECLARED_PAYOUT_HORIZON_MS } from "../payout-horizon.js";
import { LoopSupervisor } from "../loop-supervisor.js";
import { AUTH_HEADER, createTestRelay } from "./test-helpers.js";
import { freshChain, makeDurableOperator } from "./durable-payout-fake.js";

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

const LANE: DurableNonceLane = { account: "NonceAcct", nonceValue: "N1" };

function payout(
  d: DatabaseDriver,
  w: string,
  sig: string,
  lane = LANE,
  at = 1,
  observedSlot: number | null = 100,
): void {
  recordDurableAttempt(
    d,
    w,
    {
      signature: sig,
      kind: "payout",
      nonceAccount: lane.account,
      nonceValue: lane.nonceValue,
      ...(observedSlot !== null ? { nonceObservedSlot: observedSlot } : {}),
    },
    at,
  );
}

function kill(d: DatabaseDriver, w: string, sig: string, lane = LANE, at = 2): void {
  recordDurableAttempt(
    d,
    w,
    { signature: sig, kind: "kill", nonceAccount: lane.account, nonceValue: lane.nonceValue },
    at,
  );
}

const OK: FinalizedSignatureStatus = { status: "finalized", ok: true, slot: 7 };
const ERR: FinalizedSignatureStatus = { status: "finalized", ok: false, slot: 8 };
const ABSENT: FinalizedSignatureStatus = { status: "unknown", reason: "absent" };
const UNFINAL: FinalizedSignatureStatus = { status: "unknown", reason: "not_finalized" };

function reader(statuses: Record<string, FinalizedSignatureStatus | Error | "hang">) {
  const calls: string[] = [];
  return {
    calls,
    getFinalizedStatus(sig: string): Promise<FinalizedSignatureStatus> {
      calls.push(sig);
      const st = statuses[sig];
      if (st === "hang") return new Promise(() => {});
      if (st instanceof Error) return Promise.reject(st);
      return Promise.resolve(st ?? ABSENT);
    },
  };
}

describe("readChainVerdict (#990: finalized statuses only)", () => {
  it("no recorded transaction ⇒ not paid (nothing was ever broadcast), without a chain read", async () => {
    const d = await db();
    const r = reader({});
    expect(await readChainVerdict(d, "w-none", r)).toEqual({
      kind: "not_paid",
      attempts: 0,
      by: "no_broadcast",
    });
    expect(r.calls).toEqual([]);
  });

  it("the payout finalized ok ⇒ paid by it; recorded, and never read again", async () => {
    const d = await db();
    payout(d, "w1", "p1");
    expect(await readChainVerdict(d, "w1", reader({ p1: OK }))).toMatchObject({
      kind: "paid",
      signature: "p1",
      slot: 7,
    });
    expect(getPayoutAttempts(d, "w1")[0]).toMatchObject({ final_status: "ok", final_slot: 7 });
    const again = reader({ p1: ABSENT });
    expect(await readChainVerdict(d, "w1", again)).toMatchObject({ kind: "paid" });
    expect(again.calls).toEqual([]);
  });

  it("the payout finalized with an error ⇒ not paid (it consumed its nonce; nothing moved)", async () => {
    const d = await db();
    payout(d, "w2", "p2");
    expect(await readChainVerdict(d, "w2", reader({ p2: ERR }))).toEqual({
      kind: "not_paid",
      attempts: 1,
      by: "payout_failed",
    });
  });

  it("a kill over the SAME nonce value finalized ⇒ not paid; over another value ⇒ undecided", async () => {
    const d = await db();
    payout(d, "w3", "p3");
    kill(d, "w3", "k-other", { account: "NonceAcct", nonceValue: "N-other" });
    expect(await readChainVerdict(d, "w3", reader({ "k-other": OK }))).toMatchObject({
      kind: "undecided",
      killable: true,
    });
    kill(d, "w3", "k3", LANE, 3);
    expect(await readChainVerdict(d, "w3", reader({ k3: OK }))).toEqual({
      kind: "not_paid",
      attempts: 3,
      by: "killed",
    });
  });

  it("a kill that is recorded but not FINALIZED decides nothing — the payout may still win the nonce", async () => {
    const d = await db();
    payout(d, "w8", "p8");
    kill(d, "w8", "k8");
    for (const st of [ABSENT, UNFINAL]) {
      expect(await readChainVerdict(d, "w8", reader({ p8: ABSENT, k8: st }))).toMatchObject({
        kind: "undecided",
        killable: true,
      });
    }
    // …and a finalized kill that failed still consumed the nonce.
    expect(await readChainVerdict(d, "w8", reader({ k8: ERR }))).toMatchObject({
      kind: "not_paid",
      by: "killed",
    });
  });

  it("absent, found below finality, or unreadable ⇒ undecided — never evidence", async () => {
    const d = await db();
    payout(d, "w4", "p4");
    expect(await readChainVerdict(d, "w4", reader({ p4: ABSENT }))).toMatchObject({
      kind: "undecided",
      reason: "pending",
      signature: "p4",
      unfinalized: [],
    });
    expect(await readChainVerdict(d, "w4", reader({ p4: UNFINAL }))).toMatchObject({
      kind: "undecided",
      unfinalized: ["p4"],
    });
    expect(await readChainVerdict(d, "w4", reader({ p4: new Error("503") }))).toMatchObject({
      kind: "undecided",
      reason: "rpc_error",
      detail: "503",
    });
    expect(getPayoutAttempts(d, "w4")[0]!.final_status).toBeNull();
  });

  it("a hung read times out as unreadable — it never holds the verdict", async () => {
    const d = await db();
    payout(d, "w5", "p5");
    const v = await readChainVerdict(d, "w5", reader({ p5: "hang" }), { timeoutMs: 20 });
    expect(v).toMatchObject({ kind: "undecided", reason: "rpc_error" });
  });

  it("a blockhash payout (an earlier build) is never killable; only its own finalized statuses decide it", async () => {
    const d = await db();
    d.prepare(
      "INSERT INTO relay_withdrawal_payout_attempts (withdrawal_id, signature, last_valid_block_height, recorded_at) VALUES ('w6', 'b6', 100, 1)",
    ).run();
    expect(await readChainVerdict(d, "w6", reader({}))).toMatchObject({
      kind: "undecided",
      killable: false,
    });
    expect(await readChainVerdict(d, "w6", reader({ b6: ERR }))).toMatchObject({
      kind: "not_paid",
      by: "payout_failed",
    });
  });

  it("re-recording the same signature is a no-op (a re-broadcast kill is the identical transaction)", async () => {
    const d = await db();
    kill(d, "w7", "k7");
    kill(d, "w7", "k7", LANE, 9);
    expect(getPayoutAttempts(d, "w7")).toHaveLength(1);
  });
});

describe("requestKill (#990 rounds 6–8)", () => {
  function killer(lane: NonceLaneState) {
    const sent: DurableTransactionRef[] = [];
    const reads: Array<{ account: string; minContextSlot?: number }> = [];
    return {
      sent,
      reads,
      readNonceAccount: (account: string, opts: { minContextSlot?: number } = {}) => {
        reads.push({ account, ...opts });
        return Promise.resolve(lane);
      },
      broadcastNonceKill: async (
        l: DurableNonceLane,
        hooks?: { beforeBroadcast?: (tx: DurableTransactionRef) => void | Promise<void> },
      ) => {
        const tx: DurableTransactionRef = {
          signature: `kill-${l.nonceValue}`,
          kind: "kill",
          nonceAccount: l.account,
          nonceValue: l.nonceValue,
        };
        await hooks?.beforeBroadcast?.(tx);
        sent.push(tx);
        return { tx, sent: true };
      },
    };
  }
  const at = (slot: number, value: string, account = "NonceAcct"): NonceLaneState => ({
    status: "ready",
    account,
    nonceValue: value,
    observedSlot: slot,
  });

  it("broadcasts nonceAdvance over the payout's own nonce value, recorded before it is sent", async () => {
    const d = await db();
    payout(d, "k1", "p");
    const k = killer(at(150, "N1"));
    expect(await requestKill(d, "k1", k)).toEqual({ status: "sent" });
    expect(k.sent[0]).toMatchObject({ kind: "kill", nonceValue: "N1", nonceAccount: "NonceAcct" });
    expect(getPayoutAttempts(d, "k1").map((a) => a.kind)).toEqual(["payout", "kill"]);
  });

  it("reads the payout's OWN nonce account, bound by the slot its value was observed at (C-1, P-a)", async () => {
    const d = await db();
    payout(d, "k5", "p", { account: "OldLaneAcct", nonceValue: "N1" }, 1, 777);
    const k = killer(at(800, "N1", "OldLaneAcct"));
    await requestKill(d, "k5", k);
    expect(k.reads).toEqual([{ account: "OldLaneAcct", minContextSlot: 777 }]);
    expect(k.sent[0]).toMatchObject({ nonceAccount: "OldLaneAcct" });
  });

  it("the lane PROVABLY past the payout's value — at or after the observed slot, a value never recorded — ⇒ consumed, nothing broadcast", async () => {
    const d = await db();
    payout(d, "k2", "p");
    const k = killer(at(100, "N9"));
    expect(await requestKill(d, "k2", k)).toEqual({ status: "consumed" });
    expect(k.sent).toEqual([]);
  });

  it("a read from BELOW the observed slot is stale, never consumed", async () => {
    const d = await db();
    payout(d, "k6", "p");
    const k = killer(at(99, "N9"));
    expect((await requestKill(d, "k6", k)).status).toBe("stale");
    expect(k.sent).toEqual([]);
  });

  it("belt and braces: a value recorded EARLIER on the account is stale, never consumed, even at a good slot", async () => {
    const d = await db();
    payout(d, "k-old", "p-old", { account: "NonceAcct", nonceValue: "N0" }, 1);
    payout(d, "k7", "p", LANE, 2);
    const k = killer(at(150, "N0"));
    expect((await requestKill(d, "k7", k)).status).toBe("stale");
    // …while a value recorded LATER (a later payout over the next value) is past.
    payout(d, "k-new", "p-new", { account: "NonceAcct", nonceValue: "N2" }, 3);
    expect((await requestKill(d, "k7", killer(at(150, "N2")))).status).toBe("consumed");
  });

  it("a payout recorded without its observed slot can never be called consumed", async () => {
    const d = await db();
    payout(d, "k8", "p", LANE, 1, null);
    const k = killer(at(150, "N9"));
    expect((await requestKill(d, "k8", k)).status).toBe("stale");
    expect(k.reads).toEqual([]);
  });

  it("no durable payout, or an unavailable lane ⇒ nothing broadcast", async () => {
    const d = await db();
    const k = killer(at(150, "N1"));
    expect(await requestKill(d, "k3", k)).toEqual({ status: "not_killable" });
    payout(d, "k4", "p");
    expect(await requestKill(d, "k4", killer({ status: "unavailable", reason: "down" }))).toEqual({
      status: "lane_unavailable",
      detail: "down",
    });
    expect(k.sent).toEqual([]);
  });
});

describe("the nonce lane and the queue (#990)", () => {
  it("a nonce value carried by any recorded transaction is busy", async () => {
    const d = await db();
    expect(isNonceValueUsed(d, LANE)).toBe(false);
    payout(d, "q1", "p");
    expect(isNonceValueUsed(d, LANE)).toBe(true);
    expect(isNonceValueUsed(d, { account: "NonceAcct", nonceValue: "N2" })).toBe(false);
  });

  it("the queue is FIFO, idempotent, and forgets a dequeued withdrawal", async () => {
    const d = await db();
    enqueuePayout(d, "b", 2);
    enqueuePayout(d, "a", 1);
    enqueuePayout(d, "a", 5);
    expect(queuedPayouts(d)).toEqual(["a", "b"]);
    dequeuePayout(d, "a");
    expect(queuedPayouts(d)).toEqual(["b"]);
  });

  it("mapBounded runs at most `limit` at a time; withTimeout rejects a hung call", async () => {
    let live = 0;
    let peak = 0;
    await mapBounded([1, 2, 3, 4, 5, 6], 2, async () => {
      live++;
      peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, 2));
      live--;
    });
    expect(peak).toBe(2);
    await expect(withTimeout(new Promise(() => {}), 10, "hung")).rejects.toThrow(/timed out/);
  });

  it("the relay starts the resolution loop, supervised, whenever it has a Solana transfer (activation)", async () => {
    const { operator } = makeDurableOperator(freshChain());
    relay = await createTestRelay({ enableDeviceAuth: false, operatorSolanaTransfer: operator });
    const res = await relay.app.request("/api/v1/admin/health", { headers: AUTH_HEADER });
    const health = (await res.json()) as { loops: Array<{ name: string }> };
    expect(health.loops.map((l) => l.name)).toContain("withdrawal-payout-resolution");
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
    // This process started before the claim (#1034: a claim from an earlier
    // process life has no send running and is recovered at once).
    await runBatchWithdrawalTick(d, [], FIRE_NOW, {
      processStartedAt: Date.now() - 60 * 60 * 1000,
    });
    expect(queueRow(d, id).status).toBe("firing");
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
    await runBatchWithdrawalTick(d, [], FIRE_NOW);
    const q = queueRow(d, id);
    // #1034's money rule: the payout may have left — held `unknown`, never refunded.
    expect(q.status).toBe("unknown");
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
    await runBatchWithdrawalTick(d, [], FIRE_NOW);
    expect(withdrawalCount(d, "zz945-orphan")).toBe(1);
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
    expect(queueRow(d, id).status).toBe("unknown");
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
