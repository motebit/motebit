/**
 * Batched withdrawal failure — refund only when the payout provably never left.
 *
 * `enqueuePendingWithdrawal` debits the agent at enqueue (CLAUDE.md rule 13).
 * Before this fix every failure of the fire path (`markFailed`: the serial
 * send threw, the whole `withdrawBatch` threw, a per-item batch failure) only
 * set the queue row `failed`: the debit stayed, no withdrawal row existed, and
 * nothing — no loop, no admin door — ever gave the money back or let the
 * operator's #921 reconcile resolve it. The agent's funds were stranded.
 *
 * The rule now (the money rule):
 *
 *   - PROVABLY NOT SENT ⇒ refund, exactly once, through the ledger, in ONE
 *     transaction with the queue row's status change (`refunded`). Proof is a
 *     `PayoutNotSentError` (`@motebit/settlement-rails`: the rail rejected the
 *     payout before signing or broadcasting anything) or a rail that declares
 *     itself MANUAL (`payoutMode: "manual"` — its `withdraw()` sends nothing).
 *     A refund the emergency freeze refuses leaves the row `refund_owed`; the
 *     next tick after unfreeze refunds it, once.
 *   - OUTCOME UNKNOWN (any other throw — broadcast then error, a timeout, an
 *     ambiguous rail answer — a per-item batch failure, which carries only a
 *     telemetry string, or a send the process died in) ⇒ NO refund. The row
 *     becomes `unknown` and a `processing` relay_withdrawals row is recorded
 *     with the payout's horizon, so the existing #921 reconcile door resolves
 *     it (paid ⇒ completed; not_paid ⇒ failed and refunded once).
 *
 * The table: every failure site × every rail outcome × {once, replayed loop,
 * restart}. After every step:
 *
 *   balance + queue holds + open withdrawal holds + paid out === funded
 *
 * and the refund count is ≤ 1, and 0 whenever the payout may have left.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import type {
  BatchWithdrawalItem,
  BatchWithdrawalResult,
  PaymentProof,
  WithdrawalResult,
} from "@motebit/sdk";
import * as batch from "../batch-withdrawals.js";
import { creditAccount, getAccountBalance } from "../accounts.js";
import { AUTH_HEADER, createTestRelay } from "./test-helpers.js";
import type { SyncRelay } from "../index.js";

const FUNDED = 10_000_000;
const AMOUNT = 3_000_000;
const DEST = "0x1234567890abcdef1234567890abcdef12345678";
const POLICY = {
  policy: { minAggregateMicro: 0, feeJustificationMultiplier: 1, maxAgeMs: 0 },
} as unknown as batch.BatchWithdrawalConfig;

type Site = "serial" | "batch_throw" | "batch_item";
type Outcome =
  | "rejected_before_signing"
  | "rejected_by_rail_pre_broadcast"
  | "manual_rail_threw"
  | "broadcast_then_error"
  | "timeout"
  | "success";
type Replay = "once" | "replayed" | "restart";

const SITES: readonly Site[] = ["serial", "batch_throw", "batch_item"];
const OUTCOMES: readonly Outcome[] = [
  "rejected_before_signing",
  "rejected_by_rail_pre_broadcast",
  "manual_rail_threw",
  "broadcast_then_error",
  "timeout",
  "success",
];
const REPLAYS: readonly Replay[] = ["once", "replayed", "restart"];

/**
 * A rail's proof that nothing left: structurally a `PayoutNotSentError`
 * (`payoutNotSent: true`). Built structurally so this harness runs (RED) on a
 * relay that predates the class.
 */
function notSent(message: string): Error {
  return Object.assign(new Error(message), { name: "PayoutNotSentError", payoutNotSent: true });
}

function errorFor(outcome: Outcome): Error {
  switch (outcome) {
    case "rejected_before_signing":
      return notSent("destination is not a valid address — nothing was signed");
    case "rejected_by_rail_pre_broadcast":
      return notSent("facilitator refused the payload before submission");
    case "manual_rail_threw":
      return new Error("manual rail: could not record payout intent");
    case "broadcast_then_error":
      return new Error("socket hang up after the transfer was submitted");
    case "timeout":
      return new Error("facilitator timeout after 60s");
    case "success":
      throw new Error("unreachable");
  }
}

