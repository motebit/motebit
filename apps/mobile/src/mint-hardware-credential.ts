/**
 * Mobile path for minting a hardware-attested `AgentTrustCredential`.
 *
 * Sibling of:
 *   - `apps/desktop/src/mint-hardware-credential.ts` — macOS via Rust /
 *     Tauri.
 *   - `apps/cli/src/subcommands/attest.ts` — Node process, software
 *     claim only.
 *
 * All three delegate the VC envelope + eddsa-jcs-2022 signing to
 * `composeHardwareAttestationCredential` from `@motebit/encryption` —
 * the single source of truth. Only the hardware_attestation claim
 * varies per surface: iOS + Secure Enclave → `platform: "secure_enclave"`
 * with a real ECDSA P-256 receipt, everything else → truthful
 * `platform: "software"` sentinel.
 *
 * Kept pure — no AsyncStorage reads, no React state, no network. The
 * caller (settings tab, slash command, onboarding flow) owns decision-
 * making about when to mint and where to persist the credential.
 * Deterministic given a fixed `now()`; tests inject a clock.
 */

import {
  composeHardwareAttestationCredential,
  type HardwareAttestationCredentialSubject,
  type VerifiableCredential,
} from "@motebit/encryption";
// @motebit/sdk re-exports every @motebit/protocol type; apps consume
// the product vocabulary rather than reaching past it to Layer 0 MIT.
// Enforced by `check-app-primitives`.
import type { HardwareAttestationClaim } from "@motebit/sdk";

import {
  seAvailable,
  seMintAttestation,
  type NativeSecureEnclave,
} from "../modules/expo-secure-enclave/src/ExpoSecureEnclaveModule";

export interface MintHardwareCredentialOptions {
  /** Ed25519 identity public key, lowercase hex (64 chars). */
  readonly identityPublicKeyHex: string;
  /** Ed25519 private key bytes (32 bytes). */
  readonly privateKey: Uint8Array;
  /**
   * Derived from the private key; supplied by caller to avoid a
   * duplicate derivation. Mirrors the desktop signature so the two
   * surfaces feel identical at the call site.
   */
  readonly publicKey: Uint8Array;
  readonly motebitId: string;
  readonly deviceId: string;
  /** Injected for test determinism. Defaults to `Date.now`. */
  readonly now?: () => number;
  /**
   * Injectable native module. Tests pass a fake implementing
   * `{ seAvailable, seMintAttestation }`; production uses the
   * default-loaded Expo module.
   */
  readonly native?: NativeSecureEnclave;
}

/**
 * Mint a hardware-attested self-signed `AgentTrustCredential` on
 * mobile. Routes through the Expo Secure Enclave native module to
 * produce a `platform: "secure_enclave"` claim on iOS hardware (or a
 * truthful `platform: "software"` fallback on simulators / Android /
 * SE-less hardware / user-cancelled biometric), then delegates the VC
 * envelope + eddsa-jcs-2022 signing to
 * `composeHardwareAttestationCredential` — the single source of truth
 * shared with the CLI and desktop.
 */
export async function mintHardwareCredential(
  opts: MintHardwareCredentialOptions,
): Promise<VerifiableCredential<HardwareAttestationCredentialSubject>> {
  const attestation = await mintAttestationClaim(opts);
  const now = (opts.now ?? Date.now)();
  return composeHardwareAttestationCredential({
    publicKey: opts.publicKey,
    publicKeyHex: opts.identityPublicKeyHex,
    privateKey: opts.privateKey,
    hardwareAttestation: attestation,
    now,
  });
}

/**
 * Build a fresh `HardwareAttestationClaim` for the caller's Ed25519
 * identity. Returns a `platform: "secure_enclave"` claim when the SE
 * is reachable and the round-trip succeeds; otherwise falls back to
 * `platform: "software"`. Never throws in the routine path — the
 * fallback IS the failure mode, by design, exactly as on desktop.
 */
export async function mintAttestationClaim(
  opts: MintHardwareCredentialOptions,
): Promise<HardwareAttestationClaim> {
  const available = await seAvailable(opts.native);
  if (!available) return softwareFallback();

  const attestedAt = (opts.now ?? Date.now)();
  try {
    const result = await seMintAttestation(
      {
        motebitId: opts.motebitId,
        deviceId: opts.deviceId,
        identityPublicKeyHex: opts.identityPublicKeyHex.toLowerCase(),
        attestedAt,
      },
      opts.native,
    );
    return {
      platform: "secure_enclave",
      key_exported: false,
      attestation_receipt: `${result.body_base64}.${result.signature_der_base64}`,
    };
  } catch {
    // Every `SecureEnclaveError` reason degrades the same way — a
    // truthful software claim is always safer than a misleading one.
    // Matches `apps/desktop/src/secure-enclave-attest.ts`.
    return softwareFallback();
  }
}

function softwareFallback(): HardwareAttestationClaim {
  return {
    platform: "software",
    key_exported: false,
  };
}
