---
"@motebit/runtime": patch
"motebit": patch
---

Privacy doctrine — sensitivity-aware AI routing v1. Closes the documented-but-not-enforced invariant where CLAUDE.md asserts "Medical/financial/secret never reach external AI" while no code path actually gated provider calls on session sensitivity.

**The audited gap (2026-04-30):**

- `provider-resolver.ts` has zero references to `SensitivityLevel` despite the SDK CLAUDE.md claim that it does "sensitivity-aware routing that keeps medical/financial/secret payloads away from external AI". Provider mode was fixed at config time, regardless of message content.
- `motebit-runtime.ts:1233` hardcodes `session_sensitivity: "none" as const` — no plumbing existed for elevation.
- Delegation paths (`agent-trust.ts`, `interactive-delegation.ts`, `agent-task-handler.ts`) reference `sensitivity` zero times.
- The only enforcement point that actually fired was `CONTEXT_SAFE_SENSITIVITY` in `ai-core/src/loop.ts:346` filtering memory injection — partial enforcement on the memory axis, full silence on the request-side axis.

**What ships:**

`@motebit/runtime` — new API: `setSessionSensitivity(level)` / `getSessionSensitivity()` (defaults to `none`); `setProviderMode(mode | null)` so surfaces declare the provider tier they constructed; `assertSensitivityPermitsAiCall()` private gate called at every AI-call entry. `SovereignTierRequiredError` exported with stable `code: "SOVEREIGN_TIER_REQUIRED"`, `sessionSensitivity`, and `providerMode` fields for surfaces to render structured errors. Gate fires at `sendMessage`, `sendMessageStreaming`, and `generateActivation` BEFORE the loopDeps check — so a surface that elevated sensitivity but forgot to declare provider mode (or declared an external one) fail-closes regardless of init state.

**Mapping:** `on-device` → sovereign (no external network for AI calls); `motebit-cloud` and `byok` → external (vendor sees bytes via direct API or relay forwarding); `null` (unset) → external (fail-closed default — a surface that forgets to declare cannot silently bypass).

`apps/cli` — calls `runtime.setProviderMode(cliConfigToUnified(config).mode)` at boot. The unified config already classifies the user's `--provider` choice; surfacing it on the runtime is just plumbing. Users running `--provider local-server` can now elevate session sensitivity to medical/financial/secret and have the gate pass. Users running `--provider anthropic|openai|google` running at elevated sensitivity get a fail-closed `SovereignTierRequiredError` with a clear "switch to on-device" message before any bytes leave.

`scripts/check-sensitivity-routing.ts` — drift gate (#65) enforcing every method in `motebit-runtime.ts` that calls `runTurn` / `runTurnStreaming` MUST call `this.assertSensitivityPermitsAiCall()` first. Catches the doctrine drift class — adding a new external-AI surface that skips the gate is a CI failure, not a silent privacy leak.

**Auto-classification deliberately deferred.** v1 is explicit-elevation only: surfaces escalate via `setSessionSensitivity` when the user toggles a "medical mode" UI affordance, types `/sensitivity medical`, or otherwise marks the session. LLM-driven detection of medical/financial/secret signals in user text is a UX decision that deserves its own deliberation — explicit elevation is honest about what the runtime knows now.

**Future ships (deliberately out of scope here):**

1. Delegation gate — `agent-task-handler.ts` should also fail-closed when the task carries elevated sensitivity and the peer's HA / trust score is below threshold.
2. Tool-call gate — `web_search`, `read_url`, MCP outbound tools should refuse when elevated sensitivity is set.
3. Surface UI — chat / settings affordance for explicit elevation; "this turn ran sovereign because sensitivity=medical" telemetry.
4. Auto-classification — LLM-driven inference of session_sensitivity from user message + recent context.

Tests: 11 cases covering setter/getter round-trip, fail-closed at each entry point (sendMessage / sendMessageStreaming / generateActivation), every elevated tier × every external provider mode, sovereign-permits-everything, none/personal-don't-trip, and the canonical-error-shape contract. Drift gate `check-sensitivity-routing` (#65) green, probe in `check-gates-effective` proves the gate fires on disabled assertions.
