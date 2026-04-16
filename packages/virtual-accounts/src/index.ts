/**
 * @motebit/virtual-accounts — per-motebit ledger with atomic credit/debit,
 * withdrawal lifecycle, dispute-window hold, and signed receipts.
 *
 * Layer 1. Persistence is inverted via the `AccountStore` interface;
 * consumers ship the implementation. See CLAUDE.md for the doctrinal
 * contract (Rules 1–6).
 */

export type {
  AccountBalanceDetail,
  AccountTransaction,
  NewWithdrawal,
  ReconciliationResult,
  TransactionType,
  VirtualAccount,
  WithdrawalRequest,
  WithdrawalStatus,
} from "./types.js";

export { DISPUTE_WINDOW_MS, MICRO, fromMicro, toMicro } from "./money.js";

export type { AccountStore, InMemoryAccountStoreOptions } from "./store.js";
export { InMemoryAccountStore } from "./store.js";

export type {
  CompleteWithdrawalArgs,
  RequestWithdrawalArgs,
  WithdrawalsLogger,
} from "./withdrawals.js";
export {
  completeWithdrawal,
  failWithdrawal,
  getAccountBalanceDetailed,
  linkWithdrawalTransfer,
  requestWithdrawal,
} from "./withdrawals.js";

export type { WithdrawalReceiptPayload } from "./signing.js";
export { signWithdrawalReceipt } from "./signing.js";