class Rail {
  readonly custody = "relay" as const;
  readonly railType = "protocol" as const;
  readonly supportsDeposit = false as const;
  readonly supportsWithdraw = true as const;
  readonly name = "fake";
  readonly supportsBatch: boolean;
  readonly payoutMode?: "manual";
  sends = 0;
  hang = false;
  withdrawBatch?: (items: readonly BatchWithdrawalItem[]) => Promise<BatchWithdrawalResult>;

  constructor(
    private readonly site: Site,
    private readonly outcome: Outcome,
  ) {
    this.supportsBatch = site !== "serial";
    if (outcome === "manual_rail_threw") this.payoutMode = "manual";
    if (this.supportsBatch) {
      this.withdrawBatch = (items) => {
        this.sends++;
        if (this.hang) return new Promise(() => {});
        if (this.site === "batch_throw" && this.outcome !== "success") {
          return Promise.reject(errorFor(this.outcome));
        }
        if (this.outcome === "success") {
          return Promise.resolve({
            fired: items.map((item) => ({ item, result: this.paid(item.amount_micro / 1e6) })),
            failed: [],
          });
        }
        return Promise.resolve({
          fired: [],
          failed: items.map((item) => ({ item, reason: errorFor(this.outcome).message })),
        });
      };
    }
  }

  private paid(amount: number): WithdrawalResult {
    return {
      amount,
      currency: "USDC",
      proof: { reference: "tx-paid", railType: "protocol", confirmedAt: Date.now() },
    };
  }

  isAvailable(): Promise<boolean> {
    return Promise.resolve(true);
  }

  withdraw(_m: string, amount: number): Promise<WithdrawalResult> {
    this.sends++;
    if (this.hang) return new Promise(() => {});
    if (this.outcome === "success") return Promise.resolve(this.paid(amount));
    return Promise.reject(errorFor(this.outcome));
  }

  attachProof(_s: string, _p: PaymentProof): Promise<void> {
    return Promise.resolve();
  }
}

type FireRail = Parameters<typeof batch.evaluateAndFireRail>[1];

/** The production tick body when this relay has one; else main's (fire only). */
async function tick(relay: SyncRelay, rail: Rail, processStartedAt?: number): Promise<void> {
  const runTick = (batch as Record<string, unknown>)["runBatchWithdrawalTick"] as
    | ((
        db: unknown,
        rails: readonly unknown[],
        config: unknown,
        opts?: { processStartedAt?: number },
      ) => Promise<void>)
    | undefined;
  if (runTick) {
    await runTick(relay.moteDb.db, [rail], POLICY, { processStartedAt });
  } else {
    await batch.evaluateAndFireRail(relay.moteDb.db, rail as unknown as FireRail, POLICY);
  }
}

function q<T>(relay: SyncRelay, sql: string, ...args: unknown[]): T {
  return relay.moteDb.db.prepare(sql).get(...args) as T;
}

function ledger(relay: SyncRelay, mid: string) {
  const balance = getAccountBalance(relay.moteDb.db, mid)?.balance ?? 0;
  const queueHeld = q<{ s: number }>(
    relay,
    `SELECT COALESCE(SUM(amount_micro), 0) AS s FROM relay_pending_withdrawals
     WHERE motebit_id = ? AND status IN ('pending', 'firing', 'refund_owed')`,
    mid,
  ).s;
  const withdrawalHeld = q<{ s: number }>(
    relay,
    `SELECT COALESCE(SUM(amount), 0) AS s FROM relay_withdrawals
     WHERE motebit_id = ? AND status IN ('pending', 'processing')`,
    mid,
  ).s;
  const paidOut = q<{ s: number }>(
    relay,
    `SELECT COALESCE(SUM(amount), 0) AS s FROM relay_withdrawals
     WHERE motebit_id = ? AND status = 'completed'`,
    mid,
  ).s;
  const refunds = q<{ n: number }>(
    relay,
    `SELECT COUNT(*) AS n FROM relay_transactions
     WHERE motebit_id = ? AND type = 'withdrawal' AND amount > 0`,
    mid,
  ).n;
  return { balance, queueHeld, withdrawalHeld, paidOut, refunds };
}

