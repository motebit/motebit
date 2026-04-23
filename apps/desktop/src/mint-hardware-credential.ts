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
  publicKeyToDidKey,
  signVerifiableCredential,
  type VerifiableCredential,
} from "@motebit/encryption";
import type { HardwareAttestationClaim } from "@motebit/sdk";

import { mintAttestationClaim } from "./secure-enclave-attest.js";
import type { InvokeFn } from "./tauri-storage.js";

/** Minimal subject shape — same as the CLI's. Self-attested. */
export interface HardwareCredentialSubject {
  readonly id: string;
  /** Ed25519 identity public key, lowercase hex (64 chars). */
  readonly identity_public_key: string;
  readonly hardware_attestation: HardwareAttestationClaim;
  /** Unix ms at which the claim was minted. */
  readonly attested_at: number;
}

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
 * Runs two I/O calls — both via the injected `invoke`:
 *   1. `mintAttestationClaim` → `HardwareAttestationClaim` (SE or software)
 *   2. Local: `signVerifiableCredential` over the composed unsigned VC
 *
 * Returns the signed credential ready for JSON-serialization + verify.
 */
export async function mintHardwareCredential(
  opts: MintHardwareCredentialOptions,
): Promise<VerifiableCredential<HardwareCredentialSubject>> {
  const attestation = await mintAttestationClaim(opts.invoke, {
    identityPublicKeyHex: opts.identityPublicKeyHex,
    motebitId: opts.motebitId,
    deviceId: opts.deviceId,
    ...(opts.now && { now: opts.now }),
  });

  const now = (opts.now ?? Date.now)();
  const issuerDid = publicKeyToDidKey(opts.publicKey);
  const subject: HardwareCredentialSubject = {
    id: issuerDid,
    identity_public_key: opts.identityPublicKeyHex.toLowerCase(),
    hardware_attestation: attestation,
    attested_at: now,
  };

  const unsigned: Omit<VerifiableCredential<HardwareCredentialSubject>, "proof"> = {
    "@context": ["https://www.w3.org/ns/credentials/v2", "https://motebit.com/ns/credentials/v1"],
    type: ["VerifiableCredential", "AgentTrustCredential"],
    issuer: issuerDid,
    validFrom: new Date(now).toISOString(),
    credentialSubject: subject,
  };

  return signVerifiableCredential<HardwareCredentialSubject>(
    unsigned,
    opts.privateKey,
    opts.publicKey,
  );
}
