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

// Phantom-type brand (the `SensitivityCleared<T>` pattern): the symbol is
// `declare const`-only and never exported, so the ONLY way to obtain a
// `VerifiedGrant` is the single `as VerifiedGrant` cast at the end of
// `verifyGrantForTurn` below. An object literal shaped like a grant is a
// compile error wherever a `VerifiedGrant` is required — the type-level
// twin of `check-money-authority`'s single-producer scan. Zero runtime
// representation: the value is the plain body.
declare const __verifiedGrant: unique symbol;

/**
 * A standing-delegation grant that `verifyGrantForTurn` verified.
 * Constructible only by that function (see the brand above).
 */
export type VerifiedGrant = VerifiedGrantBody & { readonly [__verifiedGrant]: true };

export interface VerifiedGrantBody {
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
 * WHO is presenting a grant: the identity the presenting path authenticated
 * — the runtime's own identity for an owner turn, the transport-verified
 * caller for a foreign one. Never derived from prompt or task content.
 */
export interface GrantPresenterIdentity {
  motebitId: string;
  /**
   * The presenter's Ed25519 public key, hex. When present it must equal the
   * grant's `delegate_public_key` (case-insensitive); a foreign presenter
   * without a verified key is refused upstream (`executeToolGated`).
   */
  publicKeyHex?: string;
}

/**
 * Is `presenter` the grant's delegate? Exact `motebit_id` match, and — when
 * the presenter's key is known — the same key. Pure; exported so a refusing
 * caller can name WHY a presentation conferred nothing.
 */
export function grantDelegateIs(
  grant: Pick<StandingDelegation, "delegate_id" | "delegate_public_key">,
  presenter: GrantPresenterIdentity,
): boolean {
  if (presenter.motebitId === "" || grant.delegate_id !== presenter.motebitId) return false;
  if (presenter.publicKeyHex == null) return true;
  return grant.delegate_public_key.toLowerCase() === presenter.publicKeyHex.toLowerCase();
}

/**
 * Verify a token + grant pair against held revocations, presented by
 * `options.presenter`. Returns the `verifiedGrant` value for the
 * TurnContext, or `null` when any step fails — presenter is not the
 * grant's delegate, wrong signature, expired, revoked, token not a valid
 * tick of the grant, scope/TTL violation.
 */
export async function verifyGrantForTurn(
  token: DelegationToken,
  grant: StandingDelegation,
  revocations: readonly DelegationRevocation[],
  options: { presenter: GrantPresenterIdentity; now?: number },
): Promise<VerifiedGrant | null> {
  const now = options.now ?? Date.now();

  // Presenter binding first: a grant authorizes its delegate and nobody
  // else. A valid grant presented by anyone but its delegate is a stolen
  // capability, so it confers nothing — whatever its signature says.
  if (!grantDelegateIs(grant, options.presenter)) return null;

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

  const body: VerifiedGrantBody = {
    grant_id: grant.grant_id,
    verified_at: now,
    token_issued_at: token.issued_at,
    ...(grant.spend_ceiling !== undefined ? { spend_ceiling: grant.spend_ceiling } : {}),
  };
  // The single authorized production site for the brand.
  return body as VerifiedGrant;
}
