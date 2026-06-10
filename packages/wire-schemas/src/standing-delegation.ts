/**
 * Standing Delegation + Delegation Revocation — wire schemas (standing-delegation@1.0).
 *
 * A `StandingDelegation` grant authorizes its holder to mint short-lived
 * per-tick `DelegationToken`s within a fixed scope ceiling and cadence, for a
 * long-but-finite, revocable lifetime. A `DelegationRevocation` terminates a
 * grant. Both are signed and offline-verifiable like a delegation token: an
 * external (non-motebit) verifier validates a standing monitor's authorization
 * root, every per-tick token, and a revocation with only these JSON Schemas and
 * any Ed25519 library — no relay contact.
 *
 * StandingDelegation verifiers MUST:
 *   1. Check `suite` == "motebit-jcs-ed25519-b64-v1"
 *   2. Check `not_before == null || now >= not_before`, and `now <= expires_at`
 *   3. Check the grant is not revoked (a signed DelegationRevocation for `grant_id`)
 *   4. Canonicalize the body (everything except `signature`) via JCS, verify
 *      the Ed25519 signature against `delegator_public_key`
 *
 * A per-tick token is a valid tick of a grant iff (in addition to verifying as
 * a DelegationToken): `grant_id` matches, the grant verifies, the parties match,
 * `scope` narrows within the grant's ceiling, and the token's TTL ≤
 * `max_token_ttl_ms`. Cadence is a mint/relay-side rate limit, not a single-
 * token verification rule.
 *
 * See `spec/standing-delegation-v1.md`.
 */

import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

import type { StandingDelegation, DelegationRevocation } from "@motebit/protocol";

import { assembleJsonSchemaFor } from "./assemble.js";
import type { ParityForward, ParityReverse } from "./__parity/check.js";

/** Stable `$id`s for the standing-delegation v1 wire formats. External tools pin to these. */
export const STANDING_DELEGATION_SCHEMA_ID =
  "https://raw.githubusercontent.com/motebit/motebit/main/spec/schemas/standing-delegation-v1.json";
export const DELEGATION_REVOCATION_SCHEMA_ID =
  "https://raw.githubusercontent.com/motebit/motebit/main/spec/schemas/delegation-revocation-v1.json";

const HEX_PUBLIC_KEY_PATTERN = /^[0-9a-f]{64}$/;

export const StandingDelegationSchema = z
  .object({
    grant_id: z
      .string()
      .min(1)
      .describe(
        "UUIDv7 — the stable handle a DelegationRevocation targets. Per-tick tokens minted under this grant carry it as `grant_id`.",
      ),
    delegator_id: z
      .string()
      .min(1)
      .describe("Delegator's motebit identity — the entity granting standing authority."),
    delegator_public_key: z
      .string()
      .regex(HEX_PUBLIC_KEY_PATTERN)
      .describe(
        "Delegator's Ed25519 public key, hex-encoded (64 lowercase). Verifies `signature`. Embedded so verification needs no relay lookup.",
      ),
    delegate_id: z
      .string()
      .min(1)
      .describe("Delegate's motebit identity — the entity authorized to mint per-tick tokens."),
    delegate_public_key: z
      .string()
      .regex(HEX_PUBLIC_KEY_PATTERN)
      .describe(
        "Delegate's Ed25519 public key, hex-encoded (64 lowercase). Per-tick tokens must name this same delegate.",
      ),
    scope: z
      .string()
      .min(1)
      .describe(
        "Comma-separated capability CEILING, or `*`. Each minted per-tick token's scope must narrow within this. Same grammar as DelegationToken.scope (market-v1 §12.3).",
      ),
    subject: z
      .string()
      .describe(
        "Human-meaningful binding (e.g. `research:thesis=acme-q3`). Opaque to verification; carried for receipt-linkage and operator legibility.",
      ),
    cadence_ms: z
      .number()
      .describe(
        "Authorized minimum firing interval, milliseconds. A per-tick rate limit enforced at mint/relay time — NOT a single-token verification rule.",
      ),
    issued_at: z.number().describe("Unix timestamp in milliseconds when the grant was issued."),
    not_before: z
      .number()
      .nullable()
      .describe("Optional activation delay (Unix ms). Null ⇒ active from `issued_at`."),
    expires_at: z
      .number()
      .describe(
        "Unix timestamp in milliseconds after which the grant is invalid. Long-but-finite and renewable — NOT open-ended; the delegate renews by re-signing. See standing-delegation-v1 §6 D1.",
      ),
    max_token_ttl_ms: z
      .number()
      .describe(
        "Ceiling on each minted token's `(expires_at - issued_at)`. Keeps per-tick tokens short-lived even though the grant lives long.",
      ),
    suite: z
      .literal("motebit-jcs-ed25519-b64-v1")
      .describe(
        "Cryptosuite identifier. Always `motebit-jcs-ed25519-b64-v1`: JCS (RFC 8785), Ed25519, base64url signature, hex public keys.",
      ),
    signature: z
      .string()
      .min(1)
      .describe(
        "Base64url-encoded Ed25519 signature over `canonicalJson(body)` (this object minus `signature`). Verify with `delegator_public_key`.",
      ),
  })
  .strict();

