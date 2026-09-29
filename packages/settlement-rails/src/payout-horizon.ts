/**
 * Payout horizon — what a withdrawable rail declares about the life of a
 * payout it was handed (issue #921).
 *
 * The relay must know, for a payout whose outcome it never learned (the call
 * threw, the process died), when the payout can no longer land — only after
 * that may an operator record it as "not paid" and refund. Two declarations,
 * both optional class members read structurally (they are not part of the
 * protocol `GuestRail` type; a rail that declares neither is treated as
 * "sent, horizon unknown" and the relay applies its own conservative floor):
 *
 *   - `payoutMode: "manual"` — `withdraw()` sends NOTHING; it records intent
 *     and an operator pays out by hand (Stripe today). Nothing is in flight,
 *     so the withdrawal stays an ordinary `pending` one.
 *   - `payoutValidityMs` — the longest time after `withdraw()` is called that
 *     the payload it signed can still be submitted and land.
 *
 * No rail in this package declares `payoutMode: "sent"` any more: x402 was
 * the only one, and its withdraw was removed (#948 — it could not sign the
 * authorization a facilitator executes). A future sent-mode rail declares
 * its validity here; the relay never assumes a shorter one.
 */

export interface PayoutHorizonDeclaration {
  readonly payoutMode?: "manual" | "sent";
  readonly payoutValidityMs?: number;
}

/** True only for a rail that declares its `withdraw()` sends nothing (a manual payout). */
export function isManualPayoutRail(rail: object): boolean {
  return (rail as PayoutHorizonDeclaration).payoutMode === "manual";
}

/**
 * The rail's declared payout validity in ms, or null when it declares none
 * (the caller then applies its own conservative floor — never a shorter one).
 */
export function payoutValidityMsOf(rail: object): number | null {
  const v = (rail as PayoutHorizonDeclaration).payoutValidityMs;
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
}