function expectConserved(relay: SyncRelay, mid: string, label: string) {
  const l = ledger(relay, mid);
  expect(
    l.balance + l.queueHeld + l.withdrawalHeld + l.paidOut,
    `${label}: conservation ${JSON.stringify(l)}`,
  ).toBe(FUNDED);
  expect(l.refunds, `${label}: refunds at most once`).toBeLessThanOrEqual(1);
  return l;
}

function queueRow(relay: SyncRelay, mid: string) {
  return q<{ status: string; withdrawal_id: string | null }>(
    relay,
    "SELECT status, withdrawal_id FROM relay_pending_withdrawals WHERE motebit_id = ?",
    mid,
  );
}

function provenNotSent(site: Site, outcome: Outcome): boolean {
  if (outcome === "manual_rail_threw") return true;
  // A per-item batch failure is a telemetry string, never a proof.
  return (
    site !== "batch_item" &&
    (outcome === "rejected_before_signing" || outcome === "rejected_by_rail_pre_broadcast")
  );
}

const realNow = Date.now.bind(Date);
let offset = 0;
function jumpClock(ms: number): void {
  offset += ms;
  vi.spyOn(Date, "now").mockImplementation(() => realNow() + offset);
}

let relay: SyncRelay | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  offset = 0;
  await relay?.close();
  relay = undefined;
});

async function setup(mid: string): Promise<SyncRelay> {
  relay = await createTestRelay({ enableDeviceAuth: false });
  creditAccount(relay.moteDb.db, mid, FUNDED, "deposit", null, "fund");
  const id = batch.enqueuePendingWithdrawal(relay.moteDb.db, {
    motebitId: mid,
    amountMicro: AMOUNT,
    destination: DEST,
    rail: "fake",
    source: "sweep",
  });
  expect(id).not.toBeNull();
  expectConserved(relay, mid, "enqueued");
  return relay;
}

async function reconcile(
  relay: SyncRelay,
  withdrawalId: string,
  outcome: "paid" | "not_paid",
): Promise<Response> {
  return relay.app.request(`/api/v1/admin/withdrawals/${withdrawalId}/reconcile`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...AUTH_HEADER },
    body: JSON.stringify({
      outcome,
      attestation: "treasury history checked since the claim",
      ...(outcome === "paid" ? { payout_reference: "tx-found" } : {}),
    }),
  });
}

