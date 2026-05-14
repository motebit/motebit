/**
 * BYOK auto-router — the second consumer of `dispatchRouting`.
 *
 * Doctrine: `docs/doctrine/auto-routing-as-protocol-primitive.md`
 * § "Three-instance endgame" — auto-routing is
 * `f(TaskShape × ProviderCapability × Constraints) → RoutingDecision`.
 * PR 1 shipped motebit-cloud-proxy as the first consumer (2026-05-13);
 * PR 2 (this module) ships BYOK as the second.
 *
 * **What this module is.** The protocol-side composition of three
 * primitives every BYOK consumer needs:
 *
 *   1. `BYOK_MODEL_CATALOG` — per-vendor `ProviderCapability[]` with
 *      pricing, jurisdiction, lab, host. Sourced from the same pricing
 *      table the proxy uses in `services/proxy/src/validation.ts`
 *      (`MODEL_CONFIG`), extended with DeepSeek (the only BYOK-only
 *      vendor — proxy doesn't host it). Adding a vendor means adding
 *      a `ByokVendor` registry entry in `@motebit/sdk` AND adding the
 *      vendor's catalog entries here.
 *
 *   2. `extractTaskShape(text)` — heuristic shape detector. BYOK
 *      consumers can't afford the LLM-classifier roundtrip the proxy
 *      uses (`classifyTask` in `services/proxy/src/auto-routing.ts`
 *      runs a Haiku call per turn, billed to the operator's balance).
 *      A BYOK user pays providers directly; an extra call per turn
 *      would double their cost. Heuristic detection (keyword + length
 *      + token-shape) stays cheap and predictable; consumers that
 *      want classifier-level accuracy can override.
 *
 *   3. `dispatchByokRouting(text, vendor, constraints?)` — composes
 *      the above with `dispatchRouting`. The single entry point
 *      surface runtimes consume. Returns the typed `RoutingDecision`
 *      (`route` | `fallback` | `deny`); the surface handles all three
 *      per the drift-gate-enforced contract.
 *
 * **What this module is NOT.** Not the runtime integration. The
 * surface runtimes (`apps/web`, `apps/desktop`, `apps/mobile`) call
 * `dispatchByokRouting` per turn when their `ByokProviderConfig.autoRoute`
 * is true, and apply the resulting model to the in-flight provider
 * call. Each surface's consumer site is registered in the drift gate
 * `check-routing-decision-coverage` (#95).
 *
 * **What this module does NOT enforce.** No balance filter — BYOK
 * users pay providers directly. No jurisdiction filter by default —
 * BYOK is sovereign-shaped; if a user has keys for a vendor they've
 * chosen the jurisdiction implicitly. Surfaces that want
 * jurisdiction-aware BYOK pass an explicit `RoutingConstraint`.
 *
 * Per the closure pattern in `agility-as-role.md`: `TaskShape` is the
 * role (closed registry); the routing-policy is a consumer-side
 * function. BYOK consumers default to `REFERENCE_ROUTING_POLICY` (the
 * canonical default) but may override.
 */

import type { ByokVendor } from "@motebit/sdk";
import type {
  ProviderCapability,
  RoutingConstraint,
  RoutingDecision,
  TaskShape,
} from "@motebit/protocol";

import { dispatchRouting, REFERENCE_ROUTING_POLICY } from "./auto-router.js";

// === BYOK model catalog =====================================================

/**
 * Per-vendor `ProviderCapability` catalog for BYOK auto-routing.
 * Pricing sourced from `services/proxy/src/validation.ts::MODEL_CONFIG`
 * for the four vendors the proxy hosts (anthropic / openai / google /
 * groq); DeepSeek added here as the BYOK-only fifth vendor.
 *
 * Catalog ordering is the consumer's preference signal — earlier
 * entries are preferred when the dispatcher falls back. Each vendor's
 * entries are ordered tier-strong-to-fast (matching the convention
 * in `@motebit/sdk/src/models.ts::ANTHROPIC_MODELS` etc.).
 *
 * The catalog is `as const satisfies Record<ByokVendor, ...>` — a new
 * `ByokVendor` registry entry that's not added here is a TypeScript
 * error at this module's compile site, not a runtime surprise. The
 * exhaustive shape doubles as the registry-mirror gate; no drift
 * scanner needed.
 */
