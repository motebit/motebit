/**
 * Evidence-provenance wire schema — the re-verifiable shape an `EvidenceRef` may
 * carry so a verdict's evidence axis is re-checkable down to the primary record
 * (verifiable-locality from signatures to EVIDENCE).
 *
 * `EvidenceProvenance` holds when the named `span` is an exact substring of
 * `projection(bytes)`, where the bytes content-address to `digest` (re-verifiable
 * PRESENCE, never truth — `@motebit/crypto` `verifyEvidenceProvenance`). The
 * projection recipe id is carried OPAQUELY; motebit never owns the recipe catalog.
 * Unsigned — it is data a producer embeds, not itself a signed artifact, so it
 * pins no cryptosuite.
 *
 * See `spec/evidence-provenance-v1.md` and `docs/doctrine/evidence-provenance.md`.
 */

import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

import type { EvidenceProvenance, DigestAlgorithm } from "@motebit/protocol";
import { ALL_DIGEST_ALGORITHMS } from "@motebit/protocol";

import { assembleJsonSchemaFor } from "./assemble.js";
import type { ParityForward, ParityReverse } from "./__parity/check.js";

// ---------------------------------------------------------------------------
// Stable $id URL
// ---------------------------------------------------------------------------

export const EVIDENCE_PROVENANCE_SCHEMA_ID =
  "https://raw.githubusercontent.com/motebit/motebit/main/spec/schemas/evidence-provenance-v1.json";

// ---------------------------------------------------------------------------
// EvidenceProvenance
// ---------------------------------------------------------------------------

export const EvidenceProvenanceSchema = z
  .object({
    digest: z
      .object({
        algorithm: z
          // Cast preserves the literal `DigestAlgorithm` union in z.infer; runtime
          // validation is identical (z.enum checks the same ALL_DIGEST_ALGORITHMS values).
          .enum(ALL_DIGEST_ALGORITHMS as unknown as [DigestAlgorithm, ...DigestAlgorithm[]])
          .describe("Content-digest hash algorithm — `sha-256` today; agile by registry append."),
        value: z
          .string()
          .regex(/^[0-9a-f]+$/, "digest value MUST be lowercase hex")
          .describe(
            "Lowercase hex digest of the RAW, independently-obtainable bytes under `algorithm`.",
          ),
      })
      .strict()
      .describe(
        "Content address of the raw primary-record bytes a third party can independently fetch — NEVER the projected text.",
      ),
    projection: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Opaque, app-owned projection recipe id (e.g. agency.html-text.v1). Absent ⇒ the span is located over the raw bytes directly; present ⇒ a re-verifier applies the consumer-injected recipe, else fails closed (projection_unresolved).",
      ),
    span: z
      .string()
      .describe("The verbatim span asserted PRESENT in projection(bytes) — the law's subject."),
    locator: z
      .object({ start: z.number().int(), end: z.number().int() })
      .strict()
      .optional()
      .describe(
        "Advisory locator narrowing where the span sits. NOT load-bearing — the law is exact-substring presence, never a second thing a re-verifier must reproduce.",
      ),
    binding: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Opaque resolved-identity reference (a motebit_id or a domain token the consumer resolves). CARRIED, NOT verified by the law — issuer authority is app-layer.",
      ),
  })
  .strict();

type _InferredProvenance = z.infer<typeof EvidenceProvenanceSchema>;
type _ProvenanceForward = ParityForward<EvidenceProvenance, _InferredProvenance>;
type _ProvenanceReverse = ParityReverse<EvidenceProvenance, _InferredProvenance>;

export const _EVIDENCE_PROVENANCE_TYPE_PARITY: {
  forward: _ProvenanceForward;
  reverse: _ProvenanceReverse;
} = {
  forward: true,
  reverse: true,
};

export function buildEvidenceProvenanceJsonSchema(): Record<string, unknown> {
  const raw = zodToJsonSchema(EvidenceProvenanceSchema, {
    name: "EvidenceProvenance",
    $refStrategy: "root",
    target: "jsonSchema7",
  }) as Record<string, unknown>;
  return assembleJsonSchemaFor("EvidenceProvenance", raw, {
    $id: EVIDENCE_PROVENANCE_SCHEMA_ID,
    title: "EvidenceProvenance (v1)",
    description:
      "The re-verifiable provenance an EvidenceRef may carry — a content-addressed verbatim span in a primary record (the digest is over the RAW independently-obtainable bytes, the projection recipe is opaque and app-owned). Re-verifiable presence, never truth. See spec/evidence-provenance-v1.md.",
  });
}
