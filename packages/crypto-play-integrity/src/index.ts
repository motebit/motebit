/**
 * @motebit/crypto-play-integrity — Google Play Integrity JWT verifier
 * for motebit hardware-attestation claims.
 *
 * The metabolic leaf `@motebit/crypto` delegates to when a
 * `HardwareAttestationClaim` declares `platform: "play_integrity"`.
 * Dep-thin `@motebit/crypto` stays permissive-floor-pure; this package,
 * also on the permissive floor (Apache-2.0), metabolizes `@noble/curves`
 * (ES256) + `node:crypto` (RS256) to judge whether Google's Play Integrity
 * JWT chain-verifies against the pinned JWKS and binds the caller's
 * Ed25519 identity.
 *
 * Wiring from a consumer:
 *
 * ```ts
 * import { verify } from "@motebit/crypto";
 * import { playIntegrityVerifier } from "@motebit/crypto-play-integrity";
 *
 * const result = await verify(credential, {
 *   hardwareAttestation: {
 *     playIntegrity: playIntegrityVerifier({ expectedPackageName: "com.motebit.mobile" }),
 *   },
 * });
 * ```
 *
 * This package exports no global state, no side-effect registrations;
 * the injection is call-site only.
 */

import type { HardwareAttestationClaim } from "@motebit/protocol";

import type { GoogleJwks } from "./google-jwks.js";
import type { PlayIntegrityVerifyOptions, PlayIntegrityVerifyResult } from "./verify.js";
import { verifyPlayIntegrityToken } from "./verify.js";

export { GOOGLE_PLAY_INTEGRITY_JWKS, type GoogleJwk, type GoogleJwks } from "./google-jwks.js";
export { decodeJwt, verifyJwtSignature } from "./jwt.js";
export type { DecodedJwt, JwtHeader, PlayIntegrityPayload } from "./jwt.js";
export { verifyPlayIntegrityToken } from "./verify.js";
export type {
  PlayIntegrityVerifyOptions,
  PlayIntegrityVerifyResult,
  PlayIntegrityVerifyError,
} from "./verify.js";

/**
 * Shape the optional verifier injected into `@motebit/crypto`'s
 * `HardwareAttestationVerifiers.playIntegrity` slot carries — mirrors
 * the sync-or-async return shape the dispatcher supports.
 */
export interface PlayIntegrityVerifyDispatchResult {
  readonly valid: boolean;
  readonly platform: "play_integrity";
  readonly errors: ReadonlyArray<{ readonly message: string }>;
  readonly attestation_detail?: PlayIntegrityVerifyResult;
}

/**
 * Context fields the dispatcher lifts out of the credential subject and
 * threads through to the verifier. All four participate in the JCS
 * body the Kotlin mint path hashes into the Play Integrity nonce, so
 * the verifier re-derives the body from them and byte-compares against
 * `payload.nonce` (see `verify.ts`, step 4).
 *
 * Each field optional: a caller that omits one loses the
 * identity-binding channel but still gets JWT-signature / package /
 * device-integrity results — the verifier reports the missing channel
 * explicitly rather than silently passing.
 */
export interface PlayIntegrityVerifierContext {
  readonly expectedMotebitId?: string;
  readonly expectedDeviceId?: string;
  readonly expectedAttestedAt?: number;
}

export interface PlayIntegrityVerifierConfig {
  /** Android package the Play Integrity verdict must bind to. */
  readonly expectedPackageName: string;
  /** Optional: override the pinned Google JWKS (tests fabricate their own). */
  readonly pinnedJwks?: GoogleJwks;
  /**
   * Optional: relax the device-integrity floor (e.g. for sideloaded dev
   * builds). Defaults to the strict `"MEETS_DEVICE_INTEGRITY"`.
   */
  readonly requiredDeviceIntegrity?: string;
}

/**
 * Factory — build a `playIntegrity` verifier bound to a specific
 * package and (optionally) a test JWKS / relaxed integrity floor. The
 * returned function matches the
 * `HardwareAttestationVerifiers.playIntegrity` signature the
 * `@motebit/crypto` dispatcher expects.
 *
 * Signature widened to match the App Attest factory's third-`context`
 * convention — the dispatcher passes `(claim, expectedIdentityHex,
 * context?)`, and the context carries the motebit_id / device_id /
 * attested_at fields that participate in the nonce body. Older
 * injected verifiers that ignore the third argument still satisfy the
 * type.
 *
 * Kept as a factory (rather than a free function) so the consumer's
 * package name / JWKS override / floor is captured once at wiring time,
 * not repeated at every call site — every subsequent `verify()` call
 * inherits the same binding.
 */
export function playIntegrityVerifier(
  config: PlayIntegrityVerifierConfig,
): (
  claim: HardwareAttestationClaim,
  expectedIdentityHex: string,
  context?: PlayIntegrityVerifierContext,
) => Promise<PlayIntegrityVerifyDispatchResult> {
  return async (claim, expectedIdentityHex, context) => {
    const opts: PlayIntegrityVerifyOptions = {
      expectedPackageName: config.expectedPackageName,
      expectedIdentityPublicKeyHex: expectedIdentityHex,
      ...(config.pinnedJwks !== undefined ? { pinnedJwks: config.pinnedJwks } : {}),
      ...(config.requiredDeviceIntegrity !== undefined
        ? { requiredDeviceIntegrity: config.requiredDeviceIntegrity }
        : {}),
      ...(context?.expectedMotebitId !== undefined
        ? { expectedMotebitId: context.expectedMotebitId }
        : {}),
      ...(context?.expectedDeviceId !== undefined
        ? { expectedDeviceId: context.expectedDeviceId }
        : {}),
      ...(context?.expectedAttestedAt !== undefined
        ? { expectedAttestedAt: context.expectedAttestedAt }
        : {}),
    };
    const detail = await verifyPlayIntegrityToken(claim, opts);
    return {
      valid: detail.valid,
      platform: "play_integrity",
      errors: detail.errors,
      attestation_detail: detail,
    };
  };
}