export const BYOK_MODEL_CATALOG = {
  anthropic: [
    {
      modelName: "claude-opus-4-7",
      host: "anthropic",
      lab: "anthropic",
      jurisdiction: "US",
      inputCostPerMillion: 5.0,
      outputCostPerMillion: 25.0,
    },
    {
      modelName: "claude-sonnet-4-6",
      host: "anthropic",
      lab: "anthropic",
      jurisdiction: "US",
      inputCostPerMillion: 3.0,
      outputCostPerMillion: 15.0,
    },
    {
      modelName: "claude-haiku-4-5-20251001",
      host: "anthropic",
      lab: "anthropic",
      jurisdiction: "US",
      inputCostPerMillion: 1.0,
      outputCostPerMillion: 5.0,
    },
  ],
  openai: [
    {
      modelName: "gpt-5.4",
      host: "openai",
      lab: "openai",
      jurisdiction: "US",
      inputCostPerMillion: 2.5,
      outputCostPerMillion: 15.0,
    },
    {
      modelName: "gpt-5.4-mini",
      host: "openai",
      lab: "openai",
      jurisdiction: "US",
      inputCostPerMillion: 0.75,
      outputCostPerMillion: 4.5,
    },
    {
      modelName: "gpt-5.4-nano",
      host: "openai",
      lab: "openai",
      jurisdiction: "US",
      inputCostPerMillion: 0.2,
      outputCostPerMillion: 1.25,
    },
  ],
  google: [
    {
      modelName: "gemini-2.5-pro",
      host: "google",
      lab: "google",
      jurisdiction: "US",
      inputCostPerMillion: 1.25,
      outputCostPerMillion: 10.0,
    },
    {
      modelName: "gemini-2.5-flash",
      host: "google",
      lab: "google",
      jurisdiction: "US",
      inputCostPerMillion: 0.3,
      outputCostPerMillion: 2.5,
    },
    {
      modelName: "gemini-2.5-flash-lite",
      host: "google",
      lab: "google",
      jurisdiction: "US",
      inputCostPerMillion: 0.1,
      outputCostPerMillion: 0.4,
    },
  ],
  groq: [
    {
      modelName: "llama-3.3-70b-versatile",
      host: "groq",
      lab: "meta",
      jurisdiction: "US",
      inputCostPerMillion: 0.59,
      outputCostPerMillion: 0.79,
    },
    {
      modelName: "openai/gpt-oss-120b",
      host: "groq",
      lab: "openai",
      jurisdiction: "US",
      inputCostPerMillion: 0.15,
      outputCostPerMillion: 0.75,
    },
  ],
  // DeepSeek is the BYOK-only vendor — proxy doesn't host it (the
  // jurisdiction predicate `MOTEBIT_CLOUD_ALLOWED_JURISDICTIONS` in
  // `services/proxy/src/validation.ts` excludes CN). BYOK users
  // route directly to DeepSeek's API at `api.deepseek.com` and
  // accept the jurisdiction tradeoff implicitly via their key
  // choice. Per `feedback_no_mote_stablecoin` sibling pattern —
  // sovereignty trumps tier-gating.
  deepseek: [
    {
      modelName: "deepseek-chat",
      host: "openai", // OpenAI-compatible wire protocol
      lab: "openai", // (Lab field is uninformative for DeepSeek today;
      // adding "deepseek" as a ModelLab is a separate
      // protocol-level append when justified by routing
      // semantics. For now, the lab field is informational
      // for non-routing consumers.)
      jurisdiction: "CN",
      inputCostPerMillion: 0.27,
      outputCostPerMillion: 1.1,
    },
  ],
} as const satisfies Record<ByokVendor, readonly ProviderCapability[]>;

/**
 * Return the BYOK catalog for a vendor. Pure dispatch on the union;
 * a new `ByokVendor` addition fails to compile until the catalog
 * grows an entry.
 */
export function buildByokCatalog(vendor: ByokVendor): readonly ProviderCapability[] {
  return BYOK_MODEL_CATALOG[vendor];
}

// === TaskShape heuristic ====================================================

/**
 * Heuristic-mode TaskShape detector. Returns the closed-registry
 * `TaskShape` value (`@motebit/protocol`) the message-text shape
 * most resembles.
 *
 * BYOK consumers pay providers directly per call; a per-message
 * LLM-classifier roundtrip (the pattern the proxy uses via
 * `classifyTask` in `services/proxy/src/auto-routing.ts`) would
 * double the user's cost on every turn. Heuristics keep dispatch
 * free and predictable.
 *
 * Heuristic order (first match wins):
 *
 *   1. `code` — message contains a fenced code block (```), a
 *      bracketed function/method shape, or a `<tag>`/`</tag>` pair.
 *      Reasoning: code blocks reliably tag code-generation /
 *      debugging / refactor tasks.
 *   2. `math` — message contains LaTeX math (`$...$`, `\frac`,
 *      `\sum`, `\int`) or equation-shaped operators
 *      (`solve for`, `derive`, `prove`, `compute`).
 *   3. `research` — message contains a long-form synthesis cue
 *      (`research`, `compare`, `summarize` + length-cue) and is
 *      > 800 chars (the long-context tier).
 *   4. `reasoning` — message contains chain-of-thought cues
 *      (`step by step`, `walk through`, `explain why`, `think
 *      carefully`) OR is between 400-800 chars (the deliberation
 *      tier).
 *   5. `creative` — message contains creative-writing cues
 *      (`write a`, `poem`, `story`, `imagine`, `pretend`).
 *   6. `quick` — message is < 80 chars (the sub-second-feel tier).
 *   7. Default → `chat`.
 *
 * Order is intentional: stronger signal (literal code block) wins
 * over weaker signal (length). Consumers wanting classifier-level
 * accuracy compose their own detector and pass the result directly
 * to `dispatchRouting`; this is the cheap default that ships with
 * BYOK auto-routing.
 *
 * Future-work: a small token-shape ML classifier (mediocre but fast,
 * < 1ms) replaces this heuristic when the doctrine arc lands. The
 * function signature stays `(text: string) → TaskShape` so the
 * substitution is a pure-function swap.
 */
