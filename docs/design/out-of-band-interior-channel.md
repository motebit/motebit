# Out-of-band interior channel

Status: design proposal. No production change. Not doctrine; if adopted, the
invariant in §2 is promoted into a doctrine doc and a gate (Inc 5).

## Problem

The model's answer text carries two streams in one string: the markdown the
user reads, and control material the runtime consumes (`<thinking>`,
`<memory …>`, `<state …/>`, `<narration>`, echoed tool markup, and, in the
strip rules, `*action cue*` asterisks). Every display path then recovers the
first stream by deleting the second with regex chains. The two streams share an
alphabet: `<memory>` is also a C++ header, `*think*` is also an italic word,
`<thinking>` is also something a user asks about, and a tag can be cut off by
the token limit or split across stream chunks.

Two unmerged fix branches spent nine review rounds on this layer, and each
round found a new miss:

- `fix/display-strip-preserves-markdown` (R1–R5): `39a3c57a5` markdown deleted
  as cues; `b3ab40b26` a mentioned tag truncated the answer ("can reason in a
  `<thinking>` block" → "can reason in a \`"); `692043ff3`/`aedb01a57` an
  unclosed block at line start leaked, and a stray backtick paired across a
  line and exposed a real block; `87af81dbf`/`90bd4c282` a stray backtick on
  the same line shielded a real block, fixed by declaring that inline code
  never shields a closed pair, which now hides legitimate quoted examples.
- `fix/display-parity-minimal` (R1–R4): `f0bef7e79` the same markdown loss;
  `90f41cf95`/`b80928a8d` removals that splice neighbours into a new tag;
  `8144ca54a`/`b745fcdc2` stream deltas diverging from the final text and
  unclosed blocks; `0769285e1`/`5d11ca1c2` `#include <memory>` and
  `<parameter>` samples truncating real answers.

The two branches also reached incompatible rules for the same input (one
hides an unclosed line-start opener to end of text, the other recognises only
main's attribute grammar so `#include <memory>` survives). Neither rule is
wrong. The input is ambiguous, and no parser can recover intent that the
representation did not record.

The cost is measurable. `f0bef7e79` records displayed answers scoring
**4.23/10** against **7.73** for the identical raw model output on the
intelligence-parity rubric (`feat/intelligence-parity-bench`,
`scripts/bench/intelligence-parity/`). The loss came from the strip, not the
model.

Conclusion: the representation is the bug. Control material should not travel
in the answer channel at all.

## 1. Inventory

### 1.1 What the model is taught to emit inline

All in `packages/ai-core/src/prompt.ts` unless noted.

| construct                         | taught at                                                                                                                                                                                             | grammar                                                                                   |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `<memory>`                        | `TAG_INSTRUCTIONS` (l.136–170); first-contact nudge (l.582); post-turn reminder (l.635)                                                                                                               | `<memory confidence="…" sensitivity="…" [type="episodic"]>…</memory>`, placed before text |
| `<state/>`                        | `TAG_INSTRUCTIONS` (l.167–170), `STATE_FIELD_DOCS`                                                                                                                                                    | `<state field="curiosity" value="0.8"/>`                                                  |
| `<narration>`                     | `PERCEPTION_DOCTRINE` (l.102)                                                                                                                                                                         | `<narration>Reading the page</narration>`, ≤80 chars, last wins                           |
| `<thinking>`                      | not taught; models emit it by habit. Captured since `extractReasoningTags` (`core.ts` l.548) for the owner-facing `mind` organ                                                                        | `<thinking>…</thinking>`                                                                  |
| `*action*`                        | **forbidden** by the prompt ("Do not use \*asterisks\* or stage directions", l.170, l.132)                                                                                                            | `*smiles*`                                                                                |
| echoed tool markup                | not taught; leaks from models that print tool syntax                                                                                                                                                  | `<parameter …>`, `<function_calls>`, `<invoke>`                                           |
| `[EXTERNAL_DATA]`/`[MEMORY_DATA]` | **input only**: the runtime wraps tool results and recalled memories in these fences (`packContext`, `core.ts` l.254) as injection boundaries. The model is never asked to emit them; it echoes them. | `[EXTERNAL_DATA source="…"]…[/EXTERNAL_DATA]`                                             |

### 1.2 What consumes each construct

| construct      | parser                                                                                    | consumer                                                                                                                                                                                                                                  |
| -------------- | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<memory>`     | `extractMemoryTags` (`core.ts` l.412)                                                     | `AIResponse.memory_candidates` → `MemoryGovernor` → provenance stamp `turnMemorySource` (`loop.ts` ~l.2086) → `formMemoriesFromCandidates`. The tag carries no source attribute by design (`memory-provenance.md`).                       |
| `<state/>`     | `extractStateTags` (`core.ts` l.431)                                                      | `AIResponse.state_updates` → `stateEngine.pushUpdate` (`loop.ts` ~l.2175), falling back to `inferStateFromText` when empty; also re-scanned on every chunk by `packages/runtime/src/streaming.ts` l.542. Foreign turns discard it (#943). |
| `<narration>`  | `extractNarrationTag` (`core.ts` l.493)                                                   | `AIResponse.task_step_narration` → `narration-validation.ts` → slab chrome (`chrome-as-state-render.md`).                                                                                                                                 |
| `<thinking>`   | `extractReasoningTags` (`core.ts` l.548)                                                  | `mergeReasoning(native, tagged)` → `AIResponse.reasoning` → `mind` organ, owner-only.                                                                                                                                                     |
| `*action*`     | `extractActions` (l.448), `actionsToStateUpdates` (l.658), `getImpulsesForAction` (l.755) | **none in production.** All three have test-only callers; `BehaviorEngine.injectImpulse` (`packages/behavior-engine/src/index.ts` l.112) has no production caller. The strip deletes every `*…*` span for a consumer that does not exist. |
| echoed markup  | none                                                                                      | none; strip-only.                                                                                                                                                                                                                         |
| `_DATA` fences | none on output                                                                            | none; strip-only.                                                                                                                                                                                                                         |

The asterisk row is the sharpest finding. `stripTags` and
`stripPartialActionTag` delete `*[^*]+*` (every markdown italic, and the inner
part of every `**bold**`), and `streaming.ts` deletes every `*{1,3}`, to
protect a channel the prompt forbids and no code reads.

### 1.3 Strip sites

Each is an independent regex chain or a call into one.

| site                                                                                 | function                                       | used for                                                    |
| ------------------------------------------------------------------------------------ | ---------------------------------------------- | ----------------------------------------------------------- |
| `packages/ai-core/src/core.ts` l.672                                                 | `stripTags`                                    | final `displayText` in `AnthropicProvider` (l.1281, l.1518) |
| `packages/ai-core/src/core.ts` l.796                                                 | `stripInternalTags`                            | markdown surfaces, slab items                               |
| `packages/ai-core/src/core.ts` l.821                                                 | `stripPartialActionTag`                        | plain-text surfaces                                         |
| `packages/ai-core/src/openai-provider.ts` l.436, l.602                               | `stripTags` (via extract set)                  | OpenAI-compatible final text                                |
| `packages/runtime/src/streaming.ts` l.48                                             | `stripDisplayTags` (own chain, own hold rules) | live stream to every surface                                |
| `packages/runtime/src/conversation.ts` l.36                                          | `stripInternalTags` (own copy, 4 rules)        | persisted history (no `<narration>`, no `_DATA` rules)      |
| `apps/desktop/src/ui/chat.ts` l.433, 540, 1204, 1384                                 | `stripPartialActionTag`                        | bubbles                                                     |
| `apps/desktop/src/ui/voice.ts` l.773, `apps/spatial/src/voice-pipeline.ts` l.252     | `stripTags`                                    | TTS input                                                   |
| `apps/desktop/src/ui/slab-items.ts` l.426, `apps/web/src/ui/slab-items.ts` l.443     | `stripInternalTags`                            | slab                                                        |
| `apps/web/src/ui/chat.ts` l.19, `apps/web/src/bootstrap.ts` l.390                    | `stripInternalTags` (+ space fold)             | chat, history reload                                        |
| `apps/web/src/providers.ts` l.280, l.349; `apps/spatial/src/providers.ts` l.179, 221 | `stripTags` + extractors                       | in-browser (WebLLM) providers                               |
| `apps/mobile/src/use-chat-stream.ts` l.135, 260, 278                                 | `stripPartialActionTag`, `stripTags`           | mobile chat                                                 |
| `apps/mobile/src/adapters/local-inference.ts` l.136                                  | `stripTags` + extractors                       | on-device Apple FM / MLX                                    |

Thirteen sites, at least five distinct rule sets. That the strip lives in this
many places is why the two branches needed stream-vs-final parity harnesses.

## 2. Target

Invariant: **the answer channel carries only user-facing markdown. Every
interior construct travels on a typed channel whose producer is code.**

| construct        | target channel                                                                                                                                                                                                                                                                  |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| reasoning        | provider-native reasoning: Anthropic `thinking` blocks / `thinking_delta`, OpenAI-compatible `reasoning_content`/`reasoning`. Already merged by `mergeReasoning`; the tag path becomes fallback.                                                                                |
| memory formation | interior tool `form_memory({content, confidence, sensitivity, type?})`. The name is already reserved in `TENDING_ALLOWED_TOOLS` (`packages/runtime/src/motebit-runtime.ts` l.395) with no definition. **No `source` field in the schema**; provenance stays `turnMemorySource`. |
| state            | interior tool `set_state({field: value, …})`, schema closed over the six `STATE_FIELD_DOCS` fields with `[0,1]` / `[-1,1]` ranges, so an unknown field or out-of-range value is a schema error, not a silently-parsed float. `inferStateFromText` stays the fallback.           |
| narration        | interior tool `narrate({text})`, `maxLength: 80`; same validator (`narration-validation.ts`).                                                                                                                                                                                   |
| creature cues    | none at first (§4 Inc 3). If wanted later: interior tool `express({cue})` with `cue` an enum over the `IMPULSE_MAP` keys, mapped to `injectImpulse` in code.                                                                                                                    |
| `_DATA` fences   | unchanged, input side only. They are prompt-injection fences around tool results and recalled memory; output never has to contain them.                                                                                                                                         |

"Interior tool" is a new tool class with three properties the runtime enforces,
not the prompt:

1. **Fire-and-record.** The runtime handles the call in code and never needs
   the model to see a result. A model message whose only tool calls are
   interior tools is final: the loop does not issue a continuation request.
   (On the Anthropic wire `stop_reason: tool_use` would otherwise cost a full
   round trip per turn.)
2. **Not replayed.** Interior `tool_use` blocks are removed from the assistant
   message before it enters `ConversationManager` history, so no dangling
   `tool_use` without `tool_result` is ever sent back, and history tokens do
   not grow. The event log keeps the record (`memory_formed`, `state_updated`).
3. **Not a tool turn.** Interior calls are excluded from
   `toolCallsSucceeded`/`toolCallsFailed` in `loop.ts`. Without this, a turn
   that forms a memory through `form_memory` would be stamped `tool_derived`
   instead of `user_stated`, and the dishonest-closing classifier
   (`dishonest-closing.ts`) would read it as a tool turn. Also excluded from
   `ToolInvocationReceipt` signing and from the policy gate's risk bands
   (they are `R0` interior writes, the same class as `rewrite_memory` in
   tending).

With this in place, the display strip is no longer the mechanism that keeps
interior material off the screen. It becomes a fail-closed compatibility path
for providers that cannot use the typed channel (§3), and on the primary path
it runs over text that, by construction, contains no interior material, so its
ambiguity no longer costs markdown.

## 3. Provider matrix

Adapters: `AnthropicProvider` (`core.ts`) and `OpenAIProvider`
(`openai-provider.ts`), the latter serving OpenAI, Google (OpenAI-compatible
endpoint), DeepSeek, Groq and local servers. Plus three text-only in-process
paths: web/spatial WebLLM and mobile on-device.

| provider                                    | tool calling              | native reasoning reaching `nativeReasoning`                                               | primary path                     | fallback                                                        |
| ------------------------------------------- | ------------------------- | ----------------------------------------------------------------------------------------- | -------------------------------- | --------------------------------------------------------------- |
| anthropic                                   | yes                       | yes when `extendedThinking` is set and `modelSupportsExtendedThinking` (l.582); else none | interior tools + native thinking | `inferStateFromText`; no tag teaching                           |
| openai                                      | yes                       | no: Chat Completions returns no reasoning text for reasoning models                       | interior tools                   | reasoning absent (the `mind` organ renders empty — fail-closed) |
| google (OpenAI-compat)                      | yes                       | not wired (thought text needs a provider-specific request flag)                           | interior tools                   | as openai                                                       |
| deepseek                                    | yes (chat model)          | yes, `reasoning_content` (reasoner model)                                                 | interior tools + native          | reasoner has weaker tool support: tag fallback per model        |
| groq                                        | yes on most hosted models | some models return `reasoning`; others print `<think>` inline                             | interior tools                   | per-model tag fallback                                          |
| local-server (Ollama, LM Studio, llama.cpp) | model-dependent           | `reasoning_content` on some servers; `<think>` inline on others                           | per-model capability probe       | tag fallback (today's path)                                     |
| WebLLM (web, spatial)                       | limited                   | `reasoning_content` on reasoning models                                                   | tag fallback                     | —                                                               |
| mobile Apple FM / MLX                       | no (text in, text out)    | no                                                                                        | tag fallback                     | —                                                               |

Two points follow:

- The fallback is permanent for on-device text-only engines. That is fine: the
  sensitivity rule sends medical/financial/secret turns _only_ to on-device
  providers, so the fallback must stay correct, not just present (§5).
- Tool-capability is per model, not per provider. The selection belongs in the
  existing model-aware assembly seam
  (`intelligence-pluggability-contract.md`, commitment 2): a typed
  `interiorChannel: "tools" | "tags"` resolved before prompt assembly, which
  selects both the prompt clause and the parser. One flag, never two that can
  disagree.

## 4. Migration

Each increment ships alone, keeps the tag parser running for one release as a
shadow (parsed, logged, not applied) so a regression is visible, and rolls back
by flipping `interiorChannel` to `"tags"` for the affected provider.

Measurement for every increment: re-run the intelligence-parity bench, route A
vs route B′ (raw replay) on the quality subset, per provider with a key. The
only recorded bar is the one pre-registered in
`docs/design/context-trimming-parity.md` (branch
`design/context-trimming-parity`, not on main): equivalence margin Δ = 1.0 on
the 10-point scale, TOST at α = 0.05 (90% cluster-bootstrap CI of the paired
difference inside [−Δ, +Δ]), ≥ 5 samples per item, "inconclusive" is not a
pass. Use the same bar here, comparing displayed text against raw text.

### Inc 0: measure and remove the dead consumer

- Delete the asterisk rules from `stripTags`, `stripPartialActionTag` and
  `streaming.ts`. Mark `extractActions`, `actionsToStateUpdates`,
  `getImpulsesForAction` deprecated (published `@motebit/ai-core` API, per
  `deprecation-lifecycle.md`), not removed.
- Invariant: tag-free markdown is byte-preserved by every strip site.
- Tests: the markdown corpus from `display-parity.test.ts`
  (`fix/display-parity-minimal`, `27db1b4a1`) ported to main.
- Measure: displayed vs raw on the bench. This one deletion is expected to
  recover most of 4.23 → 7.73, since the italic/bold loss was the dominant
  rubric penalty. Record the number before Inc 1, so later increments are
  judged on their own contribution.
- Risk: a model that ignores the prompt and writes `*smiles*` shows it. That
  is honest text, already forbidden by the prompt; no code consumed it.

### Inc 1: state via `set_state`

- Invariants: foreign turns never apply state (keep the #943 discard, now at
  the tool handler); out-of-schema values are rejected, not clamped silently;
  `inferStateFromText` fires when no call arrived.
- Tests: tool handler unit tests; loop test that an interior-only final
  message issues no continuation request; history test that no interior
  `tool_use` is replayed; `streaming.ts` applies state from the tool chunk.
- Risks: the call usually lands after the text, so the creature reacts at the
  end of the answer instead of mid-stream. Today `<state/>` is placed first and
  applied when the stream finishes (`pendingStateUpdates`, `streaming.ts` l.870), so the observed
  latency is roughly unchanged. Token cost: one tool schema (~150 tokens,
  cached) plus ~30 output tokens per call.

### Inc 2: memory via `form_memory`

- Invariants: provenance assigned only by `turnMemorySource`; the schema has
  no source/provenance field, and the handler ignores any extra key (closed
  schema, `additionalProperties: false`); interior calls excluded from
  `toolCallsSucceeded`; `isSelfReferential` and `MemoryGovernor` run unchanged
  on the candidates; `deferMemoryFormation` still yields
  `memory_formation_deferred`.
- Tests: the `foreign-turn-provenance.test.ts` and
  `foreign-turn-formation.test.ts` suites rerun with tool-borne candidates; a
  test that a turn whose only tool call is `form_memory` stamps `user_stated`;
  `check-memory-source-canonical` stays green unchanged.
- Measure: memory-formation recall on the leverage eval
  (`leverage-payoff-eval.test.ts`) must not drop: same count of formed
  memories on the fixture conversations ± 1.
- Risks: models under-call optional tools relative to inline tags; tune the
  prompt clause and measure, do not add `tool_choice: required` (it forces a
  call on small talk).

### Inc 3: narration via `narrate`; creature cues decided

- `narrate` replaces `<narration>`; the validator is unchanged.
- Cues: ship nothing unless the founder wants discrete gestures (Q2). If yes,
  `express` with an enum cue, handled by `injectImpulse`.
- Risk: narration must update while a browser task runs. It already only
  updates per turn (one tag per response, last wins), so a tool call per turn
  is equivalent.

### Inc 4: reasoning native-only on capable providers

- Stop accepting `<thinking>` as reasoning where `interiorChannel = "tools"`
  and native reasoning is available. The strip keeps hiding it.
- Invariant: reasoning is owner-only and never in `displayText`, history, sync
  or egress (unchanged contract of `AIResponse.reasoning`).
- Risk: OpenAI and Google produce no reasoning text, so the `mind` organ goes
  empty there. That is the honest state; do not reintroduce prompt-taught
  `<thinking>` to fill it.

### Inc 5: strip becomes fallback; gate

- One strip function in ai-core, used by all thirteen sites (the
  `conversation.ts` and `streaming.ts` copies deleted). Its rules apply only
  the tag grammar of constructs the model was taught on the `"tags"` path,
  plus the always-on fences and echoed tool markup.
- New gate `check-no-inline-interior-teaching`: fails if a prompt builder in
  `packages/ai-core/src/prompt.ts` (or any module that contributes to the
  system prompt) teaches an inline tag outside the clause selected by
  `interiorChannel = "tags"`. Repair instruction: add an interior tool. Register
  in `docs/drift-defenses.md`.
- Doctrine: promote §2 into `docs/doctrine/` (sibling of
  `typed-truth-perception.md` and `runtime-invariants-over-prompt-rules.md`).

## 5. Security and privacy

- **Sensitivity egress.** `interior-egress.ts` (branch
  `fix/egress-history-tier-filter`) admits interior items into a request only
  at a permitted tier and stamps derived artifacts with `derivedSensitivity`.
  Interior tool calls are interior content: `form_memory` arguments carry the
  memory text and its sensitivity. Property 2 (not replayed) keeps them out of
  later requests entirely; the event-log entries they produce are stamped like
  every other `memory_formed` / `state_updated` event and pass through the same
  filter. A replayed interior `tool_use` would be an unstamped egress path, so
  property 2 is a security property, not a token saving.
- **Provenance.** The model chooses the content of a memory; code chooses its
  source. A tool schema makes this easier to hold than the tag did, because a
  `source` key can be refused structurally. The risk is the counter in §2
  property 3: a tool-shaped interior write must never move the turn's source to
  `tool_derived`, and a foreign turn's `form_memory` must still be stamped
  `peer_agent`.
- **What the fallback strip must still guarantee.** On the `"tags"` path it
  remains the only thing between interior material and the screen, and it runs
  on the on-device providers that see the most sensitive turns. It must:
  hide every closed taught construct; hide an unclosed taught opener to the end
  of text in the final string and hold it in the stream; never show in a stream
  frame what the final hides (frames are prefixes of the final); and keep the
  differential and fuzz harnesses from both branches as its tests. It may hide
  too much on ambiguous input (fail-closed). On the `"tools"` path it should
  find nothing; a non-zero hit count there is logged as a model-conformance
  signal, not silently swallowed.
- **Injection.** `_DATA` fences stay input-only. Moving output off tags does not
  weaken them; it removes the one place where the model echoing a fence could
  have been confused with runtime-authored structure.

## 6. Open questions

1. **Ship Inc 0 before the rest?** Recommended: yes, alone and first. It is
   deletion of a rule with no consumer, and its bench number tells us how much
   of the gap the remaining increments are worth.
2. **Discrete creature gestures (`express`)?** Recommended: no for now. The
   prompt forbids stage directions and the body is driven by state
   (`TAG_INSTRUCTIONS`: "Your body is passive; your interior is active"). Add
   `express` only if a surface asks for gestures state cannot produce.
3. **Merge either display-strip branch?** Recommended: no. Take their harnesses
   (corpus, differential, fuzz, stream-prefix) into Inc 0 and Inc 5 as tests of
   the fallback; do not merge their rule sets, which disagree.
4. **Interior tools in the main tool list or a separate request field?**
   Recommended: the main list (providers have no separate field), with the
   interior class carried in our `ToolDefinition` so the loop, receipts and
   policy can exclude it.
5. **Cue placement: before or after the answer text?** Recommended: after.
   Before forces a continuation round trip on Anthropic (generation stops at
   `tool_use`). Revisit only if measured creature latency is a complaint.
6. **Per-model capability source for `interiorChannel`?** Recommended: a
   static table beside `modelSupportsExtendedThinking`, defaulting to `"tags"`
   for unknown models (fail-closed to the path that works everywhere), with a
   one-shot probe for local servers deferred until a user reports a miss.
7. **Keep `<thinking>` capture on providers with no native reasoning?**
   Recommended: keep the fallback capture on `"tags"`-path providers (on-device
   reasoning models print it); drop it on `"tools"`-path providers (Inc 4).
