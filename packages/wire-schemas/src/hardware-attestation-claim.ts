/**
 * HardwareAttestationClaim wire schema — the hardware-custody claim
 * embedded as the optional `hardware_attestation` field on
 * `TrustCredentialSubject` (spec/credential-v1.md §3.4).
 *
 * What this schema is for. A third party auditing an `AgentTrustCredential`
 * can now validate the embedded custody claim without bundling motebit:
 *
 *   - `platform` declares the attestation surface. `"software"` is the
 *     explicit no-hardware sentinel — truthfully claiming "we checked,
 *     this key is not hardware-backed" — distinct from an absent claim
 *     (which means "unknown, nothing to say").
 *   - `key_exported` flags when a hardware-generated key was exported
 *     from hardware storage (backup, pairing, migration). A `true` value
 *     weakens the claim — the private material left the enclave, so the
 *     binding between "this key signs" and "this hardware holds it" is
 *     broken until the export is discarded.
 *   - `attestation_receipt` is opaque platform-specific bytes (Apple
 *     DeviceCheck assertion, Google Play Integrity token, TPM quote).
 *     Motebit does not parse this — adapters that know the platform
 *     format are glucose per the metabolic principle. The schema just
 *     reserves the wire-format space so a verifier with the matching
 *     platform adapter can do its side-channel check.
 *
 * The claim does not carry its own signature or `suite` field. The
 * outer `AgentTrustCredential` envelope (W3C VC 2.0 + eddsa-jcs-2022)
 * canonicalizes the full `credentialSubject` body including this claim,
 * so tampering with any claim field breaks the outer signature. Adding
 * a new attestation platform is a registry-like enum extension; the
 * wire shape itself doesn't change.
 *
 * See spec/credential-v1.md §3.4 for the binding subsection.
 */

import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

import type { HardwareAttestationClaim } from "@motebit/protocol";

import { assembleJsonSchemaFor } from "./assemble.js";

// ---------------------------------------------------------------------------
// Stable $id URL — external tools pin to this for schema fetching.
// ---------------------------------------------------------------------------

export const HARDWARE_ATTESTATION_CLAIM_SCHEMA_ID =
  "https://raw.githubusercontent.com/motebit/motebit/main/packages/wire-schemas/schema/hardware-attestation-claim-v1.json";

// ---------------------------------------------------------------------------
// Zod schema
// ---------------------------------------------------------------------------

export const HardwareAttestationClaimSchema = z
  .object({
    platform: z
      .enum(["secure_enclave", "tpm", "play_integrity", "device_check", "software"])
      .describe(
        "Attestation surface identifier. `secure_enclave` = Apple Secure Enclave / Android StrongBox class; `tpm` = Trusted Platform Module (PC); `play_integrity` = Google Play Integrity attestation; `device_check` = Apple DeviceCheck/App Attest; `software` is the explicit no-hardware sentinel (truthfully claims 'this key is not hardware-backed', distinct from an absent claim which means 'unknown').",
      ),
    key_exported: z
      .boolean()
      .optional()
      .describe(
        "True when the private key was exported from hardware storage to software (backup, pairing, migration). Weakens the claim — the hardware no longer uniquely holds the material. Absent is equivalent to `false` for backward compatibility.",
      ),
    attestation_receipt: z
      .string()
      .optional()
      .describe(
        "Opaque platform-specific attestation blob (Apple DeviceCheck assertion, Google Play Integrity token, TPM quote) encoded as the platform expects (base64url by convention). Motebit does not parse this; platform adapters verify it as a side channel. Absent when no platform receipt is available.",
      ),
  })
  .strict();

// ---------------------------------------------------------------------------
// Type parity pin — zod.infer must be structurally equivalent to the
// @motebit/protocol type. If either drifts, `tsc` fails here.
// ---------------------------------------------------------------------------

type _HardwareAttestationClaimForward =
  HardwareAttestationClaim extends z.infer<typeof HardwareAttestationClaimSchema> ? true : never;
type _HardwareAttestationClaimReverse =
  z.infer<typeof HardwareAttestationClaimSchema> extends HardwareAttestationClaim ? true : never;

export const _HARDWARE_ATTESTATION_CLAIM_TYPE_PARITY: {
  forward: _HardwareAttestationClaimForward;
  reverse: _HardwareAttestationClaimReverse;
} = {
  forward: true as _HardwareAttestationClaimForward,
  reverse: true as _HardwareAttestationClaimReverse,
};

// ---------------------------------------------------------------------------
// Committed JSON Schema builder
// ---------------------------------------------------------------------------

export function buildHardwareAttestationClaimJsonSchema(): Record<string, unknown> {
  const raw = zodToJsonSchema(HardwareAttestationClaimSchema, {
    name: "HardwareAttestationClaim",
    $refStrategy: "root",
    target: "jsonSchema7",
  }) as Record<string, unknown>;
  return assembleJsonSchemaFor("HardwareAttestationClaim", raw, {
    $id: HARDWARE_ATTESTATION_CLAIM_SCHEMA_ID,
    title: "HardwareAttestationClaim (v1)",
    description:
      "Optional hardware-custody claim embedded as the `hardware_attestation` field on `TrustCredentialSubject`. Declares whether the subject agent's identity key lives inside a hardware keystore (Secure Enclave, TPM, Android StrongBox, Apple DeviceCheck) or in software. Consumed by `HardwareAttestationSemiring` in `@motebit/semiring` to rank hardware-attested agents above software-only agents during routing. See spec/credential-v1.md §3.4.",
  });
}
