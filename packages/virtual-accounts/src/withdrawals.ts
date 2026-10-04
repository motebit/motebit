/**
 * Withdrawal lifecycle functions.
 *
 * Stateless orchestration over an injected `AccountStore`. Each function
 * preserves the Rule-9 dispute-window hold check and the atomic
 * debit-first semantics of the pre-extraction shape.
 */

import type { AccountStore } from "./store.js";
import type { WithdrawalOpenStatus, WithdrawalRequest } from "./types.js";
import { assertPositiveMicro, fromMicro } from "./money.js";

/** Structured logger contract. Consumer injects a platform logger. */
export interface WithdrawalsLogger {
  info(event: string, data?: Record<string, unknown>): void;
}

const NOOP_LOGGER: WithdrawalsLogger = { info: () => {} };

/** Balance decomposed into the two withdrawal holds and what's left. */
export interface WithdrawableAvailable {
  balance: number;
  /** Dispute-window escrow — recent settlement credits not yet clear. */
  disputeHold: number;
  /** Unspent promotional grant — spendable on inference, never withdrawable. */
  grantHold: number;
  /** `balance − disputeHold − grantHold`, floored at zero. */
  available: number;
}

/**
 * How much of an account may LEAVE as cash, right now.
 *
 * Canonical because "withdrawable" has two holds and every exit path must
 * subtract both. This is the single definition; the user-initiated request
 * path, the relay's aggregated pending-withdrawal enqueue, and the automatic
 * sweep all consume it rather than each re-deriving `balance − holds`.
 *
 * The drift this closes was real: the enqueue and sweep paths subtracted only
 * the dispute hold, so on a deploy with both a sweep rail and promotional
 * credit enabled, an unspent grant could be auto-swept out as cash — the exact
 * outcome the grant hold exists to prevent, reachable on the one exit path
 * nobody had to ask for.
 *
 * Withdrawal-only by construction: `debitSpendable` consults the dispute hold
 * alone, so grant credit stays spendable on inference.
 */
export function computeWithdrawableAvailable(
  store: AccountStore,
  motebitId: string,
): WithdrawableAvailable {
  const balance = store.getOrCreateAccount(motebitId).balance;
  const disputeHold = store.getUnwithdrawableHold(motebitId);
  const grantHold = store.getUnspentGrantHold(motebitId);
  return {
    balance,
    disputeHold,
    grantHold,
    available: Math.max(0, balance - disputeHold - grantHold),
  };
}

export interface RequestWithdrawalArgs {
  motebitId: string;
  /** Amount in integer micro-units. */
  amountMicro: number;
  /** Wallet address, bank account ref, or "pending" for manual. */
  destination?: string;
  /** Optional idempotency key; a second call returns the existing request. */
  idempotencyKey?: string;
  /** UUID supplier; default uses crypto.randomUUID. Injected for tests. */
  newId?: () => string;
  now?: () => number;
  logger?: WithdrawalsLogger;
}

/**
 * Request a withdrawal. Debits the virtual account immediately (funds
 * held). Returns:
 *   - `WithdrawalRequest` on success
 *   - `{ existing }` if an idempotency key matches a prior request
 *   - `null` on insufficient funds (including dispute-window hold)
 */
