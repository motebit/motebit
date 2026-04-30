---
"@motebit/runtime": patch
---

Privacy doctrine — sensitivity-aware AI routing v1, runtime engine half.

**The audited gap (2026-04-30):**

- `provider-resolver.ts` had zero references to `SensitivityLevel` despite the SDK CLAUDE.md claim that it does "sensitivity-aware routing that keeps medical/financial/secret payloads away from external AI". Provider mode was fixed at config time, regardless of message content.
- `motebit-runtime.ts:1233` hardcoded `session_sensitivity: "none" as const` — no plumbing existed for elevation.
- Delegation paths (`agent-trust.ts`, `interactive-delegation.ts`, `agent-task-handler.ts`) referenced `sensitivity` zero times.
- The only enforcement point that actually fired was `CONTEXT_SAFE_SENSITIVITY` in `ai-core/src/loop.ts:346` filtering memory injection — partial enforcement on the memory axis, full silence on the request-side axis.

**What ships.** `MotebitRuntime` gains `setSessionSensitivity(level)` / `getSessionSensitivity()` (defaults to `none`); `setProviderMode(mode | null)` so surfaces declare the provider tier they constructed; `assertSensitivityPermitsAiCall()` private gate called at every AI-call entry. `SovereignTierRequiredError` exported with stable `code: "SOVEREIGN_TIER_REQUIRED"`, `sessionSensitivity`, and `providerMode` fields for surfaces to render structured errors. Gate fires at `sendMessage`, `sendMessageStreaming`, and `generateActivation` BEFORE the loopDeps check — so a surface that elevated sensitivity but forgot to declare provider mode (or declared an external one) fail-closes regardless of init state.

**Mapping:** `on-device` → sovereign (no external network for AI calls); `motebit-cloud` and `byok` → external (vendor sees bytes via direct API or relay forwarding); `null` (unset) → external (fail-closed default — a surface that forgets to declare cannot silently bypass).

Consumer wiring (`runtime.setProviderMode(...)` at boot in `apps/cli`, the published `motebit` runtime's CLI surface) ships in the sibling `sensitivity-routing-v1.md` changeset.

Tests: 11 cases covering setter/getter round-trip, fail-closed at each entry point (sendMessage / sendMessageStreaming / generateActivation), every elevated tier × every external provider mode, sovereign-permits-everything, none/personal-don't-trip, and the canonical-error-shape contract.
