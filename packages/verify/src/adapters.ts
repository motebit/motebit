/**
 * Bundled-adapter wiring — the core reason this package exists.
 *
 * `@motebit/verifier` (Apache-2.0) accepts an optional
 * `HardwareAttestationVerifiers` record but wires none of the leaves
 * itself; that keeps it dep-thin. This Apache-2.0 aggregator imports
 * every canonical leaf (`@motebit/crypto-appattest`,
 * `@motebit/crypto-android-keystore`, `@motebit/crypto-tpm`,
 * `@motebit/crypto-webauthn`) and produces a single
 * `HardwareAttestationVerifiers` object the CLI hands to `verifyFile`.
 * Any credential whose subject carries a hardware-attestation claim
 * for any of the canonical platforms now verifies end-to-end — chain
 * + nonce + bundle + identity — instead of returning the
 * `adapter not yet shipped` sentinel.
 *
 * Defaults match motebit's canonical app identifiers:
 *   - App Attest      → bundleId `com.motebit.mobile`
 *   - Android Keystore → caller-supplied attestationApplicationId (no
 *                       canonical default — the bytes are
 *                       deterministic from `(packageName, signing-cert
 *                       SHA-256)` known at the operator's build time;
 *                       no analogous "magic string" fits)
 *   - WebAuthn        → rpId `motebit.com`
 *   - TPM             → the pinned vendor roots in `@motebit/crypto-tpm`
 *
 * Operators verifying credentials from a different motebit deployment
 * can override any of these via the config parameter.
 *
 * Note: `@motebit/crypto-play-integrity` was deprecated 2026-04-26 and
 * fully removed 2026-05-03. The structural reason — Google publishes no
 * global Play Integrity JWKS, so the package can't satisfy motebit's
 * third-party-verifiability invariant — is captured in
 * `docs/doctrine/hardware-attestation.md` § "Three architectural
 * categories". Android attestation lives entirely on
 * `@motebit/crypto-android-keystore` now.
 */
import type { HardwareAttestationVerifiers } from "@motebit/crypto";
import { androidKeystoreVerifier } from "@motebit/crypto-android-keystore";
import { deviceCheckVerifier, APPLE_APPATTEST_ROOT_PEM } from "@motebit/crypto-appattest";
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
   * Android Hardware-Backed Keystore Attestation — `attestationApplicationId`
   * bytes (raw, captured-from-leaf-cert form) the leaf cert MUST carry.
   * Required at wiring time when verifying Android-Keystore-attested
   * credentials. Operators compute this at build time as
   * `(packageName, signing-cert SHA-256)` and pin the result here; the
   * verifier byte-compares against the leaf's KeyDescription extension.
   * Absent → the Android Keystore arm is not wired and the canonical
   * dispatcher returns "verifier not wired".
   */
  readonly androidKeystoreExpectedAttestationApplicationId?: Uint8Array;
  /**
   * Android Hardware-Backed Keystore Attestation — override the pinned
   * Google attestation roots. Defaults to
   * `DEFAULT_ANDROID_KEYSTORE_TRUST_ANCHORS` (RSA-4096 + ECDSA P-384,
   * covering both pre- and post-rotation device fleets).
   */
  readonly androidKeystoreRootPems?: ReadonlyArray<string>;
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
 * Build the full `HardwareAttestationVerifiers` object covering every
 * canonical platform adapter. Pass the result to `verifyFile`:
 *
 * ```ts
 * import { verifyFile } from "@motebit/verifier";
 * import { buildHardwareVerifiers } from "@motebit/verify";
 *
 * const result = await verifyFile("cred.json", {
 *   hardwareAttestation: buildHardwareVerifiers({
 *     androidKeystoreExpectedAttestationApplicationId: appIdBytes,
 *   }),
 * });
 * ```
 *
 * Pure function: every dependency is captured at factory time and the
 * returned verifiers are idempotent across calls. The Android Keystore
 * arm is wired only when `androidKeystoreExpectedAttestationApplicationId`
 * is supplied — there is no canonical default for the leaf-cert
 * package binding, by design.
 */
export function buildHardwareVerifiers(
  config?: HardwareVerifierBundleConfig,
): HardwareAttestationVerifiers {
  const appAttestBundleId = config?.appAttestBundleId ?? DEFAULT_BUNDLE_ID;
  const webauthnRpId = config?.webauthnRpId ?? DEFAULT_WEBAUTHN_RP_ID;

  const verifiers: Mutable<HardwareAttestationVerifiers> = {
    deviceCheck: deviceCheckVerifier({
      expectedBundleId: appAttestBundleId,
      rootPem: config?.appAttestRootPem ?? APPLE_APPATTEST_ROOT_PEM,
    }),
    tpm: tpmVerifier({
      ...(config?.tpmRootPems !== undefined ? { rootPems: config.tpmRootPems } : {}),
    }),
    webauthn: webauthnVerifier({
      expectedRpId: webauthnRpId,
      rootPems: config?.webauthnRootPems ?? DEFAULT_FIDO_ROOTS,
    }),
  };

  // Android Keystore is wired only when the operator has supplied the
  // expected `attestationApplicationId`. Leaving it unwired makes the
  // canonical dispatcher report "verifier not wired" with a clear
  // message — preferable to passing a placeholder that would
  // false-reject every real claim.
  if (config?.androidKeystoreExpectedAttestationApplicationId !== undefined) {
    verifiers.androidKeystore = androidKeystoreVerifier({
      expectedAttestationApplicationId: config.androidKeystoreExpectedAttestationApplicationId,
      ...(config.androidKeystoreRootPems !== undefined
        ? { rootPems: config.androidKeystoreRootPems }
        : {}),
    });
  }

  return verifiers;
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
