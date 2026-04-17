/**
 * Delegation Token — wire schema.
 *
 * A delegation token authorizes a delegate agent to act on behalf of a
 * delegator for a scoped capability set within a time window. Every
 * delegated ExecutionReceipt chains back to one of these — the
 * receipt's `delegated_scope` echoes this token's `scope`, and the
 * delegate's signature on the receipt is only trusted to the extent
 * the matching delegation token was valid.
 *
 * Verifiers MUST:
 *   1. Check `suite` matches "motebit-jcs-ed25519-b64-v1"
 *   2. Check `issued_at <= now <= expires_at`
 *   3. Canonicalize the body (everything except `signature`) via JCS
 *   4. Verify the Ed25519 signature against `delegator_public_key`
 *   5. Check the declared capability is present in `scope` (or scope == "*")
 *
 * External (non-motebit) verifiers can do all five steps using only
 * this JSON Schema and any Ed25519 library. Fetch the schema, fetch
 * the token, verify. That's the whole protocol — the signed bytes are
 * the trust envelope, not any motebit-specific runtime.
 *
 * See `spec/market-v1.md §12.1` for the full specification.
 */

import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

import type { DelegationToken } from "@motebit/protocol";

import { assembleJsonSchemaFor } from "./assemble.js";

/** Stable `$id` for the delegation-token v1 wire format. External tools pin to this. */
export const DELEGATION_TOKEN_SCHEMA_ID =
  "https://raw.githubusercontent.com/motebit/motebit/main/packages/wire-schemas/schema/delegation-token-v1.json";

const HEX_PUBLIC_KEY_PATTERN = /^[0-9a-f]{64}$/;

export const DelegationTokenSchema = z
  .object({
    delegator_id: z
      .string()
      .min(1)
      .describe(
        "Delegator's motebit identity — UUIDv7 string. The entity authorizing the delegation.",
      ),
    delegator_public_key: z
      .string()
      .regex(HEX_PUBLIC_KEY_PATTERN)
      .describe(
        "Delegator's Ed25519 public key, hex-encoded (64 lowercase characters). Used to verify `signature`. Embedded so verification does not require a relay lookup.",
      ),
    delegate_id: z
      .string()
      .min(1)
      .describe(
        "Delegate's motebit identity — UUIDv7 string. The entity receiving the authorization.",
      ),
    delegate_public_key: z
      .string()
      .regex(HEX_PUBLIC_KEY_PATTERN)
      .describe(
        "Delegate's Ed25519 public key, hex-encoded (64 lowercase characters). Binds the delegation to a specific cryptographic identity — a different keypair cannot exercise the token.",
      ),
    scope: z
      .string()
      .min(1)
      .describe(
        "Comma-separated capability list the delegate may invoke, or `*` for wildcard. Exhaustive match required at invocation time — absent capabilities are denied. See market-v1 §12.3.",
      ),
    issued_at: z.number().describe("Unix timestamp in milliseconds when the token was issued."),
    expires_at: z
      .number()
      .describe(
        "Unix timestamp in milliseconds after which the token is invalid. Verifiers reject tokens where `now > expires_at`.",
      ),
    suite: z
      .literal("motebit-jcs-ed25519-b64-v1")
      .describe(
        "Cryptosuite identifier. Always `motebit-jcs-ed25519-b64-v1` for delegation tokens today: JCS canonicalization (RFC 8785), Ed25519 signature, base64url-encoded signature, hex-encoded public keys. See @motebit/protocol SUITE_REGISTRY.",
      ),
    signature: z
      .string()
      .min(1)
      .describe(
        "Base64url-encoded Ed25519 signature over `canonicalJson(body)` where `body` = this object minus `signature`. Verify with `delegator_public_key`.",
      ),
  })
  .strict();

// ---------------------------------------------------------------------------
// Type parity — drift defense #22 compile-time half
// ---------------------------------------------------------------------------

type InferredToken = z.infer<typeof DelegationTokenSchema>;

type _ForwardCheck = DelegationToken extends InferredToken ? true : never;
type _ReverseCheck = InferredToken extends DelegationToken ? true : never;

export const _DELEGATION_TOKEN_TYPE_PARITY: {
  forward: _ForwardCheck;
  reverse: _ReverseCheck;
} = {
  forward: true as _ForwardCheck,
  reverse: true as _ReverseCheck,
};

// ---------------------------------------------------------------------------
// JSON Schema emitter
// ---------------------------------------------------------------------------

export function buildDelegationTokenJsonSchema(): Record<string, unknown> {
  const raw = zodToJsonSchema(DelegationTokenSchema, {
    name: "DelegationToken",
    $refStrategy: "root",
    target: "jsonSchema7",
  }) as Record<string, unknown>;
  return assembleJsonSchemaFor("DelegationToken", raw, {
    $id: DELEGATION_TOKEN_SCHEMA_ID,
    title: "DelegationToken (v1)",
    description:
      "Signed authorization for a delegate agent to invoke scoped capabilities on behalf of a delegator. Canonicalization: JCS (RFC 8785). Signature: Ed25519 over canonicalJson(body minus signature), base64url-encoded. See spec/market-v1.md §12.1.",
  });
}
