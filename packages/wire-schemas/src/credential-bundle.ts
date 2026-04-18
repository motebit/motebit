/**
 * CredentialBundle — wire schema.
 *
 * The agent-signed export of portable reputation. When a motebit
 * migrates from one relay to another (identity rotation, hosting
 * change), it signs this bundle and the destination relay consumes
 * it. The source relay does NOT sign — the agent owns its own
 * credentials and the bundle is its assertion of what it accumulated.
 *
 * Foundation Law (§6.2):
 *   - The source relay MUST provide a credential export endpoint for
 *     agents with an active MigrationToken
 *   - The source relay MUST NOT withhold credentials issued to the agent
 *   - The agent signs the bundle; the relay does not
 *
 * Why this matters for external implementers: portability is the
 * mechanism by which sovereignty is enforced at the protocol layer.
 * If the bundle's machine-readable contract were missing, an agent
 * leaving relay A for relay B would have to trust both relays' bespoke
 * export formats. With this schema, the agent emits a signed bundle
 * that any conformant destination MUST accept — relay choice becomes
 * actually exercisable.
 *
 * Inner-document looseness (`credentials`, `anchor_proofs`,
 * `key_succession` are arrays of arbitrary JSON objects): each entry
 * has its own wire format defined by a separate spec (credential@1.0,
 * credential-anchor@1.0, identity@1.0). The bundle's job is to
 * envelope them with the agent's signature; per-entry validation is
 * the consumer's responsibility against the dedicated schemas.
 *
 * See spec/migration-v1.md §6.1 for the full specification.
 */

import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

import type { CredentialBundle } from "@motebit/protocol";

import { assembleJsonSchemaFor } from "./assemble.js";

/** Stable `$id` for the credential-bundle v1 wire format. */
export const CREDENTIAL_BUNDLE_SCHEMA_ID =
  "https://raw.githubusercontent.com/motebit/motebit/main/packages/wire-schemas/schema/credential-bundle-v1.json";

/**
 * Loose object shape for nested credentials / anchors / successions.
 * Each entry carries its own typed wire format defined elsewhere; the
 * bundle's signature commits to the bytes of these objects, not to
 * their internal validity. Per-entry validation against the dedicated
 * schemas is the consumer's responsibility after bundle-level
 * signature verification succeeds.
 */
const NestedDocumentSchema = z
  .record(z.string(), z.unknown())
  .describe(
    "Arbitrary JSON object — its shape is defined by a separate wire format (credential@1.0 for `credentials`, credential-anchor@1.0 for `anchor_proofs`, identity@1.0 for `key_succession`). The bundle's signature covers the bytes; validate inner shape against the dedicated schemas after bundle verification.",
  );

export const CredentialBundleSchema = z
  .object({
    motebit_id: z
      .string()
      .min(1)
      .describe(
        "Agent's motebit identity (UUIDv7). The signer of the bundle. Destination relays verify the embedded signature against the public key bound to this identity at the source.",
      ),
    exported_at: z
      .number()
      .describe(
        "Unix timestamp in milliseconds when the agent emitted the bundle. Lets destination relays detect stale exports (e.g. replayed migrations).",
      ),
    credentials: z
      .array(NestedDocumentSchema)
      .describe(
        "W3C Verifiable Credential 2.0 documents the agent has accumulated. Empty array is valid (a fresh agent with no issued credentials). Each entry validates against credential@1.0 (W3C VC 2.0 + motebit's eddsa-jcs-2022 cryptosuite profile).",
      ),
    anchor_proofs: z
      .array(NestedDocumentSchema)
      .describe(
        "On-chain credential anchor proofs (Merkle inclusion + chain reference). Lets the destination relay verify which credentials were anchored to which chain transaction without reaching out to the chain. Each entry validates against credential-anchor@1.0.",
      ),
    key_succession: z
      .array(NestedDocumentSchema)
      .describe(
        "Full key rotation history. Required so the destination relay can verify the agent's current public key chains back to the originally-anchored identity. Each entry validates against identity@1.0.",
      ),
    bundle_hash: z
      .string()
      .min(1)
      .describe(
        "SHA-256 hex digest of the canonical JSON of all fields EXCEPT `bundle_hash` and `signature`. Lets consumers verify the bundle's content-addressing is consistent with the embedded signature without recomputing both.",
      ),
    suite: z
      .literal("motebit-jcs-ed25519-b64-v1")
      .describe(
        "Cryptosuite identifier. Always `motebit-jcs-ed25519-b64-v1` for credential bundles today: JCS canonicalization (RFC 8785), Ed25519 signature, base64url-encoded signature, hex-encoded public key. Verifiers reject missing or unknown values fail-closed.",
      ),
    signature: z
      .string()
      .min(1)
      .describe(
        "Base64url-encoded Ed25519 signature over `canonicalJson(body)` where `body` = this object minus `signature`. Verify with the agent's public key (resolved via `key_succession` for the timestamp `exported_at`).",
      ),
  })
  .strict();

// ---------------------------------------------------------------------------
// Type parity — drift defense #22 compile-time half
// ---------------------------------------------------------------------------

type InferredBundle = z.infer<typeof CredentialBundleSchema>;

type _ForwardCheck = CredentialBundle extends InferredBundle ? true : never;
type _ReverseCheck = InferredBundle extends CredentialBundle ? true : never;

export const _CREDENTIAL_BUNDLE_TYPE_PARITY: {
  forward: _ForwardCheck;
  reverse: _ReverseCheck;
} = {
  forward: true as _ForwardCheck,
  reverse: true as _ReverseCheck,
};

// ---------------------------------------------------------------------------
// JSON Schema emitter
// ---------------------------------------------------------------------------

export function buildCredentialBundleJsonSchema(): Record<string, unknown> {
  const raw = zodToJsonSchema(CredentialBundleSchema, {
    name: "CredentialBundle",
    $refStrategy: "root",
    target: "jsonSchema7",
  }) as Record<string, unknown>;
  return assembleJsonSchemaFor("CredentialBundle", raw, {
    $id: CREDENTIAL_BUNDLE_SCHEMA_ID,
    title: "CredentialBundle (v1)",
    description:
      "Agent-signed export of portable reputation. The agent owns its credentials; the source relay must provide them; the destination relay verifies the bundle's signature and accepts the credentials. Sovereignty made portable. See spec/migration-v1.md §6.1.",
  });
}
