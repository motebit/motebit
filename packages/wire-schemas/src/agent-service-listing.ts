/**
 * AgentServiceListing — wire schema.
 *
 * A service listing is what an agent publishes to advertise its
 * capabilities on the relay (or any discovery surface). It is the
 * supply-side wire format: "I am this motebit, I can do these
 * capabilities, at these prices, with this SLA, here is my payout
 * address."
 *
 * Consumer side: discovery callers parse listings to select delegates.
 * Supplier side: any non-motebit worker that wants to offer services
 * via the motebit marketplace emits this shape, PUTs to the relay's
 * listing endpoint, and gets matched against incoming tasks. The
 * published JSON Schema lets Python/Go/Rust/Elixir workers participate
 * without bundling `@motebit/protocol`.
 *
 * Listings are NOT signed today — trust derives from the relay's
 * authentication of the publisher (the PUT is bearer-token'd to a
 * motebit_id). That's why no `signature` / `suite` fields appear
 * here. A future `AgentServiceListingAttestation` could sign the
 * listing directly for relay-optional discovery; that'd be a separate
 * wire format added to this package.
 */

import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

import type { AgentServiceListing } from "@motebit/protocol";

import { assembleJsonSchemaFor } from "./assemble.js";

/** Stable `$id` for the agent-service-listing v1 wire format. */
export const AGENT_SERVICE_LISTING_SCHEMA_ID =
  "https://raw.githubusercontent.com/motebit/motebit/main/packages/wire-schemas/schema/agent-service-listing-v1.json";

const CapabilityPriceSchema = z
  .object({
    capability: z
      .string()
      .min(1)
      .describe(
        "Capability identifier this price applies to (e.g. `web_search`, `summarize`, `*`). Must match a capability name listed in the parent listing's `capabilities` array, OR be `*` for a catch-all price.",
      ),
    unit_cost: z
      .number()
      .describe(
        "Price in the declared currency, as a plain number. Interpretation depends on `per`: per-task flat fee, per-tool-call increment, or per-token metered price.",
      ),
    currency: z
      .string()
      .min(1)
      .describe(
        "Currency code. USD for fiat; 'USDC' / 'USDT' / chain-token codes for on-chain settlement. Lowercase ISO-like codes are conventional but free-form by protocol.",
      ),
    per: z
      .enum(["task", "tool_call", "token"])
      .describe(
        "Pricing unit. `task` = one flat fee per completed task. `tool_call` = price per tool invocation inside the task. `token` = metered per input+output token (LLM billing).",
      ),
  })
  .strict();

export const AgentServiceListingSchema = z
  .object({
    listing_id: z
      .string()
      .min(1)
      .describe(
        "Stable listing identifier — UUIDv7 string. Unique per motebit; a motebit updating its listing reuses the same id (the relay treats PUT as upsert).",
      ),
    motebit_id: z
      .string()
      .min(1)
      .describe(
        "Motebit identity advertising this listing. Must match the authenticated publisher at the relay endpoint — listings cannot be published on behalf of other motebits.",
      ),
    capabilities: z
      .array(z.string().min(1))
      .describe(
        "Capability identifiers this agent claims to provide. Free-form strings; marketplace convention is snake_case (`web_search`, `summarize`, `pr_review`).",
      ),
    pricing: z
      .array(CapabilityPriceSchema)
      .describe(
        "Price schedule. Each entry pairs a capability with a per-unit cost. Entries whose `capability` does not appear in `capabilities` are ignored by matchers; `capability: '*'` sets a default price.",
      ),
    sla: z
      .object({
        max_latency_ms: z
          .number()
          .describe(
            "Self-declared upper bound on task completion latency, in milliseconds. Matchers penalize listings whose declared latency exceeds the consumer's tolerance.",
          ),
        availability_guarantee: z
          .number()
          .describe(
            "Self-declared availability as a fraction in [0, 1] (e.g. `0.99` = 99% uptime). Not SLO-enforced by the relay; consumed by matchers as a soft ranking signal.",
          ),
      })
      .strict()
      .describe(
        "Service-level declaration. Self-reported — verification comes from reputation and signed receipts, not from this field directly.",
      ),
    description: z
      .string()
      .describe(
        "Human-readable service description. Used in discovery UIs; not parsed by matchers. Empty string is allowed for minimal listings.",
      ),
    pay_to_address: z
      .string()
      .optional()
      .describe(
        "On-chain payout address for x402 settlement (e.g. EVM `0x…`). Absent = relay-custody settlement only; the agent cannot receive direct on-chain payments for these services.",
      ),
    regulatory_risk: z
      .number()
      .optional()
      .describe(
        "Self-declared regulatory risk score in [0, ∞). 0 = no risk. Accumulates along delegation chains via the RegulatoryRiskSemiring (min, +). Verified — when verified — by compliance credentials (VCs), not by this field alone.",
      ),
    updated_at: z
      .number()
      .describe(
        "Unix timestamp in milliseconds of the last listing update. The relay stamps this on PUT; consumers treat it as a freshness signal (stale listings may indicate offline agents).",
      ),
  })
  .strict();

// ---------------------------------------------------------------------------
// Type parity — drift defense #22 compile-time half
// ---------------------------------------------------------------------------

type InferredListing = z.infer<typeof AgentServiceListingSchema>;

// The TS declaration uses branded ID types (ListingId, MotebitId); the
// wire is just a string. Relax the branded fields to their structural
// equivalents for parity checking.
type BrandedToString<T> = {
  [K in keyof T]: T[K] extends string & { readonly __brand: unknown } ? string : T[K];
};

type _ForwardCheck = BrandedToString<AgentServiceListing> extends InferredListing ? true : never;
type _ReverseCheck = InferredListing extends BrandedToString<AgentServiceListing> ? true : never;

export const _AGENT_SERVICE_LISTING_TYPE_PARITY: {
  forward: _ForwardCheck;
  reverse: _ReverseCheck;
} = {
  forward: true as _ForwardCheck,
  reverse: true as _ReverseCheck,
};

// ---------------------------------------------------------------------------
// JSON Schema emitter
// ---------------------------------------------------------------------------

export function buildAgentServiceListingJsonSchema(): Record<string, unknown> {
  const raw = zodToJsonSchema(AgentServiceListingSchema, {
    name: "AgentServiceListing",
    $refStrategy: "root",
    target: "jsonSchema7",
  }) as Record<string, unknown>;
  return assembleJsonSchemaFor("AgentServiceListing", raw, {
    $id: AGENT_SERVICE_LISTING_SCHEMA_ID,
    title: "AgentServiceListing (v1)",
    description:
      "Supply-side wire format — what an agent publishes to advertise capabilities, pricing, and SLA to the motebit marketplace. Consumed by discovery matchers; emitted by agents (motebit or otherwise) via the relay's listing endpoint.",
  });
}
