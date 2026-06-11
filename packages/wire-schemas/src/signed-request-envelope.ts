/**
 * Signed Request Envelope — wire schema.
 *
 * Stateless request authentication from a registered motebit identity to a
 * service endpoint: the key is the login. The envelope binds the identity
 * (`motebit_id`), a timestamp (`ts`), a digest of the detached request body
 * (`payload_digest`), and an audience (`aud`) into one Ed25519 signature.
 *
 * Verifiers MUST:
 *   1. Check `suite` matches "motebit-jcs-ed25519-b64-v1"
 *   2. Resolve the public key for `motebit_id` from the IDENTITY REGISTRY —
 *      never a key carried in or alongside the request
 *   3. Check `|now − ts|` is within the freshness window (default ±300s)
 *   4. Check `aud` exact-matches this endpoint's audience (fail-closed)
 *   5. Recompute SHA-256(canonicalJson(payload)) and match `payload_digest`
 *   6. Verify the Ed25519 signature against the registered key over
 *      canonicalJson(body minus signature)
 *
 * External (non-motebit) verifiers can do all six steps using only this JSON
 * Schema and any Ed25519 library. See `spec/signed-request-envelope-v1.md`.
 */

import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

import type { SignedRequestEnvelope } from "@motebit/protocol";

import { assembleJsonSchemaFor } from "./assemble.js";
import type { ParityForward, ParityReverse } from "./__parity/check.js";

/** Stable `$id` for the signed-request-envelope v1 wire format. External tools pin to this. */
export const SIGNED_REQUEST_ENVELOPE_SCHEMA_ID =
  "https://raw.githubusercontent.com/motebit/motebit/main/spec/schemas/signed-request-envelope-v1.json";

const HEX_SHA256_PATTERN = /^[0-9a-f]{64}$/;

export const SignedRequestEnvelopeSchema = z
  .object({
    motebit_id: z
      .string()
      .min(1)
      .describe(
        "Requesting identity. The verifier resolves the Ed25519 public key for this id from its registry; a key carried by the request is never trusted.",
      ),
    ts: z
      .number()
      .describe(
        "Unix timestamp in milliseconds at signing. Freshness, not entropy — verifiers reject when |now − ts| exceeds the freshness window (default ±300s).",
      ),
    payload_digest: z
      .string()
      .regex(HEX_SHA256_PATTERN)
      .describe(
        "SHA-256 of canonicalJson(payload), hex-encoded (64 lowercase characters). Binds the detached request body to the envelope; the verifier recomputes from the body as received.",
      ),
    aud: z
      .string()
      .min(1)
      .describe(
        'Audience — free-form string (deliberately not the auth-token TokenAudience registry), convention "{host}/{route}". Exact-match at the verifier, fail-closed; kills cross-service replay.',
      ),
    nonce: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Optional — UUID v4 recommended. Present ⇒ the signer requests replay-once semantics; verifiers offering them dedup within the freshness window. Absent ⇒ within-window replay re-executes the same idempotent operation.",
      ),
    suite: z
      .literal("motebit-jcs-ed25519-b64-v1")
      .describe(
        "Cryptosuite identifier. Always `motebit-jcs-ed25519-b64-v1`: JCS canonicalization (RFC 8785), Ed25519 signature, base64url-encoded signature. See @motebit/protocol SUITE_REGISTRY.",
      ),
    signature: z
      .string()
      .min(1)
      .describe(
        "Base64url-encoded Ed25519 signature over `canonicalJson(body)` where `body` = this object minus `signature`. Verify with the REGISTERED key for `motebit_id`.",
      ),
  })
  .strict();

// ---------------------------------------------------------------------------
// Type parity — drift defense #22 compile-time half
// ---------------------------------------------------------------------------

type InferredEnvelope = z.infer<typeof SignedRequestEnvelopeSchema>;

type _ForwardCheck = ParityForward<SignedRequestEnvelope, InferredEnvelope>;
type _ReverseCheck = ParityReverse<SignedRequestEnvelope, InferredEnvelope>;

export const _SIGNED_REQUEST_ENVELOPE_TYPE_PARITY: {
  forward: _ForwardCheck;
  reverse: _ReverseCheck;
} = {
  forward: true,
  reverse: true,
};

// ---------------------------------------------------------------------------
// JSON Schema emitter
// ---------------------------------------------------------------------------

export function buildSignedRequestEnvelopeJsonSchema(): Record<string, unknown> {
  const raw = zodToJsonSchema(SignedRequestEnvelopeSchema, {
    name: "SignedRequestEnvelope",
    $refStrategy: "root",
    target: "jsonSchema7",
  }) as Record<string, unknown>;
  return assembleJsonSchemaFor("SignedRequestEnvelope", raw, {
    $id: SIGNED_REQUEST_ENVELOPE_SCHEMA_ID,
    title: "SignedRequestEnvelope (v1)",
    description:
      "Stateless request authentication from a registered identity: Ed25519 over canonicalJson(envelope minus signature), verified against the identity's REGISTERED public key. The payload travels detached, bound by payload_digest. Canonicalization: JCS (RFC 8785). See spec/signed-request-envelope-v1.md.",
  });
}
