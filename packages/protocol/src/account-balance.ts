/**
 * AccountBalanceResult — the wire format of the relay's virtual-account
 * balance read (`GET /api/v1/agents/{motebitId}/balance`).
 *
 * This is the market-v1 §2 account state projected across the HTTP
 * boundary. Per §2.3, internal amounts are integer micro-units and the
 * API boundary converts to decimal USD — so every monetary field here
 * is DECIMAL DOLLARS (JSON number), never micro-units. The producer is
 * the only place the conversion happens (`fromMicro` at the relay's
 * response boundary); no consumer converts back.
 *
 * All fields are required: the reference relay emits the complete shape
 * on both the account-exists and no-account-yet branches (the latter as
 * zeros/nulls/empty), so absence is never meaningful on this envelope.
 *
 * See spec/market-v1.md §2.6 / §2.7 for the binding tables.
 */

/**
 * One ledger transaction row as it crosses the wire — the §2.2 audit
 * record with `amount` / `balance_after` converted to decimal USD.
 */
export interface AccountBalanceTransaction {
  transaction_id: string;
  motebit_id: string;
  /**
   * One of the §2.2 transaction types (`deposit`, `withdrawal`,
   * `allocation_hold`, `allocation_release`, `settlement_debit`,
   * `settlement_credit`, `fee`, `waiver`). Typed `string` on the wire:
   * consumers MUST tolerate unknown values — new transaction types are
   * additive protocol evolution, and a reader that hard-fails on an
   * unrecognized type breaks forward compatibility.
   */
  type: string;
  /** Signed decimal USD. Credits positive, debits negative. */
  amount: number;
  /** Decimal USD balance after this transaction was applied. */
  balance_after: number;
  reference_id: string | null;
  description: string | null;
  /** Epoch milliseconds. */
  created_at: number;
}

/** Response of `GET /api/v1/agents/{motebitId}/balance`. */
export interface AccountBalanceResult {
  motebit_id: string;
  /** Available balance, decimal USD. */
  balance: number;
  /** ISO 4217 or token symbol. Default "USD". */
  currency: string;
  /** Decimal USD locked in not-yet-fired withdrawal requests. */
  pending_withdrawals: number;
  /** Decimal USD locked in active budget allocations. */
  pending_allocations: number;
  /** Decimal USD held back by the 24h dispute window (spec/settlement-v1.md). */
  dispute_window_hold: number;
  /** Decimal USD the relay would actually release on a withdrawal request now. */
  available_for_withdrawal: number;
  /** Operator sweep threshold in decimal USD, or null when unset. */
  sweep_threshold: number | null;
  /** Agent's declared settlement address, or null when undeclared. */
  settlement_address: string | null;
  /** Most recent transactions, newest first (reference relay caps at 50). */
  transactions: AccountBalanceTransaction[];
}
