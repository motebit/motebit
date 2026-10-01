/**
 * When a claimed withdrawal's payout can no longer land, so an operator may
 * settle it through the reconcile door (#921, #949). Shared by the /withdraw
 * path, the operator's reconcile door (budget.ts) and the batch fire path.
 *
 * Per-payout table — who decides:
 *
 *   | payout                          | decided by                                     |
 *   | ------------------------------- | ---------------------------------------------- |
 *   | Path 0 Solana, chain-recorded   | CONSENSUS RULES (#990): a durable-nonce payout |
 *   |  (claimed by this code)         |  — at most one transaction over its nonce value |
 *   |                                 |  lands — decided by FINALIZED statuses only:    |
 *   |                                 |  payout ok ⇒ paid; payout failed or its kill    |
 *   |                                 |  finalized ⇒ not paid; anything else undecided  |
 *   |                                 |  (withdrawal-chain-payouts.ts). No wall clock.  |
 *   | Path 0 Solana, legacy claim     | THE OPERATOR's `paid` only: nothing recorded,   |
 *   |  (an earlier process, or a      |  no nonce to kill, so no proof of non-landing   |
 *   |  blockhash payout)              |  can exist; `not_paid` is refused               |
 *   | Path 1 x402, legacy claim       | `reconcileOpensAt`: the recorded authorization |
 *   |                                 |  validity (payout_valid_until) + margin. No    |
 *   |                                 |  new x402 payout exists (#948 removed it).     |
 *   | batch, rail declares validity   | `reconcileOpensAt`: fire + payoutValidityMs    |
 *   | batch, rail silent              | `reconcileOpensAt`: fire + 24h                 |
 *   | manual rail (Stripe)            | none — nothing is sent; the row stays pending  |
 *
 * The last three are a rail's own declaration read against the relay's
 * clock: the relay has no chain reader for a generic guest rail. No such
 * sent-mode rail is registered by this relay today (Stripe is manual; x402
 * no longer withdraws), so every automated payout the relay makes now is
 * decided by chain facts.
 */

import type { WithdrawalRequest } from "@motebit/virtual-accounts";

/**
 * The FLOOR of the operator's reconcile window for a declared-horizon payout
 * (#921): no reconcile within this long of a claim. It is only a floor —
 * never the argument that a payout can no longer land.
 */
export const RECONCILE_MIN_AGE_MS = 15 * 60 * 1000;

/** Slack added to every declared horizon (clock skew, slow inclusion). */
export const PAYOUT_HORIZON_MARGIN_MS = 5 * 60 * 1000;

/**
 * The horizon for a claimed payout whose rail declares none (a batch rail
 * without `payoutValidityMs`): a conservative day — above any rail this relay
 * registers, never below.
 */
export const UNDECLARED_PAYOUT_HORIZON_MS = 24 * 60 * 60 * 1000;

/**
 * When the operator's reconcile may act on a `processing` withdrawal whose
 * payout carries a DECLARED horizon (`payout_valid_until`), or null when it
 * carries none — fail closed: such a payout is decided by the chain
 * (budget.ts), never by this clock.
 */
export function reconcileOpensAt(
  w: Pick<WithdrawalRequest, "claimed_at" | "payout_valid_until">,
): number | null {
  if (w.payout_valid_until == null) return null;
  const floor = (w.claimed_at ?? 0) + RECONCILE_MIN_AGE_MS;
  return Math.max(floor, w.payout_valid_until + PAYOUT_HORIZON_MARGIN_MS);
}
