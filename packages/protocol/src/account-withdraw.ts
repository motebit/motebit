/**
 * Account withdrawal wire format — the request and response of
 * `POST /api/v1/agents/{motebitId}/withdraw`, the money-OUT boundary of
 * the relay-mediated virtual account (market-v1 §2, settlement-v1).
 *
 * Money-out doctrine (docs/doctrine/off-ramp-as-user-action.md): the
 * relay's user-funds transmitter surface is structurally zero. A
 * withdrawal request debits the caller's virtual-account balance and
 * either auto-settles to a user-held wallet (Path 0 sovereign Solana /
 * Path 1 x402 EVM) or parks as `pending` for operator resolution. The
 * relay is the native principal of its own on-chain transfer to the
 * user's own address; it never transmits third-party funds.
 *
 * Threat model / invariants (all enforced by the reference relay):
 *   - `Idempotency-Key` HTTP header is REQUIRED. A replay returns the
 *     original response with no re-debit; the `idempotent` flag marks
 *     a request whose idempotency key matched a prior withdrawal.
 *   - `amount` MUST be a positive decimal-USD number. Non-positive ⇒ 400.
 *   - The debit respects the dispute-window hold: recent settlement
 *     credits are not withdrawable until the window elapses. Insufficient
 *     available balance ⇒ 402, no state change.
 *   - Authorization is `account:withdraw` — the account owner's signed
 *     device token, or the operator master token. A token minted for
 *     another audience is rejected (cross-endpoint replay defense).
 *
 * Non-goals: this request does NOT guarantee settlement completion. A
 * `pending`/`processing` status is the fail-safe — funds are already
 * held by the debit, so a settlement-rail failure strands the payout
 * for admin resolution without double-spend risk. Callers observe final
 * state via the withdrawal record's `status` and `payout_reference`.
 *
 * Amounts are decimal USD across this boundary (market-v1 §2.3 conversion
 * happens only at the producer), matching AccountBalanceResult.
 *
 * See spec/market-v1.md §2.8 / §2.9.
 */

/**
 * The known withdrawal lifecycle states. Documented as a union for
 * producers and consumers that want the closed set, but the wire field
 * (`AccountWithdrawalRecord.status`) is typed `string`: the vocabulary
 * evolves additively and a reader that hard-fails on an unknown status
 * breaks forward compatibility (same discipline as
 * `AccountBalanceTransaction.type`). The reference ledger's
 * `WithdrawalStatus` is this exact set.
 */
export type AccountWithdrawalStatus =
  | "pending"
  | "processing"
  | "completed"
  | "failed"
  | "cancelled";

/**
 * The signed field set committed in a completed-withdrawal receipt — the
 * canonical bytes `signWithdrawalReceipt` signs and `verifyWithdrawalReceipt`
 * re-checks (both in `@motebit/crypto`). This is a SUBSET of the wire
 * record: the relay signs the money-relevant facts (id, party, amount,
 * currency, destination, payout reference, completion time, relay id),
 * NOT the mutable lifecycle fields (status, requested_at, failure_reason).
 *
 * `amount` is decimal USD, matching the wire record. Signed only for
 * COMPLETED withdrawals; a pending withdrawal has no receipt.
 *
 * Adding a field here is a wire-format change — the sign and verify paths
 * live together in `@motebit/crypto` so the field set changes in one place.
 */
export interface WithdrawalReceiptPayload {
  withdrawal_id: string;
  motebit_id: string;
  amount: number;
  currency: string;
  destination: string;
  payout_reference: string;
  completed_at: number;
  relay_id: string;
}

/** Request body of `POST /api/v1/agents/{motebitId}/withdraw`. */
export interface AccountWithdrawRequest {
  /** Positive decimal USD to withdraw. */
  amount: number;
  /**
   * Payout target: a Solana base58 address (Path 0), an EVM 0x-hex
   * address (Path 1), or omitted for a manual/pending withdrawal the
   * operator resolves. The reference relay stores `"pending"` when absent.
   */
  destination?: string;
  /**
   * Optional withdrawal-level idempotency key. When absent the relay
   * uses the required `Idempotency-Key` HTTP header. Kept for backward
   * compatibility with clients that carried the key in the body.
   */
  idempotency_key?: string;
}

/**
 * A withdrawal record as it crosses the wire — the ledger's withdrawal
 * lifecycle row with `amount` converted to decimal USD. Mirror of
 * `WithdrawalRequest` in `@motebit/virtual-accounts` at the HTTP boundary.
 */
export interface AccountWithdrawalRecord {
  withdrawal_id: string;
  motebit_id: string;
  /** Decimal USD. */
  amount: number;
  currency: string;
  /** Wallet address, external ref, or "pending" for manual resolution. */
  destination: string;
  /**
   * Withdrawal lifecycle state — one of `AccountWithdrawalStatus` in
   * practice, typed `string` on the wire for additive forward-compat.
   */
  status: string;
  /** External payout id (tx hash, Stripe transfer, Bridge id), or null. */
  payout_reference: string | null;
  requested_at: number;
  completed_at: number | null;
  failure_reason: string | null;
  /**
   * The signing relay's `motebit_id`. Present so the record is
   * self-verifiable: it is a field of the signed `WithdrawalReceiptPayload`,
   * so without it an auditor reading only this response could not
   * reconstruct the canonical bytes. Always the relay's own identity.
   */
  relay_id: string;
  /** Ed25519 signature over the completed withdrawal, for offline verify. */
  relay_signature: string | null;
  /** Hex relay public key for independent verification, or null. */
  relay_public_key: string | null;
}

/** Response of `POST /api/v1/agents/{motebitId}/withdraw`. */
export interface AccountWithdrawResult {
  motebit_id: string;
  withdrawal: AccountWithdrawalRecord;
  /** Present and true when the idempotency key matched a prior request. */
  idempotent?: boolean;
}
