---
"@motebit/ai-core": patch
---

**Close the producer gap on `task_step_narration`** — the missing fourth part of the typed-truth-perception "triple" that commit `8b1d6605` shipped without. The wire field was on `AIResponse`, the prompt taught emission, the validator existed — but no producer extracted the field from the model's response, so it was always `undefined` and the validator's pass-through branch fired 100% of the time. The triple was structurally complete on the registry side, inert at runtime. This commit ships the producer.

**The four-part typed-truth structure (now explicit).** A typed-truth-perception "triple" actually has four parts: wire + prompt + producer + validator. For tool-result fields (navigation_triggered, recovery_hint, etc.) the producer is IMPLICIT — the action-executor's dispatch IS the producer (it emits the field directly on the result struct). For narration-class fields the producer is EXPLICIT — a tag parser between model output text and `AIResponse`. The triple terminology hid the asymmetry; the producer gap on `task_step_narration` was a direct consequence. Pattern named in project memory `architecture_typed_truth_four_parts.md`; should be promoted to a paragraph in `runtime-invariants-over-prompt-rules.md` in a future session.

**The producer.** `extractNarrationTag(text)` in `packages/ai-core/src/core.ts` parses `<narration>...</narration>` tags out of the model's response text — sibling of `extractMemoryTags` (the established convention for "structured field on AIResponse derived from model text"). Three behavioral choices made deliberately:

- **Tag name `<narration>`** — short semantic noun, matching the actual codebase convention (`<memory>` → `memory_candidates` field, `<state>` → `state_updates` field). NOT `<task_step_narration>` — verbose tag would have contradicted the precedent.
- **Multiple-tag policy: take the LAST.** Asymmetric with `extractMemoryTags` (which takes ALL because memory is cumulative). Narration is about the model's CURRENT task-step — last tag is the most recent thought; first would be stale. The prompt instructs single-tag emission per turn; last-wins is the right default if the model violates the instruction.
- **Char cap at 80 with ellipsis truncation.** Chrome's calm-software ceiling — single-line narration, not a paragraph. Truncate over-cap content rather than dropping it: partial truth beats no truth in the chrome's narration register.

**Wire-up.** Three sites consume `extractNarrationTag` (the same three sites that already extract `<memory>` and `<state>`):

- `core.ts` Anthropic streaming provider's `done` chunk
- `core.ts` Anthropic non-streaming provider's `parseResponse`
- `openai-provider.ts` OpenAI streaming provider's `done` chunk
- `openai-provider.ts` OpenAI non-streaming provider's `parseResponse`

`stripTags` extended with `<narration>` regex so the tag never leaks into visible text (narration belongs to the slab's chrome register, not the chat / mote-conversation register — `goals → chat`, `task-steps → chrome` per `chrome-as-state-render.md` and `goals-vs-tasks.md`).

**Prompt clause updated** from "emit a `task_step_narration` field on your response" (which the model couldn't actually do — it returns text + tool_calls, not TypeScript object fields) to "emit a `<narration>...</narration>` tag" (which composes with the existing tag-emission pattern the model already uses for `<memory>` and `<state>`). Examples in the clause now show the literal tag wrapping.

**14 new tests** covering the producer's behavior: tag present (single, with whitespace, content trimmed), tag absent, multiple tags (last-wins, including with empty interspersed), empty content (returns null), malformed tags (unclosed, mismatched closing) returns null, over-cap truncation with ellipsis, under-cap pass-through, multi-line content, `stripTags` integration (single tag stripped, multiple tags stripped, composes with memory + state stripping).

**Operational consequence.** The "6 fields × 3-of-3" sync-invariant graduation count from the day's earlier sweep is now honest at the operational level (not just the registry level). The chrome work next session has a real producer to consume — model emits `<narration>` tag → extractor pulls into `task_step_narration` field → validator catches contradictions → chrome renders the validated string in the `motebit × virtual_browser` register. Full circulation, no inert primitive.

**Two new memory anchors saved this session, both worth promoting to doctrine in future sessions:**

- `architecture_typed_truth_four_parts.md` — typed-truth has four parts not three; producer is the often-implicit one that hides the asymmetry between tool-result and narration-class fields
- `feedback_verify_convention_claims.md` — when reviewer (or self) proposes a refinement justified by "X is the established convention," grep X before accepting; sibling discipline of `feedback_sibling_claim_grep_first` applied to convention claims

The double-self-correction loop in this session (user caught producer gap; reviewer caught my tag-name error before it landed) is the trust-but-verify discipline working as designed; both pattern anchors capture the meta-disciplines for future sessions.

484/484 ai-core tests green; 83/83 drift gates green; graph-wide typecheck clean. No API breaks (this is purely additive — the producer populates a previously-empty optional field).
