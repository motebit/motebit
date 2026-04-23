/**
 * Canonical composer for motebit's self-signed hardware-attestation
 * credential.
 *
 * Why this file exists. Before 2026-04-22 the CLI
 * (`apps/cli/src/subcommands/attest.ts` → `buildAttestationCredential`)
 * and the desktop surface
 * (`apps/desktop/src/mint-hardware-credential.ts` →
 * `mintHardwareCredential`) each composed this credential themselves.
 * Same envelope, same subject shape, same signing primitive — two
 * copies. The classic sibling-drift pattern: a field added to one
 * (say, a future `challenge` binding) wouldn't land on the other,
 * and verifiers would see two structurally-different credentials
 * claiming to be the same kind. The sibling-boundary rule in
 * `CLAUDE.md` says audit when you touch one of a pair; this
 * consolidation is that audit's fix.
 *
 * Every hardware-attestation credential motebit emits is the same
 * shape:
 *
 *   {
 *     "@context": ["…/credentials/v2", "…/motebit.com/ns/credentials/v1"],
 *     type:       ["VerifiableCredential", "AgentTrustCredential"],
 *     issuer:     <did:key of issuer's Ed25519 public key>,
 *     validFrom:  ISO timestamp at mint time,
 *     credentialSubject: {
 *       id:                  <same did:key — self-attestation>,
 *       identity_public_key: <Ed25519 hex, lowercase>,
 *       hardware_attestation: <HardwareAttestationClaim, caller-supplied>,
 *       attested_at:         <unix ms>,
 *     },
 *     proof: eddsa-jcs-2022 DataIntegrity proof,
 *   }
 *
 * The ONLY surface-specific variance is `hardware_attestation`: the
 * CLI hardcodes `{platform: "software", key_exported: false}`
 * (process can't reach the Secure Enclave); desktop passes whatever
 * `mintAttestationClaim` returned from the Rust SE bridge. This
 * file's contract is "give me the claim and the keys; I'll produce
 * the signed VC." Both surfaces delegate; future surfaces (mobile,
 * spatial, relay-issued) land here without another copy.
 *
 * Layer: `@motebit/encryption` is Layer 1 BSL — the product-
 * vocabulary signing surface apps are permitted to consume per the
 * `check-app-primitives` drift gate. The `@motebit/crypto`
 * primitives (`signVerifiableCredential`, `publicKeyToDidKey`) that
 * back this composer are re-exported from the same package.
 */

import type { HardwareAttestationClaim } from "@motebit/protocol";

import {
  publicKeyToDidKey,
  signVerifiableCredential,
  type VerifiableCredential,
} from "@motebit/crypto";

/**
 * Subject of a self-signed hardware-attestation credential. Minimal
 * by design — we assert only what we can prove at mint time. Trust
 * metrics (interaction counts, success/failure ratios) live on
 * `TrustCredentialSubject` from peer-issued reputation credentials;
 * they don't belong on a self-attestation.
 */
export interface HardwareAttestationCredentialSubject {
  readonly id: string;
  /** Ed25519 identity public key, lowercase hex (64 chars). */
  readonly identity_public_key: string;
  readonly hardware_attestation: HardwareAttestationClaim;
  /** Unix ms at which the claim was minted. */
  readonly attested_at: number;
}

export interface ComposeHardwareAttestationCredentialInput {
  /** Ed25519 identity public key bytes (32 bytes). */
  readonly publicKey: Uint8Array;
  /** Same key as `publicKey`, lowercase hex encoded (64 chars). */
  readonly publicKeyHex: string;
  /** Ed25519 private key bytes (32 bytes). */
  readonly privateKey: Uint8Array;
  /**
   * The hardware-attestation claim to embed. Callers decide how to
   * produce it: desktop routes through the Rust SE bridge and gets a
   * `platform: "secure_enclave"` claim; the CLI hardcodes a
   * `platform: "software"` sentinel; other surfaces may produce
   * additional platforms (`tpm`, `device_check`, `play_integrity`)
   * as those adapters land.
   */
  readonly hardwareAttestation: HardwareAttestationClaim;
  /**
   * Unix ms timestamp. Threaded as the VC's `validFrom` (ISO) and
   * the subject's `attested_at`. Injected for test determinism.
   */
  readonly now: number;
}

/**
 * Compose and sign a motebit hardware-attestation credential.
 *
 * Self-attested: the issuer and credentialSubject.id are both the
 * same `did:key:z…` derived from the Ed25519 public key. A third
 * party verifying the credential sees one Ed25519 signature (the VC
 * envelope) AND — routed through `@motebit/crypto`'s
 * `verifyHardwareAttestationClaim` — the hardware-attestation claim
 * either verifies (platform: secure_enclave, signed body) or
 * truthfully reports no-hardware-channel (platform: software).
 *
 * Pure: no I/O, no storage, no clock. Tests can assert byte-exact
 * output given fixed inputs.
 */
export async function composeHardwareAttestationCredential(
  input: ComposeHardwareAttestationCredentialInput,
): Promise<VerifiableCredential<HardwareAttestationCredentialSubject>> {
  const issuerDid = publicKeyToDidKey(input.publicKey);
  const subject: HardwareAttestationCredentialSubject = {
    id: issuerDid, // self-attestation: issuer === subject
    identity_public_key: input.publicKeyHex.toLowerCase(),
    hardware_attestation: input.hardwareAttestation,
    attested_at: input.now,
  };
  const unsigned: Omit<VerifiableCredential<HardwareAttestationCredentialSubject>, "proof"> = {
    "@context": ["https://www.w3.org/ns/credentials/v2", "https://motebit.com/ns/credentials/v1"],
    type: ["VerifiableCredential", "AgentTrustCredential"],
    issuer: issuerDid,
    validFrom: new Date(input.now).toISOString(),
    credentialSubject: subject,
  };
  return signVerifiableCredential<HardwareAttestationCredentialSubject>(
    unsigned,
    input.privateKey,
    input.publicKey,
  );
}
