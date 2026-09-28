/**
 * The payout horizon of a claimed withdrawal (#921): when a payout whose
 * outcome the relay never learned can no longer land, so an operator may
 * record it "not paid" and refund. Shared by the /withdraw paths, the
 * operator's reconcile door (budget.ts) and the batch fire path.
 *
 * Per-rail horizon table:
 *
 *   | payout                 | horizon source                                  |
 *   | ---------------------- | ----------------------------------------------- |
 *   | Path 0 Solana (relay   | last moment THIS relay could broadcast (send     |
 *   |  broadcasts itself)    |  call ended, or process start for an earlier    |
 *   |                        |  life) + blockhash lifetime (150s) + margin      |
 *   | Path 1 x402            | claim + the rail's declared payoutValidityMs     |
 *   |                        |  (the signed authorization's validBefore, 3600s) |
 *   |                        |  + margin                                        |
 *   | batch, rail declares   | fire time + payoutValidityMs + margin            |
 *   | batch, rail silent     | fire time + UNDECLARED_PAYOUT_HORIZON_MS (24h)   |
 *   |                        |  + margin                                        |
 *   | manual rail (Stripe)   | none — nothing is sent; the row stays `pending`  |
 *
 * Every horizon is floored at claim + RECONCILE_MIN_AGE_MS.
 */

import type { WithdrawalRequest } from "@motebit/virtual-accounts";

/**
 * The FLOOR of the operator's reconcile window (#921): no reconcile within
 * this long of a claim, whatever the rail. It is only a floor — never the
 * argument that a payout can no longer land. That argument is the payout's
 * own horizon (`reconcileOpensAt`): for a payload a third party can still
 * submit (x402's signed authorization), its declared validity; for a payout
 * the relay broadcasts itself (Solana), the moment this process last could
 * have broadcast plus one blockhash lifetime.
 */
export const RECONCILE_MIN_AGE_MS = 15 * 60 * 1000;

/**
 * Solana: a transaction is valid only until its blockhash's
 * `lastValidBlockHeight` — 150 blocks, about 60–90s at normal slot times.
 * Taken generously (slow slots) as 150s.
 */
export const SOLANA_BLOCKHASH_VALIDITY_MS = 150 * 1000;

/** Slack added to every declared horizon (clock skew, slow chain inclusion). */
export const PAYOUT_HORIZON_MARGIN_MS = 5 * 60 * 1000;

/**
 * The horizon for a claimed payout whose rail declares none (a batch rail
 * without `payoutValidityMs`): a conservative day — above any rail this relay
 * registers, never below.
 */
export const UNDECLARED_PAYOUT_HORIZON_MS = 24 * 60 * 60 * 1000;

/** When this process started: every broadcast it did not make itself happened before this. */
const PROCESS_STARTED_AT = Date.now();

/**
 * When the operator's reconcile may act on a `processing` withdrawal — the
 * latest of: the claim + the floor; the payout's declared horizon (+ margin)
 * when it has one; and, for a relay-broadcast payout (no declared horizon),
 * the last moment this relay could have broadcast it + a blockhash lifetime
 * (+ margin). The relay broadcasts only while its send call is running in a
 * live process: `sendEndedAt` is when this process's call returned or threw;
 * a claim from an earlier process life was broadcast, if at all, before this
 * process started. A send still running is refused before this is consulted.
 */
export function reconcileOpensAt(
  w: Pick<WithdrawalRequest, "claimed_at" | "payout_valid_until">,
  sendEndedAt: number | undefined,
  processStartedAt: number = PROCESS_STARTED_AT,
): number {
  const claimedAt = w.claimed_at ?? 0;
  let opens = claimedAt + RECONCILE_MIN_AGE_MS;
  if (w.payout_valid_until != null) {
    opens = Math.max(opens, w.payout_valid_until + PAYOUT_HORIZON_MARGIN_MS);
  } else {
    const lastBroadcastBound =
      sendEndedAt ?? (claimedAt < processStartedAt ? processStartedAt : Number.POSITIVE_INFINITY);
    opens = Math.max(
      opens,
      lastBroadcastBound + SOLANA_BLOCKHASH_VALIDITY_MS + PAYOUT_HORIZON_MARGIN_MS,
    );
  }
  return opens;
}
