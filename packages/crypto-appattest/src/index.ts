/**
 * @motebit/crypto-appattest — Apple App Attest chain-verification
 * adapter for motebit hardware-attestation claims.
 *
 * The metabolic leaf `@motebit/crypto` delegates to when a
 * `HardwareAttestationClaim` declares `platform: "device_check"`.
 * Dep-thin `@motebit/crypto` stays MIT-pure; this BSL package
 * metabolizes `@peculiar/x509` + `cbor2` to judge whether Apple's
 * published CA rooted the leaf that signed the caller's attestation.
 *
 * Wiring from a consumer:
 *
 * ```ts
 * import { verify } from "@motebit/crypto";
 * import { deviceCheckVerifier } from "@motebit/crypto-appattest";
 *
 * const result = await verify(credential, {
 *   hardwareAttestation: { deviceCheck: deviceCheckVerifier({ expectedBundleId: "com.motebit.app" }) },
 * });
 * ```
 *
 * This package exports no global state, no side-effect registrations;
 * the injection is call-site only.
 */

import type { HardwareAttestationClaim } from "@motebit/protocol";

import type { AppAttestVerifyOptions, AppAttestVerifyResult } from "./verify.js";
import { verifyAppAttestReceipt } from "./verify.js";

export { parseAppAttestCbor, type AppAttestCbor } from "./cbor.js";
export { APPLE_APPATTEST_ROOT_PEM, APPLE_APPATTEST_FMT } from "./apple-root.js";
export { verifyAppAttestReceipt } from "./verify.js";
export type {
  AppAttestVerifyOptions,
  AppAttestVerifyResult,
  AppAttestVerifyError,
} from "./verify.js";

/**
 * Shape the optional verifier injected into `@motebit/crypto`'s
 * `HardwareAttestationVerifiers.deviceCheck` slot carries — mirrors the
 * sync-or-async return shape the dispatcher supports.
 */
export interface DeviceCheckVerifyResult {
  readonly valid: boolean;
  readonly platform: "device_check";
  readonly errors: ReadonlyArray<{ readonly message: string }>;
  readonly attestation_detail?: AppAttestVerifyResult;
}

/**
 * Context fields the dispatcher lifts out of the credential subject and
 * threads through to the verifier. All three participate in the JCS
 * body the Swift mint path signs, so the verifier re-derives the body
 * from them and byte-compares against the transmitted clientDataHash
 * (see `verify.ts::buildCanonicalAttestationBody`).
 *
 * All fields optional: a caller that omits one loses the
 * identity-binding channel but still gets chain / nonce / bundle
 * binding results — the verifier reports the missing channel
 * explicitly rather than silently passing.
 */
export interface DeviceCheckVerifierContext {
  readonly expectedMotebitId?: string;
  readonly expectedDeviceId?: string;
  readonly expectedAttestedAt?: number;
}

export interface DeviceCheckVerifierConfig {
  /** iOS bundle identifier the receipt must bind to. */
  readonly expectedBundleId: string;
  /** Optional: override the pinned Apple root (tests fabricate their own). */
  readonly rootPem?: string;
  /** Optional: inject a fixed clock for deterministic chain-validity checks. */
  readonly now?: () => number;
  /** Optional: override the accepted attestation-format string. */
  readonly expectedFmt?: string;
}

/**
 * Factory — build a `deviceCheck` verifier bound to a specific bundle
 * and (optionally) a test root / clock / fmt. The returned function
 * matches the `HardwareAttestationVerifiers.deviceCheck` signature the
 * `@motebit/crypto` dispatcher expects.
 *
 * Signature widened 2026-04-22: the third `context` parameter carries
 * the motebit_id / device_id / attested_at fields the VC subject
 * declares so the verifier can re-derive the JCS body Apple signed
 * over and cryptographically bind it to the caller's Ed25519 identity
 * (see `verify.ts` step 6). Pre-existing call sites that pass only
 * `(claim, expectedIdentityHex)` still compile — the context is
 * optional — but they lose the identity-binding channel and receive
 * `identity_bound: false` in the result.
 *
 * Kept as a factory rather than a free function so the consumer's
 * bundle ID is captured once at wiring time, not repeated at every
 * call site — every subsequent `verify()` call inherits the same
 * binding.
 */
export function deviceCheckVerifier(
  config: DeviceCheckVerifierConfig,
): (
  claim: HardwareAttestationClaim,
  expectedIdentityHex: string,
  context?: DeviceCheckVerifierContext,
) => Promise<DeviceCheckVerifyResult> {
  return async (claim, expectedIdentityHex, context) => {
    const opts: AppAttestVerifyOptions = {
      expectedBundleId: config.expectedBundleId,
      expectedIdentityPublicKeyHex: expectedIdentityHex,
      ...(config.rootPem !== undefined ? { rootPem: config.rootPem } : {}),
      ...(config.now !== undefined ? { now: config.now } : {}),
      ...(config.expectedFmt !== undefined ? { expectedFmt: config.expectedFmt } : {}),
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
    const detail = await verifyAppAttestReceipt(claim, opts);
    return {
      valid: detail.valid,
      platform: "device_check",
      errors: detail.errors,
      attestation_detail: detail,
    };
  };
}
