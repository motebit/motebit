/**
 * Auto-router — pure dispatcher for model selection.
 *
 * Doctrine: routing is `f(TaskShape × ProviderCapability ×
 * Constraints) → RoutingDecision`. Same matrix-as-primitive shape
 * as `chrome-as-state-render.md` applied to model selection.
 * Types live in `@motebit/protocol/src/routing.ts` (permissive
 * floor); judgment lives here alongside `policy-gate.ts`,
 * `reputation.ts`, `risk-model.ts`.
 *
 * Pure, deterministic, no I/O. The dispatcher consumes a provider
 * catalog + constraints + a routing policy (`Record<TaskShape,
 * string>` today; potentially a learned function of the same
 * signature in the future as `ModelLab` becomes the eventual host)
 * and returns a typed `RoutingDecision`.
 *
 * **TaskShape agility (7th instance of agility-as-role):** the
 * `TaskShape` registry is the role (closed inventory of task
 * categories the dispatcher branches on). The routing-policy
 * itself is a consumer-side function, not a role. Adding a new
 * shape (`"voice-conversation"`, `"image-generation"`) is a
 * registry append in `@motebit/protocol` + a new arm in
 * `REFERENCE_ROUTING_POLICY` here + drift-gate-induced coverage
 * in every CONSUMER (motebit-cloud / BYOK / on-device).
 *
 * **Why balance-aware filtering is a SEPARATE wrapper:** balance
 * is motebit-cloud-specific (BYOK + on-device don't have it).
 * `applyBalanceFilter` is the higher-order helper consumers
 * compose BEFORE `dispatchRouting` when they have balance-bound
 * routing. The dispatcher itself stays consumer-neutral.
 *
 * Three-instance-deep at endgame (motebit-cloud / BYOK / on-device)
 * — PR 1 ships motebit-cloud as the first consumer; PR 2/3 add the
 * remaining two. Drift gate `check-routing-decision-coverage`
 * enforces the CONSUMERS registry structurally.
 */

import type {
  TaskShape,
  ProviderCapability,
  RoutingConstraint,
  RoutingDecision,
} from "@motebit/protocol";

/**
 * The motebit-canonical default routing policy. Maps each
 * `TaskShape` to the model that the policy considers best for it.
 *
 * Per `protocol-model.md` § "Naming: interop law vs reference
 * default" — the `REFERENCE_` prefix marks this as a default that
 * implementers MAY override. Consumers (motebit-cloud, BYOK, on-
 * device) ship their own `Record<TaskShape, string>` and pass to
 * `dispatchRouting`; this map is the recommended starting point.
 *
 * Lifted verbatim from `services/proxy/src/validation.ts`'s
 * `TASK_MODEL_MAP` (the same arms the proxy's auto-routing has
 * been running in production since the intelligence-source
 * agility refactor).
 *
 * Future: a learned routing function of the same `(TaskShape,
 * ProviderCapability[], RoutingConstraint) → RoutingDecision`
 * signature will eventually replace this static map at motebit-
 * cloud's relay (per `agility-as-role.md` future-work — ModelLab
 * as the host). Static map ships today; replacement is a function
 * substitution, not a wire-format break.
 */
export const REFERENCE_ROUTING_POLICY: Readonly<Record<TaskShape, string>> = Object.freeze({
  quick: "claude-haiku-4-5-20251001",
  chat: "claude-sonnet-4-6",
  reasoning: "claude-opus-4-6",
  code: "gpt-5.4",
  research: "gemini-2.5-pro",
  creative: "claude-sonnet-4-6",
  math: "claude-opus-4-6",
});

/**
 * Pre-filter a catalog by balance-affordable models. Pure helper;
 * caller composes this BEFORE `dispatchRouting` when the consumer
 * has a balance (motebit-cloud's proxy is the only consumer with
 * one today).
 *
 * BYOK consumers (PR 2) skip this — they don't have a balance;
 * the user pays providers directly. On-device consumers (PR 3)
 * also skip it — no money flow at all.
 *
 * Estimation: assumes a typical exchange of ~500 input tokens +
 * ~1000 output tokens (the same estimates `services/proxy/src/
 * validation.ts::getAffordableModelForTask` uses). Real consumers
 * with better estimates pass their own filter; this is the
 * sensible default for the proxy's pre-flight cost check.
 *
 * `balanceMicroUsd` is in MICRO-USD per `@motebit/sdk` money
 * convention (1 USD = 1,000,000 micro-units; zero floating-point
 * in the money path).
 */
export function applyBalanceFilter(
  catalog: readonly ProviderCapability[],
  balanceMicroUsd: number,
): readonly ProviderCapability[] {
  if (balanceMicroUsd <= 0) return catalog.slice(0, 0);
  // Estimate the cost of a typical call at this model: ~500 input
  // + ~1000 output tokens. Cost-per-million in protocol; convert
  // to micro-USD per call. 500 / 1_000_000 * inputCostUsdPerMillion
  // * 1_000_000 micro-units-per-USD = 500 * input. Same for output.
  const ESTIMATED_INPUT_TOKENS = 500;
  const ESTIMATED_OUTPUT_TOKENS = 1000;
  return catalog.filter((cap) => {
    const estCostMicroUsd =
      ESTIMATED_INPUT_TOKENS * cap.inputCostPerMillion +
      ESTIMATED_OUTPUT_TOKENS * cap.outputCostPerMillion;
    return estCostMicroUsd <= balanceMicroUsd;
  });
}

