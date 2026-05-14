/**
 * Routing primitive — closed-registry types for the auto-router.
 *
 * The auto-router is the model-selection counterpart to the chrome
 * matrix: `f(TaskShape × ProviderCapability × Constraints) →
 * RoutingDecision`. This module defines the wire-shape types; the
 * judgment-layer dispatcher (`dispatchRouting`) lives in BSL
 * `@motebit/policy/src/auto-router.ts`. Consumers (motebit-cloud
 * proxy, BYOK web layer, on-device runtime) call the dispatcher
 * with their own provider catalogs.
 *
 * **Closed registry shape** — same closure pattern as `SuiteId`,
 * `TokenAudience`, `ToolMode`, `ContentArtifactType`. The `TaskShape`
 * literal union is the wire law; named constants are developer
 * ergonomics; `ALL_TASK_SHAPES` is the canonical iteration order.
 * Adding a task shape is intentional protocol-level work: a new
 * entry here, a new arm in `REFERENCE_ROUTING_POLICY`, drift-gate
 * coverage on every consumer.
 *
 * **TaskShape agility — the 7th instance of agility-as-role.**
 * Per [`docs/doctrine/agility-as-role.md`], `TaskShape` is the
 * closed registry (the role); the routing-policy itself is a
 * consumer-side function (`Record<TaskShape, string>` today,
 * potentially a learned function in the future) that branches on
 * it. Distinguishing role (registry-shape) from policy
 * (function-shape) avoids the conflation the codebase corrected
 * for `Provider → InferenceHost`.
 *
 * **Lifted from `services/proxy/src/validation.ts`** (commit
 * 95e3b7af's intelligence-source-agility refactor anticipated this
 * landing site — the three unions `InferenceHost`, `ModelLab`,
 * `Jurisdiction` were always destined for the protocol layer once
 * a second consumer arrived):
 *   - `InferenceHost` — where the HTTP request actually goes.
 *   - `ModelLab` — who trained the weights.
 *   - `Jurisdiction` — legal locus of the host.
 *
 * Permissive floor, type-only, zero runtime deps. The dispatcher's
 * judgment lives in `@motebit/policy`; this file stays pure types
 * + closed-registry constants.
 */

import type { SensitivityLevel } from "./index.js";

// === Inference-source axes (lifted from services/proxy/src/validation.ts) ===

/**
 * Where the HTTP request actually goes. The processor that receives
 * the prompt bytes. Anthropic/OpenAI/Google appear here because they
 * run their own hosted inference; Groq appears here because they
 * host other labs' open-source weights on LPU hardware. `local-server`
 * is the on-device case: the request goes to the user's own
 * inference server (Ollama, LM Studio, llama.cpp, Jan, vLLM,
 * text-generation-webui — all expose `/v1/chat/completions` via
 * the OpenAI-compat shim), so the "host" is the user's own
 * machine. Mirrors the `OnDeviceBackend` value of the same name
 * in `@motebit/sdk`.
 *
 * The proxy NEVER routes to `local-server` — it's the on-device
 * consumer's host. The proxy's exhaustive switches throw
 * defensively when they encounter this value, naming the
 * structural violation rather than silently degrading. Doctrine:
 * `docs/doctrine/auto-routing-as-protocol-primitive.md` § "PR 3 —
 * on-device consumer".
 *
 * Closed registry — adding a host is a protocol-level append +
 * `MOTEBIT_CLOUD_ALLOWED_JURISDICTIONS` admission decision +
 * downstream consumer updates.
 */
export type InferenceHost = "anthropic" | "openai" | "google" | "groq" | "local-server";

/**
 * Who trained the weights. Anthropic/OpenAI/Google appear here
 * because they trained Claude/GPT/Gemini respectively; Meta appears
 * here because Llama 3.3 70B is Meta's model (Groq just hosts it).
 * OpenAI appears in BOTH this union AND `InferenceHost` (host =
 * "openai" for gpt-5.4 at api.openai.com; lab = "openai" for
 * gpt-oss-120b released as open weights and hosted by Groq). That's
 * structurally correct — same entity can serve different roles.
 *
 * Mistral / Microsoft / Alibaba added 2026-05-14 alongside the PR 3
 * on-device consumer landing: Mistral AI trains Mistral models,
 * Microsoft trains Phi, Alibaba trains Qwen. All three appear as
 * `lab` in the `ON_DEVICE_MODEL_CATALOG` (`@motebit/policy/on-device-router.ts`)
 * since the canonical local-server suggested-models list
 * (`@motebit/sdk::LOCAL_SERVER_SUGGESTED_MODELS`) includes Mistral,
 * Phi-3, and Qwen2 alongside the existing Meta/Google entries. The
 * proxy never sees these labs (it doesn't host their models); the
 * registry expansion is purely consumer-side (the on-device
 * dispatcher's catalog), which is why the registry's stated semantic
 * "who trained the weights" generalizes cleanly without protocol-
 * layer churn.
 *
 * Closed registry — adding a lab requires a model entry citing it.
 */
