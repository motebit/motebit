---
"@motebit/protocol": minor
---

Add `SensitivityCleared<T>` phantom-type brand to `packages/protocol/src/sensitivity.ts`. Pure type-level precondition: `T` carrying an opaque type-level proof that `assertSensitivityPermitsAiCall()` fired before the value was produced. Symbol is `declare const`-only (no runtime), so the brand can be produced only via an explicit `as SensitivityCleared<T>` cast — and that cast lives inside the runtime's gate implementation as the single authorized production site.

**Layer 1 promotion of the privacy doctrine** ("Medical/financial/secret never reach external AI"). The brand sits on the `MotebitLoopDependencies` parameter of `runTurn` / `runTurnStreaming` in `@motebit/ai-core`, propagating through every indirect AI-egress path (`StreamingManager` resume-after-tool-approval in `@motebit/runtime`, `PlanEngine` per-step execution in `@motebit/planner`). Any code that reaches `runTurn` without threading the brand from a gate-firing producer is now a compile error — closes the off-gate cross-file and cross-package paths that the static `check-sensitivity-routing` drift gate cannot scan.

**Third Layer 1 promotion mechanism** in motebit's idiom — distinct from the view-type pattern (`BootedApp = Omit<WebApp, ...>` for callsite enforcement) and the phase-typing pattern (`UnbootedWebApp.bootstrap() → WebApp` for state-machine enforcement). Branded preconditions encode "you did X before consuming Y" at the type system; the production site is the only privileged cast, consumers are structurally locked to typed proof.

The static `check-sensitivity-routing` gate stays for `provider.generate(...)` direct calls (housekeeping completions: title generation, summarization, classification). Brand-typing for that family is a future arc — separate signature change with its own propagation surface.

Additive change. No existing consumer breaks; the brand is opt-in for callers that want to require it on their parameters.
