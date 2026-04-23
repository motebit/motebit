/**
 * Bundled-adapter wiring — the core reason this package exists.
 *
 * `@motebit/verifier` (Apache-2.0) accepts an optional
 * `HardwareAttestationVerifiers` record but wires none of the four
 * leaves itself; that keeps it dep-thin. This Apache-2.0 aggregator
 * imports every leaf (`@motebit/crypto-appattest`,
 * `@motebit/crypto-tpm`, `@motebit/crypto-play-integrity`,
 * `@motebit/crypto-webauthn`) and
 * produces a single `HardwareAttestationVerifiers` object the CLI
 * hands to `verifyFile`. Any credential whose subject carries a
 * hardware-attestation claim for any of the four platforms now
 * verifies end-to-end — chain + nonce + bundle + identity — instead
 * of returning the `adapter not yet shipped` sentinel.
 *
 * Defaults match motebit's canonical app identifiers:
 *   - App Attest    → bundleId `com.motebit.mobile`
 *   - Play Integrity → packageName `com.motebit.mobile`
 *   - WebAuthn      → rpId `motebit.com`
 *   - TPM           → the pinned vendor roots in `@motebit/crypto-tpm`
 *
 * Operators verifying credentials from a different motebit deployment
 * can override any of these via the config parameter.
 */
import type { HardwareAttestationVerifiers } from "@motebit/crypto";
import { deviceCheckVerifier, APPLE_APPATTEST_ROOT_PEM } from "@motebit/crypto-appattest";
import { playIntegrityVerifier, type GoogleJwks } from "@motebit/crypto-play-integrity";
import { tpmVerifier } from "@motebit/crypto-tpm";
import { webauthnVerifier, DEFAULT_FIDO_ROOTS } from "@motebit/crypto-webauthn";

export interface HardwareVerifierBundleConfig {
  /**
   * Apple App Attest — bundle ID the attested iOS app was built with.
   * Defaults to `com.motebit.mobile`. Override when verifying credentials
   * minted by a different motebit iOS build.
   */
  readonly appAttestBundleId?: string;
  /**
   * Apple App Attest — override the pinned Apple App Attestation Root
   * CA PEM. Defaults to the constant in `@motebit/crypto-appattest`.
   * Exposed only so test fabrications can exercise the chain-validation
   * code path with a fabricated root.
   */
  readonly appAttestRootPem?: string;
  /**
   * Google Play Integrity — Android package name the attested app was
   * built with. Defaults to `com.motebit.mobile`.
   */
  readonly playIntegrityPackageName?: string;
  /**
   * Google Play Integrity — override the pinned JWKS. Fail-closed by
   * default (see `@motebit/crypto-play-integrity` doctrine); operators
   * pin real keys here once the production key-acquisition path lands.
   */
  readonly playIntegrityPinnedJwks?: GoogleJwks;
  /**
   * Google Play Integrity — relax the device-integrity floor. Defaults
   * to the strict `"MEETS_DEVICE_INTEGRITY"`. Development / sideloaded
   * scenarios may lower to `"MEETS_BASIC_INTEGRITY"`.
   */
  readonly playIntegrityRequiredDeviceIntegrity?: string;
  /**
   * WebAuthn — Relying Party ID the credential was minted for.
   * Defaults to `motebit.com`.
   */
  readonly webauthnRpId?: string;
  /**
   * WebAuthn — override the pinned FIDO root set. Defaults to
   * `DEFAULT_FIDO_ROOTS` (Apple Anonymous Attestation, Yubico, Microsoft).
   */
  readonly webauthnRootPems?: ReadonlyArray<string>;
  /**
   * TPM — override the pinned vendor root PEMs. Defaults to the four
   * TPM-vendor roots in `@motebit/crypto-tpm` (Infineon, Nuvoton,
   * STMicro, Intel PTT).
   */
  readonly tpmRootPems?: ReadonlyArray<string>;
}

/** Motebit's canonical iOS / Android app identifier. */
const DEFAULT_BUNDLE_ID = "com.motebit.mobile";
/** Motebit's canonical Relying Party ID for WebAuthn credentials. */
const DEFAULT_WEBAUTHN_RP_ID = "motebit.com";

/**
 * Build the full `HardwareAttestationVerifiers` object covering all four
 * platform adapters. Pass the result to `verifyFile`:
 *
 * ```ts
 * import { verifyFile } from "@motebit/verifier";
 * import { buildHardwareVerifiers } from "@motebit/verify";
 *
 * const result = await verifyFile("cred.json", {
 *   hardwareAttestation: buildHardwareVerifiers(),
 * });
 * ```
 *
 * Pure function: every dependency is captured at factory time and the
 * returned verifiers are idempotent across calls.
 */
export function buildHardwareVerifiers(
  config?: HardwareVerifierBundleConfig,
): HardwareAttestationVerifiers {
  const appAttestBundleId = config?.appAttestBundleId ?? DEFAULT_BUNDLE_ID;
  const playIntegrityPackageName = config?.playIntegrityPackageName ?? DEFAULT_BUNDLE_ID;
  const webauthnRpId = config?.webauthnRpId ?? DEFAULT_WEBAUTHN_RP_ID;

  return {
    deviceCheck: deviceCheckVerifier({
      expectedBundleId: appAttestBundleId,
      rootPem: config?.appAttestRootPem ?? APPLE_APPATTEST_ROOT_PEM,
    }),
    tpm: tpmVerifier({
      ...(config?.tpmRootPems !== undefined ? { rootPems: config.tpmRootPems } : {}),
    }),
    playIntegrity: playIntegrityVerifier({
      expectedPackageName: playIntegrityPackageName,
      ...(config?.playIntegrityPinnedJwks !== undefined
        ? { pinnedJwks: config.playIntegrityPinnedJwks }
        : {}),
      ...(config?.playIntegrityRequiredDeviceIntegrity !== undefined
        ? { requiredDeviceIntegrity: config.playIntegrityRequiredDeviceIntegrity }
        : {}),
    }),
    webauthn: webauthnVerifier({
      expectedRpId: webauthnRpId,
      rootPems: config?.webauthnRootPems ?? DEFAULT_FIDO_ROOTS,
    }),
  };
}
