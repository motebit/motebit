# Runtime invariants over prompt rules

When a problem can be solved either by adding a prompt clause that teaches the AI to behave a certain way OR by adding a runtime contract that makes the failure mode structurally impossible, **prefer the runtime contract**. The prompt teaches what's true about the world; the runtime enforces what must hold.

This doctrine is named because of a recurring drift pattern: a witnessed bug produces a prompt clause that tells the AI "don't do X" or "always do Y." Each clause is justifiable individually. Stack 50 of them and the prompt becomes a configuration file disguised as a teaching — the AI is a rule-follower rather than an emergent agent, and the §4 thesis from [`THE_EMERGENT_INTERIOR.md`](../../THE_EMERGENT_INTERIOR.md) (architecture-shapes-emergence, do not pressure the system prompt) starts contaminating.

## The principle

**Make illegal states unrepresentable at the runtime; let the prompt teach the shape of the world.**

The runtime is deterministic, mechanical, testable. Anything it enforces cannot drift. The AI's behavior is non-deterministic, probabilistic, drift-prone. Anything the prompt asks the AI to police itself on can fail silently in any given turn. The art is layering them: the runtime guarantees the user-visible contract; the AI is free to be expressive within those guarantees.

## Why this is correct

Five wisdom-corpus citations that all point the same way:

