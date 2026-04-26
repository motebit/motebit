/**
 * @motebit/crypto-android-keystore — Android Hardware-Backed Keystore
 * Attestation adapter for motebit hardware-attestation claims.
 *
 * The metabolic leaf `@motebit/crypto` delegates to when a
 * `HardwareAttestationClaim` declares `platform: "android_keystore"`.
 * Dep-thin `@motebit/crypto` stays permissive-floor-pure; this
 * package, also on the permissive floor (Apache-2.0), metabolizes
 * `@peculiar/x509` plus a hand-rolled DER walker for the AOSP Key
 * Attestation extension to judge whether a Google-published
 * Hardware Attestation root signed the leaf that the device's
 * Trusted-Environment / StrongBox-backed key signed.
 *
 * Wiring from a consumer:
 *
 * ```ts
 * import { verify } from "@motebit/crypto";
 * import { androidKeystoreVerifier } from "@motebit/crypto-android-keystore";
 *
 * const result = await verify(credential, {
 *   hardwareAttestation: {
 *     android_keystore: androidKeystoreVerifier({
 *       expectedAttestationApplicationId,
 *     }),
 *   },
 * });
 * ```
 *
 * This package exports no global state, no side-effect registrations;
 * the injection is call-site only. Pinned Google attestation roots
 * live in `./google-roots.ts` and are the self-attesting audit
 * surface — a third party that fetches the same roots.json and
 * computes its own SHA-256 should reach the byte-identical
 * fingerprints documented inline.
 */

import type { HardwareAttestationClaim } from "@motebit/protocol";

import { verifyAndroidKeystoreAttestation } from "./verify.js";
import type {
  AndroidKeystoreRevocationSnapshot,
  AndroidKeystoreVerifyOptions,
  AndroidKeystoreVerifyResult,
} from "./verify.js";

export {
  parseKeyDescription,
  SECURITY_LEVEL_SOFTWARE,
  SECURITY_LEVEL_TRUSTED_ENVIRONMENT,
  SECURITY_LEVEL_STRONG_BOX,
  VERIFIED_BOOT_STATE_VERIFIED,
  VERIFIED_BOOT_STATE_SELF_SIGNED,
  VERIFIED_BOOT_STATE_UNVERIFIED,
  VERIFIED_BOOT_STATE_FAILED,
  type RootOfTrust,
  type AuthorizationList,
  type KeyDescription,
} from "./asn1.js";
export {
  ANDROID_KEYSTORE_PLATFORM,
  ANDROID_KEY_ATTESTATION_OID,
  GOOGLE_ANDROID_KEYSTORE_ROOT_RSA_PEM,
  GOOGLE_ANDROID_KEYSTORE_ROOT_ECDSA_PEM,
  DEFAULT_ANDROID_KEYSTORE_TRUST_ANCHORS,
} from "./google-roots.js";
export { verifyAndroidKeystoreAttestation, EMPTY_REVOCATION_SNAPSHOT } from "./verify.js";
export type {
  AndroidKeystoreVerifyOptions,
  AndroidKeystoreVerifyResult,
  AndroidKeystoreVerifyError,
  AndroidKeystoreRevocationSnapshot,
} from "./verify.js";

/**
 * Shape the optional verifier injected into `@motebit/crypto`'s
 * `HardwareAttestationVerifiers.android_keystore` slot carries.
 * Mirrors the sync-or-async return shape the dispatcher supports
 * and extends the canonical shape with `attestation_detail` so
 * callers can introspect chain / extension / binding independently.
 */
export interface AndroidKeystoreVerifierResult {
  readonly valid: boolean;
  readonly platform: "android_keystore";
  readonly errors: ReadonlyArray<{ readonly message: string }>;
  readonly attestation_detail?: AndroidKeystoreVerifyResult;
}

/**
 * VC-subject fields the dispatcher lifts out of the credential and
 * threads through to the verifier. All three participate in the JCS
 * canonical body that derives the attestation challenge; without them
 * the verifier reports the missing channel explicitly rather than
 * silently passing.
 */
export interface AndroidKeystoreVerifierContext {
  readonly expectedMotebitId?: string;
  readonly expectedDeviceId?: string;
  readonly expectedAttestedAt?: number;
}

export interface AndroidKeystoreVerifierConfig {
  /**
   * Bound to the registered Android package's
   * `attestationApplicationId` byte representation (raw OCTET STRING
   * captured at registration time). Required at wiring time so the
   * package binding constraint fires on every claim.
   */
  readonly expectedAttestationApplicationId: Uint8Array;
  /** Optional: override the pinned Google attestation roots. */
  readonly rootPems?: readonly string[];
  /** Optional: caller-supplied revocation snapshot. */
  readonly revocationSnapshot?: AndroidKeystoreRevocationSnapshot;
  /** Optional: allowlist of `verifiedBootState` ENUMERATED values. */
  readonly verifiedBootStateAllowlist?: readonly number[];
  /** Optional: minimum `attestationSecurityLevel` (default TRUSTED_ENVIRONMENT). */
  readonly minSecurityLevel?: number;
  /** Optional: minimum `attestationVersion` (default 3 / Keymaster 3). */
  readonly minAttestationVersion?: number;
  /** Optional: inject a fixed clock for deterministic chain validity. */
  readonly now?: () => number;
}

/**
 * Factory — build an `android_keystore` verifier bound to a registered
 * package. The returned function matches the
 * `HardwareAttestationVerifiers.android_keystore` three-arg signature
 * the `@motebit/crypto` dispatcher calls.
 */
export function androidKeystoreVerifier(
  config: AndroidKeystoreVerifierConfig,
): (
  claim: HardwareAttestationClaim,
  expectedIdentityHex: string,
  context?: AndroidKeystoreVerifierContext,
) => Promise<AndroidKeystoreVerifierResult> {
  return async (claim, expectedIdentityHex, context) => {
    const opts: AndroidKeystoreVerifyOptions = {
      expectedAttestationApplicationId: config.expectedAttestationApplicationId,
      expectedIdentityPublicKeyHex: expectedIdentityHex,
      ...(config.rootPems !== undefined ? { rootPems: config.rootPems } : {}),
      ...(config.revocationSnapshot !== undefined
        ? { revocationSnapshot: config.revocationSnapshot }
        : {}),
      ...(config.verifiedBootStateAllowlist !== undefined
        ? { verifiedBootStateAllowlist: config.verifiedBootStateAllowlist }
        : {}),
      ...(config.minSecurityLevel !== undefined
        ? { minSecurityLevel: config.minSecurityLevel }
        : {}),
      ...(config.minAttestationVersion !== undefined
        ? { minAttestationVersion: config.minAttestationVersion }
        : {}),
      ...(config.now !== undefined ? { now: config.now } : {}),
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
    const detail = await verifyAndroidKeystoreAttestation(claim, opts);
    return {
      valid: detail.valid,
      platform: "android_keystore",
      errors: detail.errors,
      attestation_detail: detail,
    };
  };
}