export type ModelLab =
  | "anthropic"
  | "openai"
  | "google"
  | "meta"
  | "mistral"
  | "microsoft"
  | "alibaba";

/**
 * Legal locus of the host. Reflective of physical/legal reality,
 * not pluggable. Drives the motebit-cloud admission predicate
 * (`MOTEBIT_CLOUD_ALLOWED_JURISDICTIONS` in
 * `services/proxy/src/validation.ts`). You can't swap a host's
 * jurisdiction; the registry reflects legal reality.
 *
 * NOT an agility-as-role instance — it's a typed admission
 * predicate, not a swappable role. Per
 * [`docs/doctrine/agility-as-role.md`], jurisdiction lifts the
 * previously-tribal "DeepSeek-is-BYOK-only-because-Chinese-hosted"
 * decision into structural enforcement.
 */
export type Jurisdiction = "US" | "CN" | "EU";

// === Task-shape registry — the 7th agility-as-role instance =================

/**
 * The closed set of task categories the auto-router branches on.
 * Each task shape maps to a preferred model via
 * `REFERENCE_ROUTING_POLICY` (in `@motebit/policy`); consumers
 * (motebit-cloud / BYOK / on-device) override the policy as
 * needed but the shape registry is interop law.
 *
 * Lifted verbatim from `services/proxy/src/validation.ts`'s
 * `TASK_MODEL_MAP` keys (the seven task types the proxy's
 * classifyTask-based router already produces in production).
 *
 * Adding a shape (e.g., `"voice-conversation"`, `"image-generation"`)
 * is intentional protocol-level work: new entry here + new arm in
 * `REFERENCE_ROUTING_POLICY` + drift-gate-induced coverage in
 * every CONSUMER (motebit-cloud proxy + BYOK + on-device). The
 * TaskShape registry is what's role-shaped; the routing-policy
 * itself is a consumer-side function, not a role.
 */
export type TaskShape = "quick" | "chat" | "reasoning" | "code" | "research" | "creative" | "math";

// === Named constants — same value, narrower type ============================
//
// Callers that import these get `TaskShape` typing without the union
// being inferred at every site. Two ergonomic shapes: pass a constant
// (`QUICK_TASK_SHAPE`) for documentation + grep affordance, or inline
// the literal — the union narrowing catches typos in either case.

/** Fast / low-latency tasks (tool-heavy, short responses, sub-second feel). */
export const QUICK_TASK_SHAPE: TaskShape = "quick";

/** Conversational back-and-forth — the default. */
export const CHAT_TASK_SHAPE: TaskShape = "chat";

/** Deep reasoning — chain-of-thought, multi-step inference. */
export const REASONING_TASK_SHAPE: TaskShape = "reasoning";

/** Code-related — completion, review, debugging. */
export const CODE_TASK_SHAPE: TaskShape = "code";

/** Research / long-context — synthesis across many sources. */
export const RESEARCH_TASK_SHAPE: TaskShape = "research";

/** Creative writing — open-ended generation, voice, prose. */
export const CREATIVE_TASK_SHAPE: TaskShape = "creative";

/** Math / scientific — symbolic reasoning, calculation, proofs. */
export const MATH_TASK_SHAPE: TaskShape = "math";

// === Iteration + type guard =================================================

/**
 * Canonical iteration order, frozen. Consumers that need to
 * enumerate (drift gates, REFERENCE_ROUTING_POLICY validation,
 * docs) use this so TypeScript sees the narrow union rather than
 * `string[]`.
 */
export const ALL_TASK_SHAPES: readonly TaskShape[] = Object.freeze([
  "quick",
  "chat",
  "reasoning",
  "code",
  "research",
  "creative",
  "math",
]);