export function requestWithdrawal(
  store: AccountStore,
  args: RequestWithdrawalArgs,
): WithdrawalRequest | null | { existing: WithdrawalRequest } {
  // Before the idempotency lookup: an invalid amount is a caller bug, never
  // something a replay could legitimize.
  assertPositiveMicro(args.amountMicro, "requestWithdrawal");
  const logger = args.logger ?? NOOP_LOGGER;
  const destination = args.destination ?? "pending";

  if (args.idempotencyKey) {
    const prior = store.getWithdrawalByIdempotencyKey(args.motebitId, args.idempotencyKey);
    if (prior) {
      logger.info("withdrawal.idempotent", {
        motebitId: args.motebitId,
        idempotencyKey: args.idempotencyKey,
      });
      return { existing: prior };
    }
  }

  // Withdrawal holds: (1) dispute-window escrow — recent settlement credits
  // not yet clear of the dispute window; (2) unspent promotional grant —
  // "free first taste" credit is spendable on inference but never withdrawable
  // as cash. Both are subtracted from the withdrawable amount; the grant hold
  // is withdrawal-only (spending is unaffected — see `debitSpendable`, which
  // consults only the dispute hold).
  const { balance, disputeHold, grantHold, available } = computeWithdrawableAvailable(
    store,
    args.motebitId,
  );
  if (available < args.amountMicro) {
    logger.info("withdrawal.hold_insufficient", {
      motebitId: args.motebitId,
      requestedAmount: args.amountMicro,
      balance,
      disputeHold,
      grantHold,
      available,
    });
    return null;
  }

  const withdrawalId = (args.newId ?? (() => crypto.randomUUID()))();
  const now = (args.now ?? (() => Date.now()))();

  // The key check, the debit and the withdrawal row are ONE store operation:
  // a failure anywhere leaves neither, so the same-key replay debits once.
  const result = store.debitAndRecordWithdrawal(
    {
      withdrawal_id: withdrawalId,
      motebit_id: args.motebitId,
      amount: args.amountMicro,
      currency: "USD",
      destination,
      idempotency_key: args.idempotencyKey ?? null,
      requested_at: now,
    },
    `Withdrawal request: $${fromMicro(args.amountMicro).toFixed(6)} to ${destination}`,
  );
  if (result === null) return null;
  if ("existing" in result) {
    logger.info("withdrawal.idempotent", {
      motebitId: args.motebitId,
      idempotencyKey: args.idempotencyKey,
    });
    return result;
  }
  const { record, newBalance } = result;

  logger.info("withdrawal.requested", {
    motebitId: args.motebitId,
    withdrawalId,
    amount: args.amountMicro,
    destination,
    idempotencyKey: args.idempotencyKey ?? null,
    balanceAfter: newBalance,
  });

  return record;
}

/**
 * Link a pending withdrawal to an external transfer id (e.g., Bridge
 * transfer). Idempotent — returns false if already linked or not in a
 * link-eligible status.
 */
export function linkWithdrawalTransfer(
  store: AccountStore,
  withdrawalId: string,
  payoutReference: string,
): boolean {
  return store.linkWithdrawalTransfer(withdrawalId, payoutReference);
}

/**
 * Claim a pending withdrawal for an automated payout (issue #921): the
 * compare-and-set `pending → processing`. Returns true only when THIS call
 * claimed it. Call it BEFORE sending anything; on false, do not send — the
 * withdrawal's outcome already belongs to someone else (an operator's manual
 * complete/fail, a concurrent handler). After a true claim, the payout's
 * outcome settles the withdrawal FROM `processing` only
 * (`completeWithdrawal`/`failWithdrawal` with `from: "processing"`).
 */
export function claimWithdrawalForPayout(
  store: AccountStore,
  withdrawalId: string,
  claimedAt: number = Date.now(),
  logger: WithdrawalsLogger = NOOP_LOGGER,
  payoutValidUntil: number | null = null,
): boolean {
  const ok = store.claimWithdrawalForPayout(withdrawalId, claimedAt, payoutValidUntil);
  if (ok)
    logger.info("withdrawal.claimed_for_payout", { withdrawalId, claimedAt, payoutValidUntil });
  return ok;
}

export interface CompleteWithdrawalArgs {
  withdrawalId: string;
  payoutReference: string;
  /**
   * The state the completion moves the withdrawal FROM (#921): `processing`
   * for a claimed payout's own confirmed outcome or the operator's
   * reconcile, `pending` for the operator's manual completion of an
   * unclaimed withdrawal. A withdrawal not in `from` is not completed.
   */
  from: WithdrawalOpenStatus;
  relaySignature?: string;
  relayPublicKey?: string;
  completedAt?: number;
  logger?: WithdrawalsLogger;
}

/**
 * Mark a pending withdrawal completed. When a signature is provided,
 * `completedAt` must match the timestamp used when computing the
 * signed payload (byte-identical commitment).
 */
