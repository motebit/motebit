/**
 * Grant verifier — the ONLY producer of `TurnContext.verifiedGrant`.
 *
 * The policy gate's standing-authority invariant
 * (`docs/doctrine/memory-never-confers-authority.md`) lets an R4_MONEY
 * tool call auto-execute only when the turn carries a verified standing
 * grant. This module is the dispatch-layer producer side of that
 * split: given the signed artifacts an inbound delegated task presents
 * — a `DelegationToken` carrying a `grant_id`, the matching
 * `StandingDelegation`, and the locally held `DelegationRevocation`s —
 * it runs the full verification chain from `@motebit/verifier`
 * primitives and returns the `verifiedGrant` value on success, `null`
 * on ANY failure (fail-closed; a partial verification never confers
 * authority).
 *
 * Nothing else may assign `verifiedGrant` (enforced by
 * `check-money-authority`): not model output, not recalled memory, not
 * trust level, not configuration. Memory may *point at* a grant_id;
 * only this verification *is* authority.
 *
 * Scope today: no caller presents tokens yet and no grant store exists —
 * the relay revocation feed + grant-store plumbing stay deferred behind
 * the named triggers in `docs/proposals/standing-delegation-v1.md` §6b.
 * Net effect until then: R4 tools never auto-execute, which IS the
 * invariant.
 */

import type {
  StandingDelegation,
  DelegationToken,
  DelegationRevocation,
  SpendCeilingV1,
} from "@motebit/protocol";
import {
  verifyStandingDelegation,
  verifyTokenAgainstGrant,
  findGrantRevocation,
} from "@motebit/crypto";

export interface VerifiedGrant {
  grant_id: string;
  verified_at: number;
  /**
   * The verified tick token's signed `issued_at` — the monotonic replay
   * nonce the blast-radius enforcer consumes (`high_water_nonce`). One
   * tick token meters at most ONE money action: a second action under the
   * same token replays the nonce and is denied. Signature-derived: this
   * value comes from the token the chain just verified, never from args.
   */
  token_issued_at: number;
  /**
   * The verified grant's signed `spend_ceiling` (standing-delegation@1.2),
   * copied verbatim from the artifact this verification proved. Carrying
   * it here is what lets the dispatch seam enforce spend against the
   * DELEGATOR'S commitment without re-holding the grant — and since this
   * module is the only `verifiedGrant` producer (`check-money-authority`),
   * the ceiling provably originates from a verified signed body (spec
   * §3.3 rule 2). Absent ⇒ the grant carries no ceiling ⇒ enforcers deny
   * `ceiling_absent` and no money moves.
   */
  spend_ceiling?: SpendCeilingV1;
}

/**
 * Verify a token + grant pair against held revocations. Returns the
 * `verifiedGrant` value for the TurnContext, or `null` when any step
 * fails — wrong signature, expired, revoked, token not a valid tick of
 * the grant, scope/TTL violation.
 */
export async function verifyGrantForTurn(
  token: DelegationToken,
  grant: StandingDelegation,
  revocations: readonly DelegationRevocation[],
  options?: { now?: number },
): Promise<VerifiedGrant | null> {
  const now = options?.now ?? Date.now();

  // Revocation check first — build the isRevoked seam from the held
  // feed via the binding-safe helper (matches grant_id AND the
  // delegator key, so a third party cannot revoke someone else's grant).
  const revocation = await findGrantRevocation(grant, revocations);
  const revokedIds = new Set(revocation ? [grant.grant_id] : []);
  const isRevoked = (grantId: string) => revokedIds.has(grantId);

  const grantValid = await verifyStandingDelegation(grant, { now, isRevoked });
  if (!grantValid) return null;

  const tokenResult = await verifyTokenAgainstGrant(token, grant, { now, isRevoked });
  if (!tokenResult.valid) return null;

  return {
    grant_id: grant.grant_id,
    verified_at: now,
    token_issued_at: token.issued_at,
    ...(grant.spend_ceiling !== undefined ? { spend_ceiling: grant.spend_ceiling } : {}),
  };
}
