/**
 * Public types for the virtual-accounts ledger. All money in integer
 * micro-units (1 USD = 1,000,000). See money.ts for conversions.
 */

export type TransactionType =
  | "deposit"
  | "withdrawal"
  | "allocation_hold"
  | "allocation_release"
  | "settlement_debit"
  | "settlement_credit"
  | "fee"
  | "waiver";

export interface VirtualAccount {
  motebit_id: string;
  balance: number;
  currency: string;
  created_at: number;
  updated_at: number;
}

export interface AccountTransaction {
  transaction_id: string;
  motebit_id: string;
  type: TransactionType;
  amount: number;
  balance_after: number;
  reference_id: string | null;
  description: string | null;
  created_at: number;
}

export type WithdrawalStatus = "pending" | "processing" | "completed" | "failed" | "cancelled";

/**
 * The two non-terminal withdrawal states a settling transition names as its
 * FROM state (issue #921; spec/market-v1.md §10.3):
 *
 *   - `pending` — debited, no payout attempted. Only the operator's manual
 *     complete/fail acts on it.
 *   - `processing` — a payout was CLAIMED (`claimWithdrawalForPayout`, a
 *     compare-and-set) and handed to a rail. Only that payout's own outcome,
 *     or the operator's reconcile once the payout can no longer be in
 *     flight, acts on it — never a manual complete/fail, which could refund a
 *     payout that then lands.
 *
 * Every completion and every fail-and-refund states which one it expects, so
 * a caller cannot move a withdrawal out of a state it does not own.
 */
export type WithdrawalOpenStatus = "pending" | "processing";

export interface WithdrawalRequest {
  withdrawal_id: string;
  motebit_id: string;
  amount: number;
  currency: string;
  /** Wallet address, bank account ref, or "pending" for manual. */
  destination: string;
  status: WithdrawalStatus;
  /** External payout ID (Stripe transfer, tx hash, Bridge transfer id, ...). */
  payout_reference: string | null;
  requested_at: number;
  completed_at: number | null;
  failure_reason: string | null;
  /** Ed25519 signature over canonical-JSON of the completed withdrawal. */
  relay_signature: string | null;
  /** Hex-encoded relay public key, for independent offline verification. */
  relay_public_key: string | null;
  /**
   * When a payout claimed this withdrawal (`pending → processing`, #921);
   * null/absent when no payout was ever claimed. Not a wire field — the
   * operator's reconcile door reads it to refuse acting on a payout that may
   * still be in flight.
   */
  claimed_at?: number | null;
  /**
   * The claimed payout's own declared horizon (#921): the latest moment the
   * payload a rail was handed can still land. Null when the relay broadcasts
   * the payout itself. Not a wire field.
   */
  payout_valid_until?: number | null;
  /**
   * 1 on a row that was `pending` when the ledger first gained
   * claim-before-send (#921): its payout may have been attempted with no
   * claim recorded. Not a wire field.
   */
  pre_claim_review?: number | null;
}

/**
 * Fields the store needs to insert a new withdrawal. Status is fixed to
 * "pending" on insert; timestamps + signature are populated through the
 * lifecycle transitions.
 */
export interface NewWithdrawal {
  withdrawal_id: string;
  motebit_id: string;
  amount: number;
  currency: string;
  destination: string;
  idempotency_key: string | null;
  requested_at: number;
}

/**
 * Composite read used by the balance-detail endpoint. All integer
 * micro-units except `currency`.
 */
export interface AccountBalanceDetail {
  balance: number;
  currency: string;
  pending_withdrawals: number;
  pending_allocations: number;
  dispute_window_hold: number;
  available_for_withdrawal: number;
  /** Null when the motebit has not configured sovereign-sweep. */
  sweep_threshold: number | null;
  /** Null when no sovereign settlement address is configured. */
  settlement_address: string | null;
}

/**
 * Output of `reconcileLedger` — consumer runs cross-table audits against
 * its own schema; the package ships the shape so consumers can target it.
 */
export interface ReconciliationResult {
  consistent: boolean;
  errors: string[];
}
