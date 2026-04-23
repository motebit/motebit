/**
 * Desktop path for minting a hardware-attested `AgentTrustCredential`.
 *
 * Composes the pieces already shipped:
 *   1. `mintAttestationClaim` (`./secure-enclave-attest.ts`) — calls the
 *      Rust SE bridge, returns a `platform: "secure_enclave"`
 *      `HardwareAttestationClaim` when an Apple Secure Enclave is
 *      available; graceful `platform: "software"` fallback otherwise.
 *   2. `mintTpmAttestationClaim` (`./tpm-attest.ts`) — calls the Rust
 *      TPM bridge on Windows / Linux hosts; returns a
 *      `platform: "tpm"` claim when the TPM round-trip succeeds, or
 *      `null` when the TPM is unavailable so the cascade falls through.
 *   3. `signVerifiableCredential` (`@motebit/encryption`) — W3C
 *      `eddsa-jcs-2022` self-signed VC with the claim embedded in
 *      `credentialSubject.hardware_attestation`.
 *
 * Cascade order: SE (macOS) → TPM (Windows / Linux) → software
 * sentinel. The SE probe returns `false` on non-macOS hosts, so the
 * TPM probe takes over there. The TPM probe returns `false` on macOS
 * and on hosts without `tss-esapi` linked, so the cascade falls
 * through to the truthful `platform: "software"` claim. The order
 * mirrors the platform-adapter layering in
 * `docs/doctrine/hardware-attestation.md`.
 *
 * The output is compatible with `@motebit/verifier`'s `verify()`
 * pipeline — piping the JSON through `motebit-verify` produces
 * `hardware: secure_enclave ✓` on an Apple-Silicon host with an
 * operational Enclave, `hardware: tpm ✓` on a TPM-equipped Windows /
 * Linux host, or `hardware: software ✗` (truthful, no deception)
 * when neither path is available.
 *
 * Why this isn't in `@motebit/encryption`. The helper is a small
 * composer (read identity → mint claim → sign VC) but it binds to
 * Tauri's `InvokeFn` type to reach the Rust bridge. Keeping it in
 * `apps/desktop/src/` preserves the encryption package's layer
 * purity (no Tauri dependency) and matches the CLI's own local
 * `buildAttestationCredential` shape — each surface stitches the
 * same primitives for its own identity-loading conventions.
 *
 * Kept pure: no DOM access, no file I/O, no storage writes. The
 * caller decides what to do with the returned JSON — save to disk,
 * show in a chat message, copy to clipboard, upload to the relay.
 */

import {
  composeHardwareAttestationCredential,
  type HardwareAttestationCredentialSubject,
  type VerifiableCredential,
} from "@motebit/encryption";

import type { HardwareAttestationClaim } from "@motebit/sdk";

import { mintAttestationClaim } from "./secure-enclave-attest.js";
import { mintTpmAttestationClaim } from "./tpm-attest.js";
import type { InvokeFn } from "./tauri-storage.js";

export interface MintHardwareCredentialOptions {
  /** Tauri invoke — routes to the Rust SE bridge. */
  readonly invoke: InvokeFn;
  /** Ed25519 identity public key, lowercase hex (64 chars). */
  readonly identityPublicKeyHex: string;
  /** Ed25519 private key bytes (32 bytes). */
  readonly privateKey: Uint8Array;
  /** Derived from the private key; supplied by caller to avoid a duplicate derivation. */
  readonly publicKey: Uint8Array;
  readonly motebitId: string;
  readonly deviceId: string;
  /** Injected for test determinism. */
  readonly now?: () => number;
}

/**
 * Mint a hardware-attested self-signed `AgentTrustCredential`.
 *
 * Desktop-surface wrapper: routes through the Rust Secure Enclave
 * bridge to produce a `platform: "secure_enclave"` claim (or a truthful
 * `platform: "software"` fallback), then delegates the VC envelope +
 * eddsa-jcs-2022 signing to `composeHardwareAttestationCredential` —
 * the single source of truth shared with the CLI's `motebit attest`.
 */
export async function mintHardwareCredential(
  opts: MintHardwareCredentialOptions,
): Promise<VerifiableCredential<HardwareAttestationCredentialSubject>> {
  // Cascade: SE (macOS) → TPM (Windows / Linux) → software sentinel.
  // Each strategy is silent on platforms where it doesn't apply; the
  // first to produce a hardware-backed claim wins. `mintAttestationClaim`
  // preserves its existing contract (always returns a claim, falling
  // back to `software` internally); TPM sits between SE's macOS path
  // and SE's software fallback by intercepting when the SE claim
  // degrades to software AND a TPM is reachable.
  const seClaim = await mintAttestationClaim(opts.invoke, {
    identityPublicKeyHex: opts.identityPublicKeyHex,
    motebitId: opts.motebitId,
    deviceId: opts.deviceId,
    ...(opts.now && { now: opts.now }),
  });

  let attestation: HardwareAttestationClaim = seClaim;
  if (seClaim.platform === "software") {
    const tpmClaim = await mintTpmAttestationClaim(opts.invoke, {
      identityPublicKeyHex: opts.identityPublicKeyHex,
      motebitId: opts.motebitId,
      deviceId: opts.deviceId,
      ...(opts.now && { now: opts.now }),
    });
    if (tpmClaim) attestation = tpmClaim;
  }

  const now = (opts.now ?? Date.now)();
  return composeHardwareAttestationCredential({
    publicKey: opts.publicKey,
    publicKeyHex: opts.identityPublicKeyHex,
    privateKey: opts.privateKey,
    hardwareAttestation: attestation,
    now,
  });
}
