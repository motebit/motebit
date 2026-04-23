/**
 * High-level desktop mint path for `HardwareAttestationClaim`s on
 * Windows / Linux TPM hosts.
 *
 * Callers pass the motebit's Ed25519 identity public key (hex) plus
 * the session context (motebit_id + device_id); this function produces
 * the `platform: "tpm"` claim that belongs in
 * `credentialSubject.hardware_attestation` of any
 * `TrustCredential` / `AgentTrustCredential` the desktop mints when
 * the host has a TPM. Callers that also want the macOS Secure Enclave
 * path compose this function behind `mintAttestationClaim` — see
 * `mint-hardware-credential.ts`.
 *
 * Receipt format mirrors `@motebit/crypto-tpm`'s `verifyTpmQuote`:
 *
 *   receipt = tpms_attest_b64 + "." +
 *             signature_b64 + "." +
 *             ak_cert_der_b64 + "." +
 *             intermediates_comma_joined_b64
 *
 * Each part is base64url-no-pad. The fourth part is either empty
 * (AK chains directly to a pinned root) or a `,`-joined list of
 * base64url-encoded DER intermediates in leaf-proximal-first order.
 *
 * Keep this module pure — no DOM, no storage, no side effects beyond
 * the Tauri-invoke call to the TPM bridge. Deterministic given a
 * fixed `now()`; tests inject a clock.
 */

import type { HardwareAttestationClaim } from "@motebit/sdk";

import { tpmAvailable, tpmMintQuote } from "./tpm-bridge.js";
import type { InvokeFn } from "./tauri-storage.js";

export interface MintTpmAttestationClaimOptions {
  /** Ed25519 identity public key, lowercase hex, 64 chars (32 bytes). */
  readonly identityPublicKeyHex: string;
  readonly motebitId: string;
  readonly deviceId: string;
  /** Injected for test determinism. Defaults to `Date.now`. */
  readonly now?: () => number;
}

/**
 * Build a `platform: "tpm"` `HardwareAttestationClaim` when the host's
 * TPM is reachable and the round-trip succeeds. Returns `null` when the
 * TPM is unavailable so the outer mint cascade can fall through to the
 * next platform (macOS Secure Enclave) or to the `software` sentinel.
 *
 * Unlike the Secure Enclave equivalent, this function does not itself
 * emit a `platform: "software"` fallback — the caller owns the cascade
 * so macOS hosts don't silently emit `tpm` when `tpm_available` is
 * mis-reported. Returning `null` keeps the fallback decision at the
 * composition layer in `mint-hardware-credential.ts`.
 */
export async function mintTpmAttestationClaim(
  invoke: InvokeFn,
  opts: MintTpmAttestationClaimOptions,
): Promise<HardwareAttestationClaim | null> {
  const available = await tpmAvailable(invoke);
  if (!available) return null;

  const attestedAt = (opts.now ?? Date.now)();
  try {
    const result = await tpmMintQuote(invoke, {
      motebitId: opts.motebitId,
      deviceId: opts.deviceId,
      identityPublicKeyHex: opts.identityPublicKeyHex.toLowerCase(),
      attestedAt,
    });
    return {
      platform: "tpm",
      key_exported: false,
      attestation_receipt: [
        result.tpms_attest_base64,
        result.signature_base64,
        result.ak_cert_der_base64,
        result.intermediates_comma_joined_base64,
      ].join("."),
    };
  } catch {
    // The bridge normalizes every error into `TpmError` with a typed
    // `reason`. All three reasons mean "no TPM path this call":
    //   - `not_supported`    → no tss-esapi, macOS, or no TPM present
    //   - `permission_denied` → OS-level TPM access denied
    //   - `platform_blocked`  → unexpected TPM internal error, rare
    // Return `null` so the outer cascade picks the next strategy.
    return null;
  }
}