/**
 * Dispatch routing — pure function. Given the task shape, the
 * available catalog, the constraints, and the policy, return a
 * typed `RoutingDecision`.
 *
 * Algorithm:
 *
 *   1. Filter `catalog` by `constraints` (jurisdiction, max input
 *      / output cost). Empty → `deny`.
 *   2. Look up the policy's preferred model for `taskShape`.
 *   3. If the preferred model is in the filtered catalog →
 *      `{ kind: "route", model, reason }`.
 *   4. Otherwise walk the catalog in order (catalog ordering is
 *      the consumer's preference signal — earlier entries
 *      preferred) and pick the first member as the fallback.
 *      Return `{ kind: "fallback", primary, backup, reason }`.
 *   5. If no catalog member survives filtering at all → `deny`.
 *
 * The dispatcher does not know about balance — `applyBalanceFilter`
 * is the consumer-side wrapper that prunes the catalog first.
 *
 * The dispatcher does not know about detection — task shape is an
 * input. Consumers detect shape via LLM classification (proxy's
 * `classifyTask`), heuristics, or explicit user choice.
 */
export function dispatchRouting(
  taskShape: TaskShape,
  catalog: readonly ProviderCapability[],
  constraints: RoutingConstraint,
  policy: Readonly<Record<TaskShape, string>>,
): RoutingDecision {
  // Filter catalog by constraints
  const filtered = catalog.filter((cap) => {
    if (constraints.jurisdiction !== undefined && cap.jurisdiction !== constraints.jurisdiction) {
      return false;
    }
    if (
      constraints.maxInputCostPerMillion !== undefined &&
      cap.inputCostPerMillion > constraints.maxInputCostPerMillion
    ) {
      return false;
    }
    if (
      constraints.maxOutputCostPerMillion !== undefined &&
      cap.outputCostPerMillion > constraints.maxOutputCostPerMillion
    ) {
      return false;
    }
    return true;
  });

  if (filtered.length === 0) {
    return {
      kind: "deny",
      reason: `No catalog entries satisfy constraints (jurisdiction=${constraints.jurisdiction ?? "any"}, maxInputCostPerMillion=${constraints.maxInputCostPerMillion ?? "any"}, maxOutputCostPerMillion=${constraints.maxOutputCostPerMillion ?? "any"})`,
    };
  }

  // Look up the policy's preferred model for this shape (exhaustive
  // switch over TaskShape so a new shape addition is a compile error
  // until policy gains an arm — TypeScript handles per-shape coverage
  // structurally; the drift gate handles per-consumer registration).
  const preferred = pickPreferredModel(taskShape, policy);
  const preferredAvailable = filtered.find((cap) => cap.modelName === preferred);
  if (preferredAvailable !== undefined) {
    return {
      kind: "route",
      model: preferred,
      reason: `Policy says ${taskShape} → ${preferred}; available in catalog`,
    };
  }

  // Preferred not in the filtered catalog — pick the first surviving
  // entry as the fallback. Catalog ordering is the consumer's
  // preference signal (motebit-cloud's proxy orders by tier; BYOK
  // surfaces order by user preference; on-device by capability).
  const backup = filtered[0]!;
  return {
    kind: "fallback",
    primary: preferred,
    backup: backup.modelName,
    reason: `Policy preferred ${preferred} for ${taskShape}, but it's not in the filtered catalog; falling back to ${backup.modelName}`,
  };
}

/**
 * Exhaustive lookup helper. Pulls policy[taskShape] with a
 * `never`-fallthrough switch so a new `TaskShape` addition to the
 * protocol registry is a TypeScript error here until the policy
 * grows an arm — compile-time enforcement of per-shape coverage
 * (which is why the drift gate doesn't need to scan TaskShape
 * literals; TypeScript already enforces).
 */
function pickPreferredModel(
  taskShape: TaskShape,
  policy: Readonly<Record<TaskShape, string>>,
): string {
  switch (taskShape) {
    case "quick":
      return policy.quick;
    case "chat":
      return policy.chat;
    case "reasoning":
      return policy.reasoning;
    case "code":
      return policy.code;
    case "research":
      return policy.research;
    case "creative":
      return policy.creative;
    case "math":
      return policy.math;
    default: {
      // Exhaustive: if a new TaskShape is added to the protocol
      // registry, this assignment fails to compile until the
      // switch grows a new arm. Drift-gate-equivalent enforcement
      // for the per-shape axis (zero textual scanning needed).
      const _exhaustive: never = taskShape;
      throw new Error(`Unhandled task shape: ${String(_exhaustive)}`);
    }
  }
}
