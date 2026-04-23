/**
 * RouteScore — wire schema.
 *
 * The relay's per-candidate routing score envelope. When a delegator
 * submits an AgentTask, the relay computes a RouteScore for each
 * candidate executor (matching the requested capabilities + scoped by
 * routing policy) and selects one. The TaskResponse can include the
 * selected candidate's score plus the runners-up so the delegator
 * understands WHY this executor was chosen.
 *
 * This is the routing-transparency artifact. Without it, "why did the
 * relay route me to agent X?" is unanswerable from outside the relay's
 * code; with it, any external client can audit the composite score and
 * its sub-components against their own ranking model.
 *
 * Six sub-scores feed the composite:
 *   - trust            — accumulated reputation signal for this executor
 *   - success_rate     — historical completion rate
 *   - latency          — inverse of declared / observed wall-clock latency
 *   - price_efficiency — cost-per-unit-quality
 *   - capability_match — how well the executor's listing matches the request
 *   - availability     — declared uptime guarantee × observed uptime
 *
 * The exact weighting is a relay-policy concern (semiring-driven, see
 * `@motebit/semiring`); the wire schema commits only to the score
 * envelope, not to how `composite` was derived from the sub-scores.
 *
 * See spec/market-v1.md and the routing strategy docs for the policy
 * surface that produces these scores.
 */

import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

import type { RouteScore } from "@motebit/protocol";

import { assembleJsonSchemaFor } from "./assemble.js";

/** Stable `$id` for the route-score v1 wire format. */
export const ROUTE_SCORE_SCHEMA_ID =
  "https://raw.githubusercontent.com/motebit/motebit/main/spec/schemas/route-score-v1.json";

const SubScoresSchema = z
  .object({
    trust: z
      .number()
      .describe(
        "Accumulated reputation signal for this executor. Range and weighting are relay-policy; higher is better.",
      ),
    success_rate: z
      .number()
      .describe(
        "Historical completion rate as a fraction in [0, 1]. Computed from the executor's prior receipts that match the requested capabilities.",
      ),
    latency: z
      .number()
      .describe(
        "Latency component of the routing score. Conventionally inverse of declared/observed wall-clock latency in milliseconds, so higher = faster. Exact transform is relay-policy.",
      ),
    price_efficiency: z
      .number()
      .describe(
        "Cost-per-unit-quality component. Higher = cheaper for the same expected outcome. Exact transform is relay-policy.",
      ),
    capability_match: z
      .number()
      .describe(
        "How well the executor's AgentServiceListing.capabilities matches the request's required_capabilities. Range and weighting are relay-policy; higher is better.",
      ),
    availability: z
      .number()
      .describe(
        "Availability component, conventionally `declared availability_guarantee × observed uptime`. Higher is better.",
      ),
  })
  .strict()
  .describe(
    "Per-dimension scores that feed the composite. The exact weighting is relay-policy (semiring-driven); the wire schema commits to the envelope only.",
  );

export const RouteScoreSchema = z
  .object({
    motebit_id: z.string().min(1).describe("The candidate executor's motebit identity (UUIDv7)."),
    composite: z
      .number()
      .describe(
        "Composite score derived from `sub_scores` via the relay's routing policy. Higher is better. The relay selects the candidate with the highest `composite`; ties are broken by relay-policy (typically trust then latency).",
      ),
    sub_scores: SubScoresSchema,
    selected: z
      .boolean()
      .describe(
        "True if this candidate was the routing decision. Exactly one RouteScore in a routing batch should have `selected: true`; the rest are runners-up included for transparency.",
      ),
  })
  // Unsigned envelope — forward-compat per "unknown fields MUST be ignored"
  // (delegation-v1 §3.1, applied across unsigned envelopes). The inner
  // `sub_scores` keeps `.strict()` because the six dimensions are a
  // protocol-defined closed surface — adding a "creativity" axis there
  // would be a protocol versioning event, not silent forward-compat.
  // NOTE (audit follow-up): RouteScore is unsigned today, so a relay can
  // claim any composite without proof. Routing transparency is a UX hint,
  // not a binding claim. Tracked as a protocol-level gap.
  .passthrough();

// ---------------------------------------------------------------------------
// Type parity — drift defense #22 compile-time half
// ---------------------------------------------------------------------------

type InferredRouteScore = z.infer<typeof RouteScoreSchema>;

// RouteScore uses branded MotebitId; relax to string for structural
// parity (the wire is just a string, brand is a TS-only guard).
type BrandedToString<T> = {
  [K in keyof T]: T[K] extends string & { readonly __brand: unknown } ? string : T[K];
};

type _ForwardCheck = BrandedToString<RouteScore> extends InferredRouteScore ? true : never;
type _ReverseCheck = InferredRouteScore extends BrandedToString<RouteScore> ? true : never;

export const _ROUTE_SCORE_TYPE_PARITY: {
  forward: _ForwardCheck;
  reverse: _ReverseCheck;
} = {
  forward: true as _ForwardCheck,
  reverse: true as _ReverseCheck,
};

// ---------------------------------------------------------------------------
// JSON Schema emitter
// ---------------------------------------------------------------------------

export function buildRouteScoreJsonSchema(): Record<string, unknown> {
  const raw = zodToJsonSchema(RouteScoreSchema, {
    name: "RouteScore",
    $refStrategy: "root",
    target: "jsonSchema7",
  }) as Record<string, unknown>;
  return assembleJsonSchemaFor("RouteScore", raw, {
    $id: ROUTE_SCORE_SCHEMA_ID,
    title: "RouteScore (v1)",
    description:
      "Per-candidate routing score envelope. The relay computes one of these for each executor candidate and selects the highest composite. Carried in TaskResponse so delegators can audit the routing decision. See spec/market-v1.md.",
  });
}
