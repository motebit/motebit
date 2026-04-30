---
"motebit": patch
---

Privacy doctrine — sensitivity-aware AI routing v1, published-runtime consumer half. Closes the documented-but-not-enforced invariant where CLAUDE.md asserts "Medical/financial/secret never reach external AI" while no code path actually gated provider calls on session sensitivity.

`apps/cli` (the published `motebit` runtime's CLI surface) calls `runtime.setProviderMode(cliConfigToUnified(config).mode)` at boot. The unified config already classifies the user's `--provider` choice; surfacing it on the runtime engine is just plumbing. Users running `--provider local-server` can now elevate session sensitivity to medical/financial/secret and have the gate pass. Users running `--provider anthropic|openai|google` at elevated sensitivity get a fail-closed `SovereignTierRequiredError` with a clear "switch to on-device" message before any bytes leave.

`scripts/check-sensitivity-routing.ts` — drift gate (#65) enforcing every method in `motebit-runtime.ts` that calls `runTurn` / `runTurnStreaming` MUST call `this.assertSensitivityPermitsAiCall()` first. Catches the doctrine drift class — adding a new external-AI entry point that skips the gate is a CI failure, not a silent privacy leak.

**Auto-classification deliberately deferred.** v1 is explicit-elevation only: surfaces escalate via `setSessionSensitivity` when the user toggles a "medical mode" UI affordance, types `/sensitivity medical`, or otherwise marks the session. LLM-driven detection of medical/financial/secret signals in user text is a UX decision that deserves its own deliberation — explicit elevation is honest about what the runtime knows now.

Runtime engine API ships in the sibling `sensitivity-routing-v1-ignored.md` changeset.