export const DelegationRevocationSchema = z
  .object({
    grant_id: z.string().min(1).describe("The StandingDelegation.grant_id being revoked."),
    delegator_id: z
      .string()
      .min(1)
      .describe("Delegator's motebit identity. MUST equal the grant's delegator."),
    delegator_public_key: z
      .string()
      .regex(HEX_PUBLIC_KEY_PATTERN)
      .describe(
        "Delegator's Ed25519 public key, hex-encoded (64 lowercase). Verifies `signature`. To bind a grant, MUST equal that grant's `delegator_public_key`.",
      ),
    revoked_at: z.number().describe("Unix timestamp in milliseconds when the grant was revoked."),
    suite: z
      .literal("motebit-jcs-ed25519-b64-v1")
      .describe(
        "Cryptosuite identifier. Always `motebit-jcs-ed25519-b64-v1`: JCS (RFC 8785), Ed25519, base64url signature, hex public keys.",
      ),
    signature: z
      .string()
      .min(1)
      .describe(
        "Base64url-encoded Ed25519 signature over `canonicalJson(body)` (this object minus `signature`). Verify with `delegator_public_key`.",
      ),
  })
  .strict();

// ---------------------------------------------------------------------------
// Type parity — drift defense #22 compile-time half (bare `true`; see CLAUDE.md)
// ---------------------------------------------------------------------------

type InferredStanding = z.infer<typeof StandingDelegationSchema>;
type InferredRevocation = z.infer<typeof DelegationRevocationSchema>;

type _StandingForward = ParityForward<StandingDelegation, InferredStanding>;
type _StandingReverse = ParityReverse<StandingDelegation, InferredStanding>;
type _RevocationForward = ParityForward<DelegationRevocation, InferredRevocation>;
type _RevocationReverse = ParityReverse<DelegationRevocation, InferredRevocation>;

export const _STANDING_DELEGATION_TYPE_PARITY: {
  forward: _StandingForward;
  reverse: _StandingReverse;
} = {
  forward: true,
  reverse: true,
};

export const _DELEGATION_REVOCATION_TYPE_PARITY: {
  forward: _RevocationForward;
  reverse: _RevocationReverse;
} = {
  forward: true,
  reverse: true,
};

// ---------------------------------------------------------------------------
// JSON Schema emitters
// ---------------------------------------------------------------------------

export function buildStandingDelegationJsonSchema(): Record<string, unknown> {
  const raw = zodToJsonSchema(StandingDelegationSchema, {
    name: "StandingDelegation",
    $refStrategy: "root",
    target: "jsonSchema7",
  }) as Record<string, unknown>;
  return assembleJsonSchemaFor("StandingDelegation", raw, {
    $id: STANDING_DELEGATION_SCHEMA_ID,
    title: "StandingDelegation (v1)",
    description:
      "Signed, revocable standing grant authorizing minting short-lived per-tick DelegationTokens within a fixed scope ceiling and cadence. Canonicalization: JCS (RFC 8785). Signature: Ed25519 over canonicalJson(body minus signature), base64url. See spec/standing-delegation-v1.md.",
  });
}

export function buildDelegationRevocationJsonSchema(): Record<string, unknown> {
  const raw = zodToJsonSchema(DelegationRevocationSchema, {
    name: "DelegationRevocation",
    $refStrategy: "root",
    target: "jsonSchema7",
  }) as Record<string, unknown>;
  return assembleJsonSchemaFor("DelegationRevocation", raw, {
    $id: DELEGATION_REVOCATION_SCHEMA_ID,
    title: "DelegationRevocation (v1)",
    description:
      "Signed, offline-verifiable revocation of a StandingDelegation. Only the grant's delegator may sign one. The canonical source of truth for grant revocation. See spec/standing-delegation-v1.md.",
  });
}
