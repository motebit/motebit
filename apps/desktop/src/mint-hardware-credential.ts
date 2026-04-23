/**
 * Desktop path for minting a hardware-attested `AgentTrustCredential`.
 *
 * Composes the pieces already shipped:
 *   1. `mintAttestationClaim` (`./secure-enclave-attest.ts`) — calls the
 *      Rust SE bridge, returns a `platform: "secure_enclave"`
 *      `HardwareAttestationClaim` when an Apple Secure Enclave is
 *      available; graceful `platform: "software"` fallback otherwise.
 *   2. `signVerifiableCredential` (`@motebit/encryption`) — W3C
 *      `eddsa-jcs-2022` self-signed VC with the claim embedded in
 *      `credentialSubject.hardware_attestation`.
 *
 * The output is compatible with `@motebit/verifier`'s `verify()`
 * pipeline — piping the JSON through `motebit-verify` produces
 * `hardware: secure_enclave ✓` on an Apple-Silicon host with an
 * operational Enclave, or `hardware: software ✗` (truthful, no
 * deception) when the host lacks an Enclave or the user declined the
 * biometric prompt.
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

import { mintAttestationClaim } from "./secure-enclave-attest.js";
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
  const attestation = await mintAttestationClaim(opts.invoke, {
    identityPublicKeyHex: opts.identityPublicKeyHex,
    motebitId: opts.motebitId,
    deviceId: opts.deviceId,
    ...(opts.now && { now: opts.now }),
  });

  const now = (opts.now ?? Date.now)();
  return composeHardwareAttestationCredential({
    publicKey: opts.publicKey,
    publicKeyHex: opts.identityPublicKeyHex,
    privateKey: opts.privateKey,
    hardwareAttestation: attestation,
    now,
  });
}
