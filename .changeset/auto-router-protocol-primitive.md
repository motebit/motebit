---
"@motebit/protocol": minor
---

Auto-router as protocol primitive — `f(TaskShape × ProviderCapability × Constraints) → RoutingDecision`. Additive types for the model-selection primitive (drift gate #95, doctrine memo `auto-routing-as-protocol-primitive.md`).

New exports:

```ts
type TaskShape = "quick" | "chat" | "reasoning" | "code" | "research" | "creative" | "math";
type InferenceHost = "anthropic" | "openai" | "google" | "groq"; // lifted from services/proxy
type ModelLab = "anthropic" | "openai" | "google" | "meta"; // lifted from services/proxy
type Jurisdiction = "US" | "CN" | "EU"; // lifted from services/proxy
interface ProviderCapability {
  modelName;
  host;
  lab;
  jurisdiction;
  inputCostPerMillion;
  outputCostPerMillion;
}
interface RoutingConstraint {
  jurisdiction?;
  maxInputCostPerMillion?;
  maxOutputCostPerMillion?;
  requiresToolUse?;
  sensitivityCeiling?;
}
type RoutingDecision =
  | { kind: "route"; model; reason }
  | { kind: "fallback"; primary; backup; reason }
  | { kind: "deny"; reason };
```

Plus `ALL_TASK_SHAPES` frozen iteration, `isTaskShape` type guard, named constants per shape (`QUICK_TASK_SHAPE`, etc.). Additive — no existing exports renamed or removed.

The `InferenceHost` / `ModelLab` / `Jurisdiction` unions were previously declared in `services/proxy/src/validation.ts`; lifting them here makes the auto-router primitive in `@motebit/policy` consumable across motebit-cloud (proxy, PR 1), BYOK (PR 2), and on-device (PR 3) consumers. The proxy re-exports the unions for back-compat with proxy-internal callers; new code imports from `@motebit/protocol` directly.

The dispatcher itself (`dispatchRouting`, `applyBalanceFilter`, `REFERENCE_ROUTING_POLICY`) lives in `@motebit/policy` (private/BSL — separate ignored changeset). Three-instance-deep endgame validation (motebit-cloud / BYOK / on-device) mirrors chrome-as-state-render's web/mobile/spatial rollout.

Drift gate `check-routing-decision-coverage` (#95) enforces consumer registry. `TaskShape` literal coverage is TypeScript-enforced via the dispatcher's exhaustive switch with `never` fallthrough — gate doesn't scan it (redundant ceremony). Inventory: 96 → 97 invariants, 86 → 87 hard CI gates.

Doctrine: `docs/doctrine/auto-routing-as-protocol-primitive.md` (PR 1 scope, three-instance endgame validation, role-vs-policy distinction). `agility-as-role.md` extends from 6 → 7 instances: `TaskShape` is the role (closed registry); routing-policy is a consumer-side function — NOT a role. The plan-review session that produced this PR caught the role/policy conflation in an earlier draft; the correction is preserved in the doctrine.
