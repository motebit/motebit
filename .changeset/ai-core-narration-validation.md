---
"@motebit/ai-core": patch
---

Add `validateTaskStepNarration` runtime validator in `packages/ai-core/src/narration-validation.ts` — sibling of `dishonest-closing.ts`, third graduation of [`runtime-invariants-over-prompt-rules.md`](../docs/doctrine/runtime-invariants-over-prompt-rules.md). Pairs with the `task_step_narration` wire field added to `AIResponse` in `@motebit/sdk` and the PERCEPTION_DOCTRINE clause teaching the model to emit the field.

**The third typed-truth-perception triple.** Sibling pattern to:

1. `synthesizeClosingFallback` (exemplar 1) — runtime synthesizes closing text when finalText is empty
2. `detectDishonestClosing` + `DISHONESTY_RULES` (exemplar 2) — runtime appends correction to closing text contradicted by typed truth
3. **`validateTaskStepNarration` (this commit)** — runtime falsifies in-flight narration contradicted by typed truth before the chrome reads it

Different shape, same doctrinal pattern: the narration is the model's IN-FLIGHT claim about what it's currently doing; the validator inspects the proposed narration string for wire-level contradictions; falsified narrations get replaced with runtime-templated fallbacks. The chrome consumes the validator's output, never the model's raw narration.

**The single first rule we ship: URL-mention contradiction.** If the narration mentions a URL or hostname AND that hostname doesn't match the last-navigate result's URL, falsify. Catches the load-bearing case from the doctrine memo: model says "Reading apple.com" while the page is on google.com. Hostname canonicalization handles `www.` prefix and case-insensitivity; subdomains stay distinct (`mail.google.com` ≠ `google.com`). Conservative regex on hostname extraction prefers no-match over false-match — version numbers like `1.2.3`, IP addresses, and other token-shaped non-hostnames don't trigger spurious falsification. The validator's bias is to MISS contradictions rather than to OVER-FIRE — false-falsify is the worse failure mode (trains users to distrust narration that was actually honest).

Other rules (action-vs-tool-mismatch, register-vs-claim-mismatch) emerge as the chrome ships and dogfooding surfaces real contradictions. Single-rule shape today; when a second narration field ships, a `NARRATION_RULES` table emerges to parallel `DISHONESTY_RULES`.

**New typed-truth class: `dishonesty-narration`.** Added to the `TypedTruthClass` const-string-union in `scripts/check-typed-truth-perception.ts`. Sibling of `dishonesty-persistent` and `dishonesty-transient`; classifies fields whose contradiction-check runs against wire-level typed truth BEFORE chrome consumption rather than after closing-text emission. The Half-3 sync invariant (every dishonesty-persistent field appears in DISHONESTY_RULES) does NOT extend to narration-class — different validation mechanism, different table-or-function shape — but a parallel sync invariant becomes possible if/when a NARRATION_RULES table emerges.

Drift gate (`check-typed-truth-perception`) registers `task_step_narration` as the 13th typed-truth field with `class: "dishonesty-narration"` and dispatchSource pointing at narration-validation.ts. Prompt-density baseline bumped 63 → 64 with A-grade justification (wire field + runtime validation = full triple, exactly the architectural shape the doctrine prescribes).

16 new tests covering pass-through cases (empty narration, no hostname mention, no navigate result, malformed wire URL), falsify cases (URL contradiction with full-URL or bare-hostname narration shapes, walk-back to most recent navigate), truthful narration (matching hostname, www-prefix variant, case-insensitivity), and defensive cases (failed-call walk-past, version-number false-positive guard, subdomain distinction). All 470 ai-core tests green; 83/83 drift gates green; 87/87 effectiveness probes green; graph-wide typecheck clean. No API breaks.

PR 1 first slice — the runtime foundation. Subsequent slices add the chrome's state-driven render that consumes the validated narration. Doctrine: [`docs/doctrine/chrome-as-state-render.md`](../docs/doctrine/chrome-as-state-render.md) §"Hybrid narration source as the third typed-truth-perception triple."
