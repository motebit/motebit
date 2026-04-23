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
) => Promise<DeviceCheckVerifyResult> {
  return async (claim, expectedIdentityHex) => {
    const opts: AppAttestVerifyOptions = {
      expectedBundleId: config.expectedBundleId,
      expectedIdentityPublicKeyHex: expectedIdentityHex,
      ...(config.rootPem !== undefined ? { rootPem: config.rootPem } : {}),
      ...(config.now !== undefined ? { now: config.now } : {}),
      ...(config.expectedFmt !== undefined ? { expectedFmt: config.expectedFmt } : {}),
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
