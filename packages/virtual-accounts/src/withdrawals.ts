/**
 * Withdrawal lifecycle functions.
 *
 * Stateless orchestration over an injected `AccountStore`. Each function
 * preserves the Rule-9 dispute-window hold check and the atomic
 * debit-first semantics of the pre-extraction shape.
 */

import type { AccountStore } from "./store.js";
import type { WithdrawalRequest } from "./types.js";
import { fromMicro } from "./money.js";

/** Structured logger contract. Consumer injects a platform logger. */
export interface WithdrawalsLogger {
  info(event: string, data?: Record<string, unknown>): void;
}

const NOOP_LOGGER: WithdrawalsLogger = { info: () => {} };

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

  // Dispute-window hold check: funds from recent settlements are not
  // withdrawable until the 24-hour window elapses.
  const disputeHold = store.getUnwithdrawableHold(args.motebitId);
  const account = store.getOrCreateAccount(args.motebitId);
  if (account.balance - disputeHold < args.amountMicro) {
    logger.info("withdrawal.dispute_window_hold", {
      motebitId: args.motebitId,
      requestedAmount: args.amountMicro,
      balance: account.balance,
      disputeHold,
      available: account.balance - disputeHold,
    });
    return null;
  }

  const withdrawalId = (args.newId ?? (() => crypto.randomUUID()))();
  const now = (args.now ?? (() => Date.now()))();

  const newBalance = store.debit(
    args.motebitId,
    args.amountMicro,
    "withdrawal",
    withdrawalId,
    `Withdrawal request: $${fromMicro(args.amountMicro).toFixed(6)} to ${destination}`,
  );
  if (newBalance === null) return null;

  const record = store.insertWithdrawal({
    withdrawal_id: withdrawalId,
    motebit_id: args.motebitId,
    amount: args.amountMicro,
    currency: "USD",
    destination,
    idempotency_key: args.idempotencyKey ?? null,
    requested_at: now,
  });

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

export interface CompleteWithdrawalArgs {
  withdrawalId: string;
  payoutReference: string;
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
  const ok = store.setWithdrawalCompletion(args.withdrawalId, args.payoutReference, now);
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
 */
export function failWithdrawal(
  store: AccountStore,
  withdrawalId: string,
  reason: string,
  logger: WithdrawalsLogger = NOOP_LOGGER,
): boolean {
  const w = store.getWithdrawalById(withdrawalId);
  if (!w) return false;
  if (w.status !== "pending" && w.status !== "processing") return false;

  store.credit(w.motebit_id, w.amount, "withdrawal", withdrawalId, `Withdrawal failed: ${reason}`);
  store.updateWithdrawalStatus(withdrawalId, "failed", reason);

  logger.info("withdrawal.failed", {
    withdrawalId,
    motebitId: w.motebit_id,
    amount: w.amount,
    reason,
  });

  return true;
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
  const disputeHold = store.getUnwithdrawableHold(motebitId);
  const sweep = store.getSweepConfig(motebitId);

  return {
    balance: account.balance,
    currency: account.currency,
    pending_withdrawals: pendingW,
    pending_allocations: pendingA,
    dispute_window_hold: disputeHold,
    available_for_withdrawal: Math.max(0, account.balance - disputeHold),
    sweep_threshold: sweep.sweep_threshold,
    settlement_address: sweep.settlement_address,
  };
}