describe("batched withdrawal failure: refund only what provably never left", () => {
  for (const site of SITES) {
    for (const outcome of OUTCOMES) {
      for (const replay of REPLAYS) {
        const label = `${site} × ${outcome} × ${replay}`;
        it(label, async () => {
          const mid = `bwr-${site}-${outcome}-${replay}`;
          const r = await setup(mid);
          const rail = new Rail(site, outcome);

          if (replay === "restart") {
            // The process dies mid-send: the claim is written, the send never
            // returns. A new process life recovers the row.
            rail.hang = true;
            void tick(r, rail);
            await new Promise((res) => setTimeout(res, 10));
            expect(queueRow(r, mid).status).toBe("firing");
            expectConserved(r, mid, `${label}: mid-send`);
            jumpClock(5 * 60 * 1000);
            await tick(r, rail, Date.now());
          } else {
            await tick(r, rail);
          }

          const after = expectConserved(r, mid, `${label}: after fire`);
          expect(rail.sends, `${label}: one send`).toBe(1);

          const crashed = replay === "restart";
          const refund = crashed ? outcome === "manual_rail_threw" : provenNotSent(site, outcome);
          const paid = !crashed && outcome === "success";

          if (paid) {
            expect(queueRow(r, mid).status).toBe("fired");
            expect(after.paidOut).toBe(AMOUNT);
            expect(after.refunds).toBe(0);
          } else if (refund) {
            expect(queueRow(r, mid).status).toBe("refunded");
            expect(after.balance).toBe(FUNDED);
            expect(after.refunds).toBe(1);
          } else {
            // May have left: never refunded; held where #921 reconciles it.
            const row = queueRow(r, mid);
            expect(row.status).toBe("unknown");
            expect(after.refunds).toBe(0);
            expect(after.balance).toBe(FUNDED - AMOUNT);
            const w = q<{ status: string; amount: number; payout_valid_until: number | null }>(
              r,
              "SELECT status, amount, payout_valid_until FROM relay_withdrawals WHERE withdrawal_id = ?",
              row.withdrawal_id,
            );
            expect(w.status).toBe("processing");
            expect(w.amount).toBe(AMOUNT);
            expect(w.payout_valid_until).not.toBeNull();
          }

          if (replay === "replayed") {
            for (let i = 0; i < 3; i++) await tick(r, rail);
            expect(rail.sends, `${label}: a replay never re-sends`).toBe(1);
            const again = expectConserved(r, mid, `${label}: after replays`);
            expect(again).toEqual(after);
          }

          if (!paid && !refund) {
            // The #921 door resolves the hold, once, after the horizon.
            const wid = queueRow(r, mid).withdrawal_id!;
            expect((await reconcile(r, wid, "not_paid")).status).toBe(409);
            jumpClock(2 * 24 * 60 * 60 * 1000);
            const res = await reconcile(r, wid, "not_paid");
            expect(res.status, await res.clone().text()).toBe(200);
            const done = expectConserved(r, mid, `${label}: reconciled`);
            expect(done.balance).toBe(FUNDED);
            expect(done.refunds).toBe(1);
            await tick(r, rail);
            expect((await reconcile(r, wid, "not_paid")).status).toBe(409);
            expect(expectConserved(r, mid, `${label}: after reconcile replay`).refunds).toBe(1);
          }
        });
      }
    }
  }
});

describe("a proven-not-sent refund respects the emergency freeze", () => {
  it("freeze lands during the send ⇒ refund_owed, no credit; after unfreeze one tick refunds once", async () => {
    const mid = "bwr-freeze";
    const r = await setup(mid);
    const rail = new Rail("serial", "rejected_by_rail_pre_broadcast");
    const send = rail.withdraw.bind(rail);
    rail.withdraw = async (m: string, amount: number) => {
      const res = await r.app.request("/api/v1/admin/freeze", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...AUTH_HEADER },
        body: JSON.stringify({ reason: "bwr" }),
      });
      expect(res.status).toBe(200);
      return send(m, amount);
    };
    await tick(r, rail);
    expect(queueRow(r, mid).status).toBe("refund_owed");
    const frozen = expectConserved(r, mid, "frozen");
    expect(frozen.refunds).toBe(0);
    expect(frozen.balance).toBe(FUNDED - AMOUNT);

    const un = await r.app.request("/api/v1/admin/unfreeze", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
    });
    expect(un.status).toBe(200);
    await tick(r, rail);
    await tick(r, rail);
    expect(queueRow(r, mid).status).toBe("refunded");
    const done = expectConserved(r, mid, "unfrozen");
    expect(done.balance).toBe(FUNDED);
    expect(done.refunds).toBe(1);
    expect(rail.sends).toBe(1);
  });

  it("a send in flight in THIS process is never recovered as a crash", async () => {
    const mid = "bwr-inflight";
    const r = await setup(mid);
    const rail = new Rail("serial", "success");
    rail.hang = true;
    void tick(r, rail);
    await new Promise((res) => setTimeout(res, 10));
    jumpClock(10 * 60 * 1000);
    await tick(r, rail);
    expect(queueRow(r, mid).status).toBe("firing");
    expect(ledger(r, mid).refunds).toBe(0);
    expectConserved(r, mid, "in flight");
  });
});
