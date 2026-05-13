---
"@motebit/sdk": minor
---

Add optional `task_step_narration?: string` field to `AIResponse` — the wire foundation for the slab chrome's `motebit × virtual_browser` register per [`docs/doctrine/chrome-as-state-render.md`](../docs/doctrine/chrome-as-state-render.md). The field carries a single first-person present-tense sentence ("Reading the page" / "Filling in the form" / "Hit a paywall — need your input") at the supervisor-cares-about granularity. Optional and additive: existing consumers ignore it; absence means the chrome recedes to the empty register.

The field is typed-truth-validated at runtime (`validateTaskStepNarration` in `@motebit/ai-core`'s `narration-validation.ts`) before the chrome reads it — the third graduation of [`runtime-invariants-over-prompt-rules.md`](../docs/doctrine/runtime-invariants-over-prompt-rules.md), the typed-truth-perception triple applied to in-flight motebit-voiced text. A narration that contradicts wire-level typed truth (claims "Reading apple.com" while the page is on google.com) gets falsified and replaced with a runtime-templated fallback before the chrome renders it. The chrome's narration register's trust contract is: every line shown is wire-true regardless of what the model proposed.

PR 1 first slice — the wire foundation. Subsequent slices add the chrome's state-driven render against `controlState × embodimentMode`, the `motebit × virtual_browser` register that consumes this field, the `user × virtual_browser` register (cobrowse-as-mode), and the `/wheel` + chip-tap handoff affordance per the doctrine memo's PR 1 scope.

Backward-compatible (additive optional field). No consumer code changes required to keep working; consumers wanting the new register read the field when present and skip when absent.
