/**
 * Retention manifest wire schema — operator-published, signed,
 * browser-side re-verifiable. Sibling to operator-transparency.json
 * (docs/doctrine/operator-transparency.md), same suite, same staging.
 *
 * The manifest declares per-store retention policy. A user verifying a
 * relay's retention claims walks: signed manifest → declared shapes →
 * interop-law ceiling check → drift gate audit. Phase 6 wires the
 * browser-side verifier (`verifyRetentionManifest`) through the same
 * primitive pattern that `verifySkillBundle` (commit 87e2f174)
 * established.
 *
 * Signed under `motebit-jcs-ed25519-hex-v1` (matches transparency
 * manifest's suite, not the deletion certificate's b64 suite — manifest
 * artifacts use hex encoding).
 */

import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

import type { RetentionManifest } from "@motebit/protocol";

import { assembleJsonSchemaFor } from "./assemble.js";

// ---------------------------------------------------------------------------
// Stable $id URL
// ---------------------------------------------------------------------------

export const RETENTION_MANIFEST_SCHEMA_ID =
  "https://raw.githubusercontent.com/motebit/motebit/main/spec/schemas/retention-manifest-v1.json";

// ---------------------------------------------------------------------------
// Per-store declarations — wire projection of RetentionShape
// ---------------------------------------------------------------------------

const sensitivityCeilingMap = () =>
  z
    .record(z.string(), z.number())
    .describe(
      "Map of sensitivity-level string → max retention days. Keys: `none | personal | medical | financial | secret`. Values MUST be at-or-below `MAX_RETENTION_DAYS_BY_SENSITIVITY` for every key. `Infinity` is encoded as JSON's `null` — schemas accept either; verifiers normalize.",
    );

const MutablePruningDeclarationSchema = z
  .object({
    kind: z.literal("mutable_pruning"),
    max_retention_days_by_sensitivity: sensitivityCeilingMap(),
  })
  .strict();

const AppendOnlyHorizonDeclarationSchema = z
  .object({
    kind: z.literal("append_only_horizon"),
    horizon_advance_period_days: z
      .number()
      .nonnegative()
      .describe("How often the operator advances the store's horizon, in days."),
    witness_required: z
      .boolean()
      .describe(
        "Whether co-witness signatures are required on horizon certs for this store. Decision 9: this value is DERIVED from federation state — verifiers SHOULD cross-check against the operator's federation discovery surface (spec/discovery-v1.md) at manifest issuance time. A relay with peers cannot honestly publish `witness_required: false`.",
      ),
  })
  .strict();

const ConsolidationFlushDeclarationSchema = z
  .object({
    kind: z.literal("consolidation_flush"),
    flush_to: z
      .enum(["memory", "expire"])
      .describe(
        "Default disposition for flushed records that did not consolidate into a memory node.",
      ),
    has_min_floor_resolver: z
      .boolean()
      .describe(
        "Whether this store registers a per-record min-floor resolver (decision 3). When true, settlement-relevant records carry an obligation floor beyond the sensitivity floor. The resolver itself is BSL runtime code; the manifest declares only its presence so users can confirm the operator runs an obligation-aware flush.",
      ),
  })
  .strict();

const RetentionShapeDeclarationSchema = z.discriminatedUnion("kind", [
  MutablePruningDeclarationSchema,
  AppendOnlyHorizonDeclarationSchema,
  ConsolidationFlushDeclarationSchema,
]);

const RetentionStoreDeclarationSchema = z
  .object({
    store_id: z
      .string()
      .min(1)
      .describe("Stable identifier for the store within the operator's deployment."),
    store_name: z.string().min(1).describe("Human-readable name for tooling display."),
    shape: RetentionShapeDeclarationSchema,
  })
  .strict();

// ---------------------------------------------------------------------------
// RetentionManifest
// ---------------------------------------------------------------------------

export const RetentionManifestSchema = z
  .object({
    spec: z
      .literal("motebit/retention-manifest@1")
      .describe("Specification version. MUST be `motebit/retention-manifest@1` for this version."),
    operator_id: z
      .string()
      .min(1)
      .describe(
        "The operator publishing this manifest. Cross-references the operator-transparency manifest's `operator_id`.",
      ),
    issued_at: z.number().describe("Unix milliseconds when the manifest was signed."),
    stores: z
      .array(RetentionStoreDeclarationSchema)
      .describe(
        "Per-store retention declarations. The drift gate `check-retention-coverage` enumerates every store holding sensitivity-classified content and asserts each appears here.",
      ),
    pre_classification_default_sensitivity: z
      .enum(["none", "personal", "medical", "financial", "secret"])
      .optional()
      .describe(
        "Default sensitivity for un-classified pre-deploy records under `consolidation_flush` (decision 6b). Defaults to `personal` if omitted. The operator's lazy-classify-on-flush path uses this value as the floor until classification fires.",
      ),
    honest_gaps: z
      .array(z.string().min(1))
      .optional()
      .describe(
        "Operator-declared gaps. Same pattern as operator-transparency.md §'Reference implementation' — stage 1 ships with the chain-anchor in honest_gaps until stage 2.",
      ),
    suite: z
      .literal("motebit-jcs-ed25519-hex-v1")
      .describe(
        "Cryptosuite identifier. `motebit-jcs-ed25519-hex-v1`: JCS canonicalization, Ed25519 primitive, hex signature encoding, hex public-key encoding. Sibling to the operator-transparency manifest.",
      ),
    signature: z
      .string()
      .min(1)
      .describe(
        "Hex-encoded Ed25519 signature over `canonicalJson(manifest minus signature)`, signed by the operator's transparency key.",
      ),
  })
  .strict()
  .describe(
    "Operator-published retention manifest. Signed; browser-side re-verifiable through the same primitive pattern as verifySkillBundle (commit 87e2f174).",
  );

type _ManifestForward =
  RetentionManifest extends z.infer<typeof RetentionManifestSchema> ? true : never;
type _ManifestReverse =
  z.infer<typeof RetentionManifestSchema> extends RetentionManifest ? true : never;
export const _RETENTION_MANIFEST_TYPE_PARITY: {
  forward: _ManifestForward;
  reverse: _ManifestReverse;
} = {
  forward: true as _ManifestForward,
  reverse: true as _ManifestReverse,
};

export function buildRetentionManifestJsonSchema(): Record<string, unknown> {
  const raw = zodToJsonSchema(RetentionManifestSchema, {
    name: "RetentionManifest",
    $refStrategy: "root",
    target: "jsonSchema7",
  }) as Record<string, unknown>;
  return assembleJsonSchemaFor("RetentionManifest", raw, {
    $id: RETENTION_MANIFEST_SCHEMA_ID,
    title: "RetentionManifest (v1)",
    description:
      "Operator-published, signed retention manifest. Per-store policy declarations; user-verifiable against `MAX_RETENTION_DAYS_BY_SENSITIVITY` interop-law ceilings; sibling to /.well-known/motebit-transparency.json. See docs/doctrine/retention-policy.md.",
  });
}
