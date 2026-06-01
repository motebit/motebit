/**
 * Transparency-declaration wire schema — the trust-anchor primitive.
 *
 * The motebit relay publishes a signed `SignedTransparencyDeclaration`
 * at `/.well-known/motebit-transparency.json`. The declaration's
 * `relay_public_key` is the trust anchor every motebit verifier pins
 * for content-artifact manifests, settlement receipts, and federation
 * handshakes. This module is the zod-shaped wire validator.
 *
 * The cryptosuite is `motebit-jcs-ed25519-hex-v1` — same suite as
 * credential anchors and revocations (HEX signature encoding, not
 * base64url like execution receipts). Hex is conventional for chain-
 * adjacent artifacts and the transparency declaration anchors to
 * Solana via the Memo program (`motebit:transparency:v1:{hash}`).
 *
 * `content` is intentionally typed as `z.unknown()` per the spec —
 * the protocol commits to the trust-anchor envelope, not to the
 * operator-comparison vocabulary inside `content`. Stage 2b-ii will
 * standardize that vocabulary when a second motebit-compatible
 * operator forces the question; until then, verifiers MUST NOT
 * reject declarations on `content` shape difference (only on
 * envelope failure).
 *
 * See `spec/relay-transparency-v1.md` (Stage 2b-i).
 */

import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

import type { SignedTransparencyDeclaration } from "@motebit/protocol";

import { assembleJsonSchemaFor } from "./assemble.js";
import type { ParityForward, ParityReverse } from "./__parity/check.js";

// ---------------------------------------------------------------------------
// Stable $id URL
// ---------------------------------------------------------------------------

export const SIGNED_TRANSPARENCY_DECLARATION_SCHEMA_ID =
  "https://raw.githubusercontent.com/motebit/motebit/main/spec/schemas/signed-transparency-declaration-v1.json";

// ---------------------------------------------------------------------------
// SignedTransparencyDeclaration — operator-signed trust-anchor envelope
// ---------------------------------------------------------------------------

export const SignedTransparencyDeclarationSchema = z
  .object({
    spec: z
      .string()
      .min(1)
      .describe(
        "Spec identifier — e.g. `motebit-transparency/draft-2026-04-14`. Bumps require an explicit wire-format spec update; verifiers reject unrecognized values.",
      ),
    declared_at: z
      .number()
      .describe(
        "Epoch milliseconds when the declaration was minted. Verifiers can detect declarations claiming future-dated postures.",
      ),
    relay_id: z
      .string()
      .min(1)
      .describe(
        "MotebitId of the relay — the operator's relay identity. Same identifier space as agent identities; verifiers use this to look up the succession chain (spec/identity-v1.md §3.8).",
      ),
    relay_public_key: z
      .string()
      .min(1)
      .describe(
        "Hex-encoded Ed25519 public key (32 bytes / 64 chars). The trust anchor: every other relay-asserted artifact (content-artifact manifests, settlement receipts, federation handshakes) verifies against this key.",
      ),
    content: z
      .unknown()
      .describe(
        "Operator-defined posture payload — retention windows, processors, jurisdiction, honest gaps. Opaque to the protocol per spec/relay-transparency-v1.md §3.1. Verifiers MUST NOT reject declarations on unknown content fields. Cross-operator comparison vocabulary is deferred to Stage 2b-ii.",
      ),
    hash: z
      .string()
      .regex(
        /^[0-9a-f]{64}$/,
        "hash MUST be 64 lowercase hex characters (SHA-256 of canonicalJson({spec, declared_at, relay_id, relay_public_key, content}))",
      )
      .describe(
        "Hex-encoded SHA-256 of `canonicalJson({spec, declared_at, relay_id, relay_public_key, content})`. Verifiers recompute this from the canonical bytes and reject mismatches before checking the signature.",
      ),
    suite: z
      .literal("motebit-jcs-ed25519-hex-v1")
      .describe(
        "Cryptosuite identifier — always `motebit-jcs-ed25519-hex-v1` for transparency declarations (JCS canonicalization, Ed25519 primitive, HEX signature encoding). Verifiers reject missing or unknown values fail-closed.",
      ),
    signature: z
      .string()
      .min(1)
      .describe(
        "Hex-encoded Ed25519 signature over the same canonical-JSON payload as `hash`. Signed by `relay_public_key`. Self-attesting envelope.",
      ),
  })
  .strict();

type _InferredDecl = z.infer<typeof SignedTransparencyDeclarationSchema>;

// parity-divergence: zod infers `content?: unknown` because `z.unknown()`
// keys are always optional in inference, but the protocol requires `content`
// — it is part of the signed hash payload `{spec, declared_at, relay_id,
// relay_public_key, content}` and the relay always emits it
// (services/relay/src/transparency.ts:121,341). Re-require the key for the
// parity comparison only; runtime validation is unchanged (a content-less
// declaration would fail signature verification regardless). This corrects a
// zod representational limit on `unknown` keys — not wire drift, not a
// blanket `as` cast.
type _InferredDeclWireExact = Omit<_InferredDecl, "content"> & { content: unknown };

type _Forward = ParityForward<SignedTransparencyDeclaration, _InferredDeclWireExact>;
type _Reverse = ParityReverse<SignedTransparencyDeclaration, _InferredDeclWireExact>;

export const _SIGNED_TRANSPARENCY_DECLARATION_TYPE_PARITY: {
  forward: _Forward;
  reverse: _Reverse;
} = {
  forward: true as _Forward,
  reverse: true as _Reverse,
};

export function buildSignedTransparencyDeclarationJsonSchema(): Record<string, unknown> {
  const raw = zodToJsonSchema(SignedTransparencyDeclarationSchema, {
    name: "SignedTransparencyDeclaration",
    $refStrategy: "root",
    target: "jsonSchema7",
  }) as Record<string, unknown>;
  return assembleJsonSchemaFor("SignedTransparencyDeclaration", raw, {
    $id: SIGNED_TRANSPARENCY_DECLARATION_SCHEMA_ID,
    title: "SignedTransparencyDeclaration (v1)",
    description:
      "Operator-transparency declaration — the trust-anchor primitive. Signed by `relay_public_key` over `canonicalJson({spec, declared_at, relay_id, relay_public_key, content})`; the signed bytes feed both `hash` and `signature`. `content` is operator-defined per spec/relay-transparency-v1.md §3.1; the protocol commits to the envelope, not the posture vocabulary inside. See spec/relay-transparency-v1.md.",
  });
}
