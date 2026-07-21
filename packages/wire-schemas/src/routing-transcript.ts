/**
 * RoutingDecisionTranscript wire schema — the routing arc's proof artifact
 * (docs/doctrine/routing-decision-transcript.md, Inc 2;
 * spec/routing-transcript-v1.md).
 *
 * Receipt-family (subject = signer): the delegator signs a record of its own
 * act of choosing. The zod source here is BSL; the generated JSON Schema is
 * committed Apache-2.0 under `spec/schemas/` (wire-schemas CLAUDE.md).
 *
 * Strictness discipline: every object is `.strict()` — an unknown field is a
 * different wire format, not an extension point. The suite is pinned as a
 * literal (Rule 6): a new suite arrives as a new transcript version, never a
 * widening of this schema.
 */

import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

import type { RoutingDecisionTranscript, TranscriptCandidate } from "@motebit/protocol";

import { assembleJsonSchemaFor } from "./assemble.js";
import type { ParityForward, ParityReverse } from "./__parity/check.js";

export const ROUTING_TRANSCRIPT_SCHEMA_ID =
  "https://raw.githubusercontent.com/motebit/motebit/main/spec/schemas/routing-transcript-v1.json";

/**
 * One member of the frozen admissible candidate set — the inputs the ranking
 * actually consumed, as literal values. `bonded` is literal `true` or absent
 * (the explicit-true discipline: the flag asserts a verified fact or stays
 * silent). The posterior triple (`alpha`, `beta`, `theta`) is present only in
 * explore mode; `theta` is redundant with (alpha, beta, seed) by construction
 * and is re-derived by the faithfulness rung.
 */
export const TranscriptCandidateSchema = z
  .object({
    motebit_id: z.string().min(1),
    unit_cost: z.number().nonnegative().optional(),
    bonded: z.literal(true).optional(),
    trust_axis: z.number(),
    reliability_axis: z.number(),
    alpha: z.number().int().positive().optional(),
    beta: z.number().int().positive().optional(),
    theta: z.number().optional(),
  })
  .strict();

export const RoutingDecisionTranscriptSchema = z
  .object({
    spec: z
      .literal("motebit/routing-transcript@1.0")
      .describe("Wire-format version discriminator."),
    capability: z.string().describe("The capability hired for."),
    delegator_motebit_id: z
      .string()
      .min(1)
      .describe("The delegator — the chooser and the signer (subject = signer)."),
    delegator_public_key: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .describe("The delegator's Ed25519 public key, lowercase hex."),
    candidates: z
      .array(TranscriptCandidateSchema)
      .min(1)
      .describe("The frozen admissible candidate set, in ranked order."),
    seed: z
      .string()
      .describe(
        "Seed provenance: the tick token's Ed25519 signature — binds the transcript to the delegation turn; per-candidate draw seed is `${seed}|${motebit_id}`.",
      ),
    strength: z
      .number()
      .min(0)
      .max(1)
      .describe("Base exploration strength in [0,1], before any bond boost."),
    weights: z
      .object({
        trust: z.number(),
        reliability: z.number(),
        cost: z.number(),
        latency: z.number(),
      })
      .strict()
      .describe("The composite weights the ranking consumed."),
    count_cap: z
      .number()
      .int()
      .positive()
      .describe("Evidence cap applied to posterior counts (frozen ranker-internal literal)."),
    bond_explore_boost: z
      .number()
      .positive()
      .describe("Multiplicative bond exploration boost (frozen ranker-internal literal)."),
    default_latency_ms: z
      .number()
      .nonnegative()
      .describe("Neutral latency (ms) assumed per candidate (frozen ranker-internal literal)."),
    algorithm_version: z
      .string()
      .min(1)
      .describe("The ranking-implementation version this transcript is recomputable under."),
    winner_motebit_id: z
      .string()
      .min(1)
      .describe("The worker hired; MUST be a member of `candidates`."),
    pinned: z
      .literal(true)
      .optional()
      .describe(
        "Present (true) only when the hire was a pinned deterministic override — no draw ran.",
      ),
    explored: z.boolean().describe("Whether the exploration draw overrode the exploit-favorite."),
    issued_at: z.number().int().nonnegative().describe("Decision time, epoch milliseconds."),
    suite: z
      .literal("motebit-jcs-ed25519-b64-v1")
      .describe("Cryptosuite (pinned literal — new suites arrive as new transcript versions)."),
    signature: z
      .string()
      .min(1)
      .describe("Ed25519 over the JCS-canonical transcript minus this field, base64url."),
  })
  .strict();

// ---------------------------------------------------------------------------
// Type parity — zod inference must match the @motebit/protocol declaration
// ---------------------------------------------------------------------------

type InferredTranscript = z.infer<typeof RoutingDecisionTranscriptSchema>;
type InferredCandidate = z.infer<typeof TranscriptCandidateSchema>;

type _ForwardCheck = ParityForward<RoutingDecisionTranscript, InferredTranscript>;
type _ReverseCheck = ParityReverse<RoutingDecisionTranscript, InferredTranscript>;
type _CandidateForward = ParityForward<TranscriptCandidate, InferredCandidate>;

// If the zod schema diverges from the TypeScript declaration these aliases
// resolve to `never` and `tsc --noEmit` fails at this line.
export const _ROUTING_TRANSCRIPT_TYPE_PARITY: {
  forward: _ForwardCheck;
  reverse: _ReverseCheck;
  candidate: _CandidateForward;
} = {
  forward: true,
  reverse: true,
  candidate: true,
};

// ---------------------------------------------------------------------------
// JSON Schema emitter
// ---------------------------------------------------------------------------

/**
 * Build the JSON Schema (draft-07) object for RoutingDecisionTranscript.
 * Pure — called from the build-schemas script and from the drift test.
 */
export function buildRoutingTranscriptJsonSchema(): Record<string, unknown> {
  const raw = zodToJsonSchema(RoutingDecisionTranscriptSchema, {
    name: "RoutingDecisionTranscript",
    $refStrategy: "root",
    target: "jsonSchema7",
  }) as Record<string, unknown>;
  return assembleJsonSchemaFor("RoutingDecisionTranscript", raw, {
    $id: ROUTING_TRANSCRIPT_SCHEMA_ID,
    title: "RoutingDecisionTranscript (v1)",
    description:
      "Signed routing-decision transcript (subject = signer — receipt-family): the delegator's own record of why a worker won a paid hire. Freezes the admissible candidate set, per-candidate posterior reads and draws, and the decision parameters; integrity verified by verifyRoutingTranscript in @motebit/crypto, faithfulness recomputed by recomputeRoutingDecision in @motebit/semiring under the pinned algorithm_version. Spec: spec/routing-transcript-v1.md.",
  });
}
