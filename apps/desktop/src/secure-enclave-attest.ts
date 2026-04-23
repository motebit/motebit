/**
 * High-level desktop mint path for `HardwareAttestationClaim`s. Callers
 * pass the motebit's Ed25519 identity public key (hex) plus the session
 * context (motebit_id + device_id); this function produces the claim
 * that belongs in `credentialSubject.hardware_attestation` of any
 * `TrustCredential` / `AgentTrustCredential` the desktop mints for
 * itself.
 *
 * Platform routing:
 *   - macOS + Secure Enclave present → `platform: "secure_enclave"`
 *     claim with a real P-256 receipt signed inside the hardware.
 *     Single atomic Rust call (`se_mint_attestation`) composes the
 *     canonical body AND signs under the freshly-generated SE key.
 *   - Everywhere else (non-macOS, SE probe failed, Rust bridge not
 *     available) → `platform: "software"` sentinel. The
 *     `HardwareAttestationSemiring` scores this at 0.1 (vs 1.0 for
 *     hardware) — honest, not deceptive. The verifier's
 *     `verifyHardwareAttestationClaim` correctly reports "no hardware
 *     channel" for software claims without flagging fraud.
 *
 * The receipt format mirrors `@motebit/crypto`'s
 * `verifyHardwareAttestationClaim`:
 *
 *   receipt = body_base64 + "." + signature_der_base64
 *
 * where `body_base64` decodes to the canonical JSON:
 *
 *   {
 *     "algorithm": "ecdsa-p256-sha256",
 *     "attested_at": <unix-ms>,
 *     "device_id": "...",
 *     "identity_public_key": "<ed25519-hex-lowercase>",
 *     "motebit_id": "...",
 *     "se_public_key": "<p256-compressed-hex>",
 *     "version": "1"
 *   }
 *
 * Keep this module pure — no DOM, no storage, no side effects beyond
 * the Tauri-invoke call to the SE bridge. Deterministic given a fixed
 * `now()`; tests inject a clock.
 */

import type { HardwareAttestationClaim } from "@motebit/sdk";

import { seAvailable, seMintAttestation } from "./secure-enclave-bridge.js";
import type { InvokeFn } from "./tauri-storage.js";

export interface MintAttestationClaimOptions {
  /** Ed25519 identity public key, lowercase hex, 64 chars (32 bytes). */
  readonly identityPublicKeyHex: string;
  readonly motebitId: string;
  readonly deviceId: string;
  /** Injected for test determinism. Defaults to `Date.now`. */
  readonly now?: () => number;
}

/**
 * Build a fresh `HardwareAttestationClaim` for the caller's Ed25519
 * identity. Returns a `platform: "secure_enclave"` claim when the SE
 * is reachable and the round-trip succeeds; otherwise falls back to
 * `platform: "software"`. Never throws in the routine path — the
 * fallback IS the failure mode, by design.
 */
export async function mintAttestationClaim(
  invoke: InvokeFn,
  opts: MintAttestationClaimOptions,
): Promise<HardwareAttestationClaim> {
  const available = await seAvailable(invoke);
  if (!available) return softwareFallback();

  const attestedAt = (opts.now ?? Date.now)();
  try {
    const result = await seMintAttestation(invoke, {
      motebitId: opts.motebitId,
      deviceId: opts.deviceId,
      identityPublicKeyHex: opts.identityPublicKeyHex.toLowerCase(),
      attestedAt,
    });
    return {
      platform: "secure_enclave",
      key_exported: false,
      attestation_receipt: `${result.body_base64}.${result.signature_der_base64}`,
    };
  } catch {
    // The bridge normalizes every error into `SecureEnclaveError` with
    // a typed `reason`. All three reasons are non-fatal by policy:
    //   - `not_supported`    → expected on non-Apple-Silicon hosts
    //   - `permission_denied` → user declined biometric
    //   - `platform_blocked`  → unexpected SE internal error, rare
    // All degrade to the software sentinel — truthful about the lack
    // of hardware backing, never falsely claims anything.
    return softwareFallback();
  }
}

function softwareFallback(): HardwareAttestationClaim {
  return {
    platform: "software",
    key_exported: false,
  };
}
