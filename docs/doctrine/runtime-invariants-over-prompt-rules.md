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

| Fix                                               | Pattern                                                     | Grade                                                                                                      |
| ------------------------------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `frame_stale` typed-truth                         | wire field + dispatch retry + prompt teaching               | A — full triple, prompt is the smallest piece                                                              |
| Stale-bytes-omission                              | runtime computes staleness, snapshot field, prompt teaching | A — full triple                                                                                            |
| `synthesizeClosingFallback`                       | pure runtime guarantee, prompt teaching is additive         | A — runtime is load-bearing                                                                                |
| Conversation-memory `defaultSensitivity` baseline | runtime fix at construction site                            | A — runtime-only, zero prompt change                                                                       |
| Click-capture inscribed-inset alignment           | geometry alignment, zero prompt change                      | A — pure architecture                                                                                      |
| Click_element-over-key("Enter")                   | prompt-only (no runtime enforcement)                        | B — pure teaching, candidate for runtime conversion (tool-policy demotion of `key` for submit-class)       |
| Hedge-speak forbidden                             | prompt-only                                                 | B — pure teaching, hard to enforce at runtime                                                              |
| Compound-action execution                         | prompt-only                                                 | B — pure teaching, hard to enforce structurally                                                            |
| Search-intent routing (compressed 2026-05-12)     | prompt teaching, registry tier-sort enforces selection      | A after compression — was B-shaped pre-compression because it duplicated the registry's tier-sort behavior |

The B-grade items are not bugs; they're teaching that doesn't have an obvious runtime path. The audit's value isn't "make everything A" — it's "stay honest about which is which, and look for the A path before settling for B."
