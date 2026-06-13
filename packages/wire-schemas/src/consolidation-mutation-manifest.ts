/**
 * Consolidation mutation manifest wire schema — the felt-interior binding.
 *
 * The owner-facing adjunct to a `ConsolidationReceipt`: a signed commitment to
 * the EXACT formed/refined mutations of a consolidation cycle, joined to its
 * counts-only receipt by `receipt_id` + `receipt_digest`. Two artifacts, two
 * privacy boundaries (docs/doctrine/felt-interior.md): the receipt is portable
 * and counts-only; this manifest is local and commits per-mutation digests so
 * a surface can prove the displayed sentences are exactly the signed cycle's
 * mutations — the receipt never carrying memory content.
 *
 * Domain-separated from the receipt family by `manifest_type` inside the
 * signed body (same `motebit-jcs-ed25519-b64-v1` suite, distinct committed
 * bytes). Commitments carry `content_sha256` — a one-way digest, never the
 * content — plus the committed `provenance` + `sensitivity` so a relabel or a
 * tier downgrade breaks the signature.
 *
 * See spec/consolidation-mutation-manifest-v1.md.
 */

import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

import type {
  ConsolidationMutationManifest,
  ConsolidationMutationCommitment,
} from "@motebit/protocol";

import { assembleJsonSchemaFor } from "./assemble.js";
import type { ParityForward, ParityReverse } from "./__parity/check.js";

export const CONSOLIDATION_MUTATION_MANIFEST_SCHEMA_ID =
  "https://raw.githubusercontent.com/motebit/motebit/main/spec/schemas/consolidation-mutation-manifest-v1.json";

const SensitivityLevelSchema = z
  .enum(["none", "personal", "medical", "financial", "secret"])
  .describe(
    "Sensitivity tier of the formed node, committed so a downgrade (which would loosen the felt-surface disclosure ceiling) breaks the signature.",
  );

const MemorySourceSchema = z
  .enum(["user_stated", "agent_inferred", "tool_derived", "peer_agent", "consolidation_derived"])
  .describe(
    "Provenance of the formed node, committed so a taught↔inferred relabel breaks the signature. Emitter-authored (docs/doctrine/memory-provenance.md).",
  );

// ---------------------------------------------------------------------------
// ConsolidationMutationCommitment — one formed/refined mutation, no content
// ---------------------------------------------------------------------------

export const ConsolidationMutationCommitmentSchema = z
  .object({
    node_id: z
      .string()
      .min(1)
      .describe(
        "The formed/refined memory node this commitment covers (opaque UUID, not authority).",
      ),
    kind: z
      .enum(["formed", "refined"])
      .describe("Creation vs modification — committed so a relabel breaks the signature."),
    content_sha256: z
      .string()
      .min(1)
      .describe(
        "SHA-256 (hex) of the node's content at formation. Commits to the exact displayed sentence WITHOUT carrying it (one-way). Local-only today; a keyed/salted commitment is the export-triggered follow-up.",
      ),
    provenance: MemorySourceSchema,
    sensitivity: SensitivityLevelSchema,
  })
  .passthrough();

// ---------------------------------------------------------------------------
// ConsolidationMutationManifest — signed adjunct to a ConsolidationReceipt
// ---------------------------------------------------------------------------

export const ConsolidationMutationManifestSchema = z
  .object({
    manifest_type: z
      .literal("consolidation_mutation_manifest")
      .describe(
        "Domain-separation discriminator inside the signed body — a receipt signature can never verify as a manifest. Distinct from the ContentArtifactType `artifact_type` registry; a manifest is not a content artifact.",
      ),
    schema_version: z
      .literal("1")
      .describe("Manifest schema version, independent of the receipt's."),
    manifest_id: z.string().min(1).describe("UUIDv4 — the manifest's own identity."),
    motebit_id: z
      .string()
      .min(1)
      .describe("Signer's MotebitId — the motebit that performed the cycle."),
    cycle_id: z
      .string()
      .min(1)
      .describe(
        "The cycle whose mutations this commits to — matches the receipt and the consolidation_cycle_run event.",
      ),
    receipt_id: z
      .string()
      .min(1)
      .describe(
        "The EXACT ConsolidationReceipt this supplements — not merely a reusable cycle id.",
      ),
    receipt_digest: z
      .string()
      .min(1)
      .describe(
        "Canonical SHA-256 (hex) of the signed ConsolidationReceipt body. A regenerated/substituted receipt breaks the link.",
      ),
    mutations: z
      .array(ConsolidationMutationCommitmentSchema)
      .describe(
        "Commitments to the cycle's formed/refined mutations, ordered by node_id for deterministic canonicalization.",
      ),
    created_at: z.number().describe("Formation time — milliseconds since Unix epoch."),
    public_key: z
      .string()
      .min(1)
      .optional()
      .describe("Hex Ed25519 public key of the signer, embedded for portable verification."),
    suite: z
      .literal("motebit-jcs-ed25519-b64-v1")
      .describe(
        "Cryptosuite — the same JCS+Ed25519+base64url recipe as the receipt family; domain separation is by manifest_type, not a distinct suite.",
      ),
    signature: z
      .string()
      .min(1)
      .describe("Base64url-encoded Ed25519 signature over canonicalJson(body_without_signature)."),
  })
  .passthrough();

type _CommitmentForward = ParityForward<
  ConsolidationMutationCommitment,
  z.infer<typeof ConsolidationMutationCommitmentSchema>
>;
type _CommitmentReverse = ParityReverse<
  ConsolidationMutationCommitment,
  z.infer<typeof ConsolidationMutationCommitmentSchema>
>;
export const _CONSOLIDATION_MUTATION_COMMITMENT_TYPE_PARITY: {
  forward: _CommitmentForward;
  reverse: _CommitmentReverse;
} = {
  forward: true,
  reverse: true,
};

type _ManifestForward = ParityForward<
  ConsolidationMutationManifest,
  z.infer<typeof ConsolidationMutationManifestSchema>
>;
type _ManifestReverse = ParityReverse<
  ConsolidationMutationManifest,
  z.infer<typeof ConsolidationMutationManifestSchema>
>;
export const _CONSOLIDATION_MUTATION_MANIFEST_TYPE_PARITY: {
  forward: _ManifestForward;
  reverse: _ManifestReverse;
} = {
  forward: true,
  reverse: true,
};

export function buildConsolidationMutationManifestJsonSchema(): Record<string, unknown> {
  const raw = zodToJsonSchema(ConsolidationMutationManifestSchema, {
    name: "ConsolidationMutationManifest",
    $refStrategy: "root",
    target: "jsonSchema7",
  }) as Record<string, unknown>;
  return assembleJsonSchemaFor("ConsolidationMutationManifest", raw, {
    $id: CONSOLIDATION_MUTATION_MANIFEST_SCHEMA_ID,
    title: "ConsolidationMutationManifest (v1)",
    description:
      "Signed owner-facing commitment to the exact formed/refined mutations of a consolidation cycle, joined to its counts-only ConsolidationReceipt by receipt_id + receipt_digest. Commits per-mutation content digests (never content), so a surface can prove displayed sentences are the signed cycle's mutations. Local-only this version. See spec/consolidation-mutation-manifest-v1.md.",
  });
}
