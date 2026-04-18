---
"@motebit/ai-core": patch
"@motebit/runtime": patch
---

Fix HTTP 400 "temperature is deprecated for this model" on motebit.com
after the first reflection/planning task runs.

The 2026-04-17 fix (ai-core 89f3b978) omitted `temperature` from the
Anthropic request body when `config.temperature` was undefined — the
correct handling for Claude Opus 4.7+, which rejects the parameter.
That fix is still right. This PR closes **three compounding defects in
the task-router path that 89f3b978 did not touch**:

1. `TaskRouter.resolve()` hardcoded `?? 0.7` as the final fallback,
   so the resolved config _always_ carried a number.
2. `withTaskConfig` apply path unconditionally called
   `provider.setTemperature(taskConfig.temperature)` — so any task
   borrowed a temperature even when none was configured upstream.
3. `withTaskConfig` restore path (the worst): if `savedTemperature`
   was undefined, the `finally` block set it back to `0.7`,
   **permanently poisoning the provider for every subsequent call.**
   One reflection task per session was enough to break the next
   normal chat turn with HTTP 400.

That last one explains the "worked, worked, broke" pattern users saw
on motebit.com: the reflection task that runs every couple of turns
ran fine, then silently restored 0.7 as the provider's default, and
the next chat turn was rejected.

Fixes:

- `ResolvedTaskConfig.temperature` is now optional. Undefined means
  "let the model use its own default" and propagates through the
  whole chain without reintroducing a number.
- `TaskRouter.resolve()` preserves undefined instead of falling back
  to 0.7.
- `withTaskConfig` only touches `setTemperature` when the task config
  explicitly set one; the restore path passes undefined verbatim.
- `StreamingProvider.setTemperature` signature widened to
  `number | undefined` so it can clear the field. Concrete setters
  on `AnthropicProvider` and `OpenAIProvider` updated symmetrically.
- `PLANNING_TASK_ROUTER` (runtime) drops the hardcoded 0.3/0.5 for
  `planning` and `plan_reflection`. Those predated the Opus 4.7
  deprecation and were arbitrary tuning values; leaving them in
  would have tripped the same 400 even after the task-router fix.

Two regression tests pin the behavior (task-router unit test for the
resolve contract + coverage-uplift for the withTaskConfig restore
contract). Both were inverted from tests that actively codified the
buggy `?? 0.7` fallback.

**Deploy impact:** motebit.com web chat was rejecting Anthropic
requests after the first reflection task per session. A redeploy
from this commit restores it.