export function extractTaskShape(text: string): TaskShape {
  const trimmed = text.trim();
  if (trimmed.length === 0) return "chat";
  const lower = trimmed.toLowerCase();

  // 1. Code signals — fenced block, function shape, HTML/XML tag pair.
  if (/```[\s\S]*?```/.test(trimmed)) return "code";
  if (/\bfunction\s+\w+\s*\(/.test(trimmed)) return "code";
  if (/<\/[a-zA-Z]\w*>/.test(trimmed)) return "code";
  if (/\b(refactor|debug|fix this code|implement|write a function)\b/.test(lower)) return "code";

  // 2. Math signals — LaTeX or equation operators.
  if (/\$[^$]+\$/.test(trimmed)) return "math";
  if (/\\(frac|sum|int|prod|sqrt|integral)\b/.test(trimmed)) return "math";
  if (/\b(solve for|derive|prove|compute|integrate|differentiate)\b/.test(lower)) return "math";

  // 3. Research signals — long-form synthesis cue + length.
  const researchCue = /\b(research|compare|summarize|synthesize|literature)\b/.test(lower);
  if (researchCue && trimmed.length > 800) return "research";

  // 4. Reasoning signals — chain-of-thought cues OR deliberation length.
  if (/\b(step by step|walk through|explain why|think carefully|reason through)\b/.test(lower)) {
    return "reasoning";
  }
  if (trimmed.length >= 400 && trimmed.length <= 800) return "reasoning";

  // 5. Creative signals — creative-writing cues.
  if (/\b(write a (poem|story|song)|imagine|pretend|fictional)\b/.test(lower)) return "creative";

  // 6. Quick — sub-second-feel tier.
  if (trimmed.length < 80) return "quick";

  // 7. Default — conversational.
  return "chat";
}

// === Composed dispatcher ====================================================

/**
 * Compose `extractTaskShape` + `buildByokCatalog` + `dispatchRouting`
 * into a single entry point for BYOK consumers.
 *
 * Per turn, BYOK surface runtimes call this with the inbound message
 * text + the user's configured vendor + optional constraints
 * (jurisdiction override, cost ceiling). Returns the typed
 * `RoutingDecision` — surfaces handle all three discriminator values
 * (`route` | `fallback` | `deny`) per the drift-gate-enforced
 * contract in `check-routing-decision-coverage` (#95).
 *
 * No balance filter — BYOK consumers pay providers directly; balance
 * is motebit-cloud-specific. The dispatcher stays consumer-neutral
 * (per the doctrine separation between protocol-layer
 * `RoutingConstraint` and consumer-side wrappers like
 * `applyBalanceFilter`).
 *
 * Surfaces that want classifier-level shape detection compose:
 *
 *   ```ts
 *   const shape = await classifyWithLLM(text, apiKey);
 *   const decision = dispatchRouting(shape, buildByokCatalog(vendor),
 *     constraints ?? {}, REFERENCE_ROUTING_POLICY);
 *   ```
 *
 * Surfaces that want the cheap heuristic default just call this.
 */
export function dispatchByokRouting(
  text: string,
  vendor: ByokVendor,
  constraints: RoutingConstraint = {},
): RoutingDecision {
  const taskShape = extractTaskShape(text);
  const catalog = buildByokCatalog(vendor);
  return dispatchRouting(taskShape, catalog, constraints, REFERENCE_ROUTING_POLICY);
}

/**
 * Human-readable summary of a BYOK routing decision — for
 * observability surfaces (chrome narration, audit logs, dev tools).
 * Pattern-matches every `RoutingDecision.kind` value so the drift
 * gate's discriminator-coverage check fires on every variant.
 *
 * `route` → "picked <model>: <reason>"
 * `fallback` → "wanted <primary>, used <backup>: <reason>"
 * `deny` → "denied: <reason>"
 */
export function describeByokRoutingDecision(decision: RoutingDecision): string {
  switch (decision.kind) {
    case "route":
      return `picked ${decision.model}: ${decision.reason}`;
    case "fallback":
      return `wanted ${decision.primary}, used ${decision.backup}: ${decision.reason}`;
    case "deny":
      return `denied: ${decision.reason}`;
  }
}
