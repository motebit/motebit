/**
 * Seed Escrow Payload — wire schema.
 *
 * An identity's Ed25519 seed, AEAD-encrypted under a key only the owner's
 * authenticator can reproduce, parked with a custodian that is structurally
 * unable to open it. Escrow, not custody. Unsigned by design — integrity is
 * the AES-GCM tag, correctness is the mandatory `identity_pubkey_check`, and
 * placement is authenticated by signed-request-envelope@1.0.
 *
 * Restoring clients MUST:
 *   1. Reject unknown `kdf` values, fail-closed
 *   2. AES-256-GCM-decrypt `encrypted_seed` (nonce, tag); AEAD failure ⇒ reject
 *   3. Re-derive the Ed25519 public key from the seed and match
 *      `identity_pubkey_check` — an AEAD success is NOT yet a restore
 *
 * See `spec/seed-escrow-v1.md`.
 */

import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

import type { SeedEscrowPayload } from "@motebit/protocol";

import { assembleJsonSchemaFor } from "./assemble.js";
import type { ParityForward, ParityReverse } from "./__parity/check.js";

/** Stable `$id` for the seed-escrow-payload v1 wire format. External tools pin to this. */
export const SEED_ESCROW_PAYLOAD_SCHEMA_ID =
  "https://raw.githubusercontent.com/motebit/motebit/main/spec/schemas/seed-escrow-payload-v1.json";

export const SeedEscrowPayloadSchema = z
  .object({
    unlock_hint: z
      .string()
      .min(1)
      .describe(
        "Opaque locator for the unwrap secret. For kdf `webauthn-prf-hkdf-sha256`: the WebAuthn credential id, base64url. Unguessable; retrieval is keyed on it and MUST NOT be publicly enumerable.",
      ),
    kdf: z
      .enum(["webauthn-prf-hkdf-sha256"])
      .describe(
        "KDF descriptor — closed enum, registered never forked. v1's sole entry: WebAuthn PRF extension output → HKDF-SHA256 (empty salt, application-fixed info constant) → AES-256-GCM key. Unknown values are rejected fail-closed by custodians and restoring clients alike.",
      ),
    encrypted_seed: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .describe(
        "AES-256-GCM ciphertext of the 32-byte Ed25519 seed, hex-encoded (64 lowercase characters). WebCrypto implementations split SubtleCrypto's `ciphertext ‖ tag` output — the final 16 bytes go to `tag`.",
      ),
    nonce: z
      .string()
      .regex(/^[0-9a-f]{24}$/)
      .describe(
        "AES-256-GCM nonce, 12 random bytes, hex-encoded (24 lowercase characters). Fresh per placement.",
      ),
    tag: z
      .string()
      .regex(/^[0-9a-f]{32}$/)
      .describe(
        "AES-256-GCM authentication tag, 16 bytes, hex-encoded (32 lowercase characters). AEAD failure on restore is rejection — wrong credential, corruption, and tampering are indistinguishable by design.",
      ),
    identity_pubkey_check: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .describe(
        "Ed25519 public key derived from the escrowed seed, hex-encoded (64 lowercase characters). MANDATORY post-decryption check: a restored seed that does not re-derive to this key is discarded — an AEAD success is not yet a restore.",
      ),
  })
  .strict();

// ---------------------------------------------------------------------------
// Type parity — drift defense #22 compile-time half
// ---------------------------------------------------------------------------

type InferredPayload = z.infer<typeof SeedEscrowPayloadSchema>;

type _ForwardCheck = ParityForward<SeedEscrowPayload, InferredPayload>;
type _ReverseCheck = ParityReverse<SeedEscrowPayload, InferredPayload>;

export const _SEED_ESCROW_PAYLOAD_TYPE_PARITY: {
  forward: _ForwardCheck;
  reverse: _ReverseCheck;
} = {
  forward: true,
  reverse: true,
};

// ---------------------------------------------------------------------------
// JSON Schema emitter
// ---------------------------------------------------------------------------

export function buildSeedEscrowPayloadJsonSchema(): Record<string, unknown> {
  const raw = zodToJsonSchema(SeedEscrowPayloadSchema, {
    name: "SeedEscrowPayload",
    $refStrategy: "root",
    target: "jsonSchema7",
  }) as Record<string, unknown>;
  return assembleJsonSchemaFor("SeedEscrowPayload", raw, {
    $id: SEED_ESCROW_PAYLOAD_SCHEMA_ID,
    title: "SeedEscrowPayload (v1)",
    description:
      "An identity's Ed25519 seed, AEAD-encrypted under a key only the owner's authenticator can reproduce, parked with a custodian that is structurally unable to open it. Escrow, not custody. Unsigned by design: integrity is the AES-GCM tag, correctness is identity_pubkey_check, placement is authenticated by the enclosing transport. See spec/seed-escrow-v1.md.",
  });
}