/**
 * Type guard — narrows `unknown` to `TaskShape`. Drift-gate-driven
 * literal scanners use this to validate shapes; consumers that
 * detect task shape from user intent (LLM classification,
 * heuristics) call this before dispatching so an unchecked cast
 * is a fail-open path the type system can't catch.
 */
export function isTaskShape(value: unknown): value is TaskShape {
  return typeof value === "string" && (ALL_TASK_SHAPES as readonly string[]).includes(value);
}

// === Provider capability ====================================================

/**
 * A model's capability profile — what the dispatcher needs to know
 * to pick it. Lifted from `services/proxy/src/validation.ts`'s
 * `ModelEntry` interface; the proxy now declares its
 * `MODEL_CONFIG` entries satisfying `ProviderCapability[]`.
 *
 * Cost units: USD per million tokens. Same precision the proxy's
 * `calculateCostMicro` consumes (input vs output billed
 * separately).
 */
export interface ProviderCapability {
  /** Canonical model identifier — opaque to the dispatcher except as a return value. */
  readonly modelName: string;
  /** Where requests route. */
  readonly host: InferenceHost;
  /** Who trained the weights. */
  readonly lab: ModelLab;
  /** Legal locus of the host. */
  readonly jurisdiction: Jurisdiction;
  /** Input price (USD per million tokens). */
  readonly inputCostPerMillion: number;
  /** Output price (USD per million tokens). */
  readonly outputCostPerMillion: number;
}

// === Routing constraint =====================================================

/**
 * Consumer-neutral constraints the dispatcher honors. **No
 * motebit-cloud-specific fields** — balance-based filtering lives
 * in `@motebit/policy::applyBalanceFilter` (a higher-order wrapper
 * the proxy uses); BYOK and on-device consumers don't have balance
 * and shouldn't see it in the protocol-layer constraint type.
 *
 * All fields optional — an empty constraint means "any
 * jurisdiction, any cost, any capability." The dispatcher returns
 * `{ kind: "deny", reason }` when constraints make every catalog
 * entry ineligible.
 */
export interface RoutingConstraint {
  /**
   * Restrict to this jurisdiction. Useful for compliance-bound
   * tasks ("US-only routing") and the motebit-cloud admission
   * predicate. Omit for "any jurisdiction the catalog offers."
   */
  readonly jurisdiction?: Jurisdiction;
  /**
   * Maximum acceptable input cost in USD per million tokens.
   * Filters the catalog before policy lookup. Useful for
   * cost-aware routing (operator-side budget caps,
   * consumer-side cheap-tier preferences).
   */
  readonly maxInputCostPerMillion?: number;
  /** Maximum acceptable output cost in USD per million tokens. */
  readonly maxOutputCostPerMillion?: number;
  /**
   * Task requires tool-calling capability. When true, providers
   * known not to support tools are excluded. Today the dispatcher
   * treats all entries as tool-capable; this field is shipped for
   * future capability-aware filtering when a provider that lacks
   * tool support lands.
   */
  readonly requiresToolUse?: boolean;
  /**
   * Maximum acceptable sensitivity tier the routing target can
   * handle. Sensitivity-elevated tasks (medical / financial /
   * secret) MUST stay on sovereign or on-device routes — the
   * dispatcher's caller is responsible for pre-filtering the
   * catalog accordingly; this field documents the contract.
   */
  readonly sensitivityCeiling?: SensitivityLevel;
}

// === Routing decision =======================================================

/**
 * The dispatcher's typed output. Discriminated union — consumers
 * pattern-match on `kind`:
 *
 *   - `route`: a single provider was chosen. The caller invokes
 *     it directly.
 *   - `fallback`: a primary was preferred but cost / constraint
 *     forced a backup. The caller invokes `backup`; the `primary`
 *     and `reason` fields are observability surfaces (audit logs,
 *     chrome narration in PR 4+).
 *   - `deny`: no catalog entry satisfies the constraints. The
 *     caller is responsible for surfacing the denial (HTTP 4xx,
 *     UI message, etc.).
 *
 * Every variant carries `reason` for observability — the
 * dispatcher's choice should always be human-legible, even when
 * the choice is "I couldn't pick anything."
 */
export type RoutingDecision =
  | {
      readonly kind: "route";
      readonly model: string;
      readonly reason: string;
    }
  | {
      readonly kind: "fallback";
      readonly primary: string;
      readonly backup: string;
      readonly reason: string;
    }
  | {
      readonly kind: "deny";
      readonly reason: string;
    };