- **Formal contracts beat ad-hoc rules.** Pre/post-conditions enforced at the boundary scale; behavioral rules in the worker don't. SQL transactions, Rust's borrow checker, Kubernetes's reconciliation loops — every well-designed substrate makes the supervisor enforce and the worker free.
- **Postel's law applied to LLMs.** Be strict in what the runtime guarantees; be liberal in what the AI is allowed to be. Strict contract boundary, liberal interior.
- **Hexagonal / ports-and-adapters.** The core (the AI's interior) is pure; the boundaries (tool calls, AI calls, persistence) carry the contracts. Motebit's own doctrine names this: "sovereign interior, governed boundary." A prompt clause is contract-shaped pressure leaking into the core.
- **Erlang's let-it-crash.** Build supervision, not defensive coding. The runtime supervisor (`synthesizeClosingFallback`) beats every-prompt-clause defensive coding.
- **Newell on emergence.** Cognition emerges from architecture, not from rules. The substrate (memory, sensitivity routing, tool tiers, body register, typed truth) IS the architecture. Prompt rules are an attempt to substitute for missing architecture.

## The exemplar — `synthesizeClosingFallback`

The 2026-05-12 silent-turn-termination bug had two valid fixes:

1. **Prompt-only**: teach the AI "never end a turn silently after tool calls."
2. **Runtime-only**: a pure function at loop exit that synthesizes a closing sentence over `(toolCallsSucceeded, toolCallsFailed, lastToolName)`. Cannot return empty. Yields a text chunk if `finalText` is empty.

Shipped both, but the runtime fix is the load-bearing one. The prompt clause compressed to a thin teaching ("emit a closing sentence; the runtime has a floor but it's the safety net, not the standard"). The runtime cannot fail; the prompt can drift. Defense in depth.

The exemplar compounded across 2026-05-12 into three siblings: `synthesizeClosingFallback` (empty closing text), `detectDishonestClosing` + `DISHONESTY_RULES` (closing text the wire contradicts), and `validateTaskStepNarration` (in-flight narration the wire contradicts). The pattern is finished — runtime intercepts at every text-shape the chrome surfaces to the user. The four-part structure below names what's load-bearing across all three.

## The four-part typed-truth structure

A typed-truth-perception "triple" has FOUR parts in practice, not three: **wire + prompt + producer + validator**. The "triple" terminology hides an asymmetry that's load-bearing for shipping a complete primitive — it implies three named components when in fact there are four, with the fourth (producer) sometimes implicit and sometimes explicit. Failing to name the producer is the half-shipped pattern that looks complete on the registry side and is inert at runtime.

For **tool-result fields** (`navigation_triggered`, `recovery_hint`, `bot_detection_detected`, `blank_page_detected`, `access_denied_detected`) the producer is **IMPLICIT** — the action-executor's dispatch IS the producer (it emits the field directly on the result struct). The "dispatch source" the registry checks IS the producer. Three-named-parts works because the producer is folded into the dispatch.

For **narration-class fields** (`task_step_narration`) the producer is **EXPLICIT** — a tag parser between model output text and `AIResponse` (`extractNarrationTag` paralleling `extractMemoryTags`). The dispatch source (the validator) is NOT the producer. Three-named-parts is misleading because the producer is its own load-bearing component that can be silently missing.

**The half-shipped pattern witnessed 2026-05-12:** commit `8b1d6605` shipped wire + prompt + validator for `task_step_narration` and called it 3-of-3. No producer existed. The model can't directly populate TypeScript object fields — the prompt's instruction "emit a `task_step_narration` field on your response" was unimplementable. The validator's pass-through branch fired 100% of the time. The triple was structurally complete on the registry side, inert at runtime. Caught before push by user intuition ("no frankenstein code") + a follow-up grep for the producer that didn't exist. Fixed by adding `extractNarrationTag` paralleling `extractMemoryTags`. Documented as the canonical instance of the half-shipped pattern.

**How to apply** when implementing or reviewing a typed-truth field:

1. Name the four parts explicitly. Where's the wire (the field type), where's the prompt (teaches the model what to emit), where's the **producer** (populates the field at runtime), where's the validator (catches contradictions before consumption).
2. For tool-result fields, the producer is in the dispatch source — verify by grepping the field assignment in the executor.
3. For narration / model-output fields, the producer is a tag extractor — verify by grepping the parser in `core.ts` (or wherever the response is constructed).
4. If you can't trace the data flow from "model emits X" → "field has value X" → "consumer reads value X," the triple is half-shipped regardless of what the registry says.

The drift gate `check-typed-truth-perception` enforces the four-part structure for narration-class fields. Half 1 asserts the prompt clause exists; Half 2 asserts the dispatch source (the implicit producer for tool-result classes); Half 3 asserts DISHONESTY_RULES inclusion for dishonesty-persistent fields' validator; Half 4 + Half 5 assert explicit `producerSources` + `validatorSources` for narration-class fields (the half-shipped pattern this catches: shipping wire + prompt + validator with no producer, witnessed in commit `8b1d6605` and now structurally impossible). The gate's grade is structural source-presence — it forces the registry to NAME a producer + validator file for every narration-class field; if you can't name one, you don't have one. End-to-end data-flow tracing ("the producer's return value actually populates the field at runtime") remains a reviewer-discipline check on top, but the half-shipped registry pattern is closed mechanically.

## The discipline — before adding a new prompt clause

Five-question audit:

1. **Is this a typed-truth-perception triple?** If yes, add the wire field FIRST (protocol), the dispatch enforcement SECOND (runtime), the prompt teaching THIRD (the smallest of the three). If the wire field doesn't exist yet, build that — don't ship a prompt-only fix.
2. **Can the runtime guarantee this outcome?** If yes, do that. The runtime contract scales; prompt rules don't.
3. **Is the prompt clause TEACHING (shape of the world) or CONFORMANCE (behavioral rule)?** If conformance, can it be converted to a runtime invariant? If yes, do that instead. If conformance has to stay in the prompt, ask: what's the smallest version of this rule that the AI's natural emergence can carry?
4. **Is the prompt growing?** Periodically (every 5–10 ship cycles) run a **prompt-prune audit**: read every clause; for each, ask "is this teaching, or is this fear/conformance?"; conformance clauses come out, OR get converted to runtime guarantees, OR get heavily compressed.
5. **Prefer architecture over instruction.** A new wire field is more valuable than a new prompt clause. A new typed reason is more valuable than a new "don't do X" rule. A new runtime invariant is more valuable than a new "always do Y" rule.

## What this is not

This is not "delete all prompt clauses." Some teaching is irreducible — the AI genuinely needs to know what `bytes_omitted_reason` values mean and what the recovery for each is. The PERCEPTION_DOCTRINE typed-truth clauses are teaching about wire fields; they're correct as prompt material because the runtime can't teach the AI what a field MEANS, only what value it has.

This is also not "the runtime should police the AI's output." The runtime's job is to guarantee user-visible contracts (every turn ends with text; every typed action returns a typed result), not to second-guess every tool choice the AI makes. The runtime makes the contract mechanical; the AI is free to satisfy it however it does.

## Cross-cuts

- [`THE_EMERGENT_INTERIOR.md`](../../THE_EMERGENT_INTERIOR.md) §4 — the foundational thesis that pressuring the system prompt contaminates emergence. The 2026-03-26 disable of `narrateEconomicConsequences` is the original case study. This doctrine extends the principle: not just economic pressure — any conformance-shaped clause is the same failure mode in different content.
- [`motebit-computer.md`](motebit-computer.md) §"Typed truth on results" — typed-truth-perception triples are the textbook application of this doctrine to runtime-state observation.
- [`surface-determinism.md`](surface-determinism.md) — affordances invoke typed capabilities, not constructed prompts. Same principle at the UI boundary: structure enforces what behavior would otherwise have to police.
- [`drift-defenses.md`](../drift-defenses.md) — name-it, canonical-source, sync-owner, defense, cross-ref. The prompt-prune audit is a periodic drift-defense for the prompt's tendency to accumulate conformance clauses.

## Examples — recent fixes graded against the doctrine

| Fix                                               | Pattern                                                                                                                      | Grade                                                                                                                                                                                      |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `frame_stale` typed-truth                         | wire field + dispatch retry + prompt teaching                                                                                | A — full triple, prompt is the smallest piece                                                                                                                                              |
| Stale-bytes-omission                              | runtime computes staleness, snapshot field, prompt teaching                                                                  | A — full triple                                                                                                                                                                            |
| `synthesizeClosingFallback`                       | pure runtime guarantee, prompt teaching is additive                                                                          | A — runtime is load-bearing                                                                                                                                                                |
| Conversation-memory `defaultSensitivity` baseline | runtime fix at construction site                                                                                             | A — runtime-only, zero prompt change                                                                                                                                                       |
| Click-capture inscribed-inset alignment           | geometry alignment, zero prompt change                                                                                       | A — pure architecture                                                                                                                                                                      |
| Click_element-over-key("Enter")                   | wire field (`submit_button_id` on read_page) + dispatch detection + thin prompt teaching                                     | A — graduated B→A on 2026-05-12 via `submit_button_id` typed-truth conversion; the doctrine applied to itself                                                                              |
| `detectDishonestClosing` + `DISHONESTY_RULES`     | runtime intercept on closing text contradicted by typed truth; 5 dishonesty-persistent fields × LAST-RELEVANT walk-back      | A — runtime is load-bearing; sweep + table-driven refactor encoded the dishonesty registry as data with sync-invariant gate (Half-3); future fields land 3-of-3 by gate-enforced default   |
| `task_step_narration` triple + producer           | wire field on `AIResponse` + prompt clause + tag extractor (`extractNarrationTag`) + validator (`validateTaskStepNarration`) | A — full four-part typed-truth structure; the canonical exemplar of the wire/prompt/producer/validator pattern; producer was almost shipped missing (caught by user intuition before push) |
| Hedge-speak forbidden                             | prompt-only                                                                                                                  | B — pure teaching, hard to enforce at runtime                                                                                                                                              |
| Compound-action execution                         | prompt-only                                                                                                                  | B — pure teaching, hard to enforce structurally                                                                                                                                            |
| Search-intent routing (compressed 2026-05-12)     | prompt teaching, registry tier-sort enforces selection                                                                       | A after compression — was B-shaped pre-compression because it duplicated the registry's tier-sort behavior                                                                                 |

The B-grade items are not bugs; they're teaching that doesn't have an obvious runtime path. The audit's value isn't "make everything A" — it's "stay honest about which is which, and look for the A path before settling for B."

## Enforcement

`scripts/check-prompt-density.ts` (drift-defense #81, added 2026-05-12) is the CI forcing function for this doctrine. It counts rule-shaped clauses in `packages/ai-core/src/prompt.ts` — `- ` bullets plus `<digit>. ` numbered RULES lines — against a measured `BASELINE` (current value lives in the script; the local minimum after the 2026-05-12 prompt-prune pass started at 62 and has bumped to 64 across the day's typed-truth-triple landings, each bump documented in the script's bump log with grade + reason). Growth fails the gate with the five-question audit reproduced in the failure message; pruning lowers the floor silently.

Smoke-alarm shape, not a per-clause registry. Bumping `BASELINE` IS the doctrine moment — the commit that bumps it names the new clause's grade (A or B per the table above) in the message. The gate cannot mechanize the grading; it forces the moment to ask. False negatives on inline non-bullet rules ("Never narrate physical actions" inside a paragraph) are accepted as the cost of low-maintenance defense — the most common drift pattern is adding new bullets, and that's what the gate catches.

Compounds with [`check-typed-truth-perception`](../drift-defenses.md) (#80): the wire half of every typed-truth triple is gated against drift; the prompt half is gated against accumulation. The two gates protect both halves of the doctrine that the typed-truth-perception memo names.