export function completeWithdrawal(store: AccountStore, args: CompleteWithdrawalArgs): boolean {
  const logger = args.logger ?? NOOP_LOGGER;
  const now = args.completedAt ?? Date.now();
  const ok = store.setWithdrawalCompletion(args.withdrawalId, args.payoutReference, now, args.from);
  if (!ok) return false;
  if (args.relaySignature && args.relayPublicKey) {
    store.setWithdrawalSignature(args.withdrawalId, args.relaySignature, args.relayPublicKey);
  }
  logger.info("withdrawal.completed", {
    withdrawalId: args.withdrawalId,
    payoutReference: args.payoutReference,
    signed: !!args.relaySignature,
  });
  return true;
}

/**
 * Fail a withdrawal and atomically return funds to the virtual account.
 * Returns false if the withdrawal isn't in a failable state.
 *
 * The status transition and the refund are ONE store operation
 * (`AccountStore.failWithdrawalAndRefund`) — never a read, then a credit,
 * then a status write (issue #920: that shape could leave "refunded but
 * still pending" behind a crash, and a retry would then refund twice). The
 * refund happens at most once per withdrawal: a second call returns false.
 *
 * Only call this when the payout DEFINITIVELY did not move funds (a rail
 * that reported a landed-and-failed transfer, or an operator who has
 * checked). An unknown outcome — a send that threw, a timeout — must leave
 * the withdrawal `processing`: refunding a payout that in fact landed pays
 * the user twice.
 *
 * `from` (#921) is the state the caller owns: `processing` for a claimed
 * payout's proven failure or the operator's reconcile, `pending` for the
 * operator's manual fail of a withdrawal no payout ever claimed.
 */
export function failWithdrawal(
  store: AccountStore,
  withdrawalId: string,
  reason: string,
  from: WithdrawalOpenStatus,
  logger: WithdrawalsLogger = NOOP_LOGGER,
  failedAt?: number,
): boolean {
  const refunded = store.failWithdrawalAndRefund(withdrawalId, reason, from, failedAt);
  if (refunded === null) return false;

  logger.info("withdrawal.failed", {
    withdrawalId,
    motebitId: refunded.motebitId,
    amount: refunded.amount,
    reason,
  });

  return true;
}

/**
 * Record, on a claimed withdrawal that stays `processing`, why its automated
 * payout is unresolved (issue #920/#921). No status or balance change — the
 * operator reconciles on chain and then settles it through the reconcile
 * door. Returns false when the withdrawal is not `processing`.
 */
export function noteWithdrawalPayoutUnresolved(
  store: AccountStore,
  withdrawalId: string,
  note: string,
  logger: WithdrawalsLogger = NOOP_LOGGER,
): boolean {
  const ok = store.noteWithdrawalPayoutUnresolved(withdrawalId, note);
  if (ok) logger.info("withdrawal.payout_unresolved", { withdrawalId, note });
  return ok;
}

/**
 * Composite read used by balance-detail endpoints. Combines the ledger
 * balance with pending withdrawals, pending allocations, dispute-window
 * hold, and sovereign-sweep configuration.
 */
export function getAccountBalanceDetailed(
  store: AccountStore,
  motebitId: string,
): import("./types.js").AccountBalanceDetail {
  const account = store.getOrCreateAccount(motebitId);
  const pendingW = store.getPendingWithdrawalsTotal(motebitId);
  const pendingA = store.getPendingAllocationsTotal(motebitId);
  // The user-facing "available" number consumes the SAME canonical computation
  // as every exit path. It was re-deriving `balance − holds` inline, which made
  // it the likeliest place for the displayed figure to drift from the amount a
  // withdrawal would actually permit.
  const { disputeHold, available } = computeWithdrawableAvailable(store, motebitId);
  const sweep = store.getSweepConfig(motebitId);

  return {
    balance: account.balance,
    currency: account.currency,
    pending_withdrawals: pendingW,
    pending_allocations: pendingA,
    // `dispute_window_hold` reports the escrow hold only; the grant hold is
    // additionally netted out of `available_for_withdrawal` so a promotional
    // grant never shows as withdrawable cash.
    dispute_window_hold: disputeHold,
    available_for_withdrawal: available,
    sweep_threshold: sweep.sweep_threshold,
    settlement_address: sweep.settlement_address,
  };
}
