# Context trimming: recall parity

Status: **P1 + skip-not-stop implemented** (branch `feat/context-budget-from-window`).
Acceptance step 1 (harness) is green; step 2 (bench parity, paid model calls)
and step 3 (cost/latency deltas) have not been run. Harness:
[`packages/runtime/src/__tests__/context-trimming-parity.test.ts`](../../packages/runtime/src/__tests__/context-trimming-parity.test.ts)
(helpers in `packages/runtime/src/__tests__/helpers/context-trimming-*.ts`).

## What shipped

| piece         | where                                                                                  | what it does                                                                                                                                                                                                                                                                                        |
| ------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| window table  | `MODEL_CONTEXT_WINDOW_TOKENS` / `contextWindowForModel` (`packages/sdk/src/models.ts`) | Closed `Record` over every hosted model id. Vendor-published standard-tier windows; `null` = not known (OpenAI `gpt-5.4*`, `deepseek-chat` today). Feeds `ProviderCapability.contextWindowTokens` in the BYOK catalog. Local servers: `RuntimeConfig.contextWindowTokens` (the server's `num_ctx`). |
| measurement   | `measureNonHistoryTokens` (`packages/ai-core/src/loop.ts`)                             | Per turn, after recall: assembled system prompt (context pack rendered in) + tool schemas + current message. Passed to `TurnOptions.budgetConversationHistory`.                                                                                                                                     |
| budget        | `historyBudgetForWindow` (`packages/ai-core/src/context-window.ts`)                    | `clamp(window − measured − outputReserve (8,192), 6,976, ceiling)`; unknown window ⇒ 6,976. Ceiling per capability tier, default 64,000 (`RuntimeConfig.historyCeilingTokens`).                                                                                                                     |
| skip-not-stop | `trimConversation`                                                                     | Newest → oldest, skips a message (or a tool call with its results, as one unit) that does not fit; order and object identity of kept messages unchanged; the trim note is unchanged.                                                                                                                |
| no count cap  | `ConversationManager` (`packages/runtime/src/conversation.ts`)                         | The 40-message cap is gone (`maxConversationHistory` is now opt-in). In-memory history has a token bound (2 × the largest ceiling) applied identically by `load`, `resumeActiveConversation` and the push paths, so live and resumed conversations hold the same messages.                          |

Governance is unchanged: the sensitivity filter in `trimmed()` runs before the
budget; a foreign turn's view is empty and `budgetConversationHistory` is
classified owner-interior (floored away for a foreign turn);
`assertSensitivityPermitsAiCall` is untouched.

Known limits: the approval-continuation path (`streaming.ts`) still sends the
live in-memory history unbudgeted, now bounded by the token bound rather than
40 messages; a small local window should be configured
(`contextWindowTokens`) and still trims at the 6,976 floor.

## Problem

The intelligence-parity bench ([`scripts/bench/intelligence-parity/`](../../scripts/bench/intelligence-parity/README.md), #1076)
isolates one ingredient per contrast. On the long-context recall items, route
B″ (neutral system prompt + motebit's **trimmed** messages) scored **2.88/10**,
and route B (neutral system prompt + the **full** conversation) scored **9.00**.
The system-prompt contrast (B′ ↔ B″) was not significant. The loss comes from
trimming, not from the prompt.

## Policy before this change

There was exactly one history budget, and it never looked at the model.

| step                  | where                                                                                                      | what it does                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --------------------- | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. count cap (live)   | `ConversationManager.pushExchange` / `pushActivation` (`packages/runtime/src/conversation.ts`)             | After each exchange, in-memory history is sliced to the newest `maxHistory` messages (`RuntimeConfig.maxConversationHistory ?? 40`). `load()` / `resumeActiveConversation()` do **not** cap, so a resumed conversation starts uncapped and is capped again at the next exchange.                                                                                                                                                        |
| 2. sensitivity filter | `ConversationManager.trimmed()`                                                                            | Drops messages whose `sensitivity` exceeds the session's effective tier (`sensitivityPermits(effective, msg.sensitivity)`); untagged messages pass. Fail-closed read side of the egress-shape arc.                                                                                                                                                                                                                                      |
| 3. token budget       | `trimConversation` (`packages/ai-core/src/context-window.ts`) with `CONVERSATION_BUDGET` (conversation.ts) | `maxTokens: 8000`, `reserveForResponse: 1024` ⇒ **6,976 history tokens for every provider and model**. Tokens are estimated at `ceil(chars / 4)`. Walks newest → oldest and **stops at the first message that does not fit**: the kept set is always a contiguous suffix. One large message (a paste) blocks everything older than it even when budget remains.                                                                         |
| 4. replacement        | `trimConversation`                                                                                         | If anything was dropped, prepends one `user` message: `[Earlier in this conversation: <summary>]` when a stored summary exists, otherwise the generic `[This conversation continues from earlier. Some messages have been trimmed for context.]`.                                                                                                                                                                                       |
| 5. summary (async)    | `ConversationManager.runSummarization` → `summarizeConversation` (`packages/ai-core/src/summarizer.ts`)    | Fires in the background from `pushExchange` when `history.length % summarizeAfterMessages === 0` (default 20), behind the sensitivity gate (`assertSensitivityPermitsAiCall("summarizeConversation")`), and only with a provider and a store. The prompt asks for 2–4 third-person sentences of topics, decisions and preferences. Nothing guarantees a specific fact survives; a loaded conversation is not summarized until it grows. |
| 6. turn               | `sendMessage` / `sendMessageStreaming` (`motebit-runtime.ts`) → `runTurn` (`packages/ai-core/src/loop.ts`) | Passes `convo.trimmed()` as `conversationHistory`. Within a turn, tool rounds append to that array; nothing further trims it.                                                                                                                                                                                                                                                                                                           |

What does **not** exist:

- A context-window registry. `ProviderCapability.contextWindowTokens`
  (`packages/protocol/src/routing.ts`) is optional and unpopulated, and no
  runtime path reads a window. No provider adapter (Anthropic, OpenAI-compatible
  for OpenAI / Google / DeepSeek / Groq / local servers) trims or budgets
  history.
- Budgeting of the system prompt and tool schemas against the window. The
  doctrine names it ([`intelligence-pluggability-contract.md`](../doctrine/intelligence-pluggability-contract.md)
  commitment 2: "`trimConversation` … reserves the system-prompt + tool budget
  instead of treating them as free") but it is not built.
  `check-prompt-budget` measures static prompt bytes in `prompt.ts` only; it
  does not touch history.

## What the harness showed (before)

Offline, deterministic, no model calls. For each fixture × every model in the
SDK registry (13 Anthropic, 3 OpenAI, 3 Google, 1 DeepSeek, 2 Groq, 7 local
servers), it drives `ConversationManager.load()` → `trimmed()` and reports
surviving turns, history tokens used / allowed / the model's window, and a
recall probe per planted fact.

| fixture                            | full history | kept (production)         | planted facts (production)   |
| ---------------------------------- | ------------ | ------------------------- | ---------------------------- |
| bench `longctx-turn1-recall`       | 7,602 tok    | 23/26 msgs, **2,393 tok** | codename, date, EU rule LOST |
| bench `longctx-goal-followup`      | 300 tok      | 12/12                     | all kept                     |
| synthetic paste-then-ask           | 8,237 tok    | 21/24, 2,201 tok          | contract no., renewal LOST   |
| synthetic long chat (30 exchanges) | 33,770 tok   | 12/60, 6,756 tok          | turns 0 and 20 LOST          |
| live path, 21 tiny exchanges       | ~100 tok     | 40/42 (count cap)         | turn-0 fact LOST             |

The result is identical for every provider and model, from an 8k local server
to a 1M-token Gemini. Every cloud model's window holds each of these
conversations with room to spare, plus 12k of prompt/tool overhead and an 8k
output reserve.

## Root cause

1. **The budget is a constant far below the window.** 6,976 history tokens is
   3.5% of a 200k Claude window and 0.7% of Gemini's. It was set as
   "conservative to fit most models" before any window was known. No code path
   lets the window raise it.
2. **Drop-oldest with a hard stop.** The walk ends at the first message that
   does not fit, so one paste evicts everything before it. On the bench item
   only 2,393 of 6,976 tokens were used. Turn 0, where users state the ground
   rules, is the first thing to go.
3. **The replacement carries no facts.** With no stored summary (the bench case,
   and any conversation shorter than 20 messages or loaded rather than grown),
   the model gets the generic trim note. With a summary, recall depends on a
   2–4 sentence topic summary keeping the specific value.
4. **A second, count-based dropper.** The live path keeps only 40 messages in
   memory regardless of tokens.

## Candidate policies

### P1: budget derived from the model's real window (recommended)

`historyBudget = max(6,976, window − (system + tools + context pack + current message) − outputReserve)`.

- Populate a window per model (a closed table next to the SDK model lists,
  feeding `ProviderCapability.contextWindowTokens`; local servers report their
  configured `num_ctx`; unknown ⇒ today's 6,976 floor, so the change is
  fail-safe).
- Measure the assembled system prompt and tool schemas for the turn instead of
  assuming they are free. This is commitment 2 of the pluggability contract.
- Replace the count cap with the token budget (or raise it to a token-derived
  bound) so the live path and the resumed path agree.
- Keep drop-oldest as the fallback when the window really is too small.

Trade-offs: input tokens per turn grow with conversation length up to the
window. Cost is linear in history. Prompt caching (Anthropic `cache_control`,
OpenAI automatic prefix caching) bills a stable prefix at a fraction of the
input price, so append-only history caches well. Latency: TTFT grows with
uncached input. Bound this with a soft target, for example
`min(window-derived, policy ceiling)` per provider tier, so a 1M window does
not mean every turn ships 1M tokens. Long-context quality also degrades
slightly at extreme lengths ("lost in the middle"); the ceiling caps that too.

### P2: pinned salient turns + drop-oldest

Always keep the first user turn(s) and any turn the user marks or the runtime
classifies as an instruction/constraint, then fill the rest newest-first, and
skip (rather than stop at) a message that doesn't fit.

Trade-offs: cheap and model-independent. Fixes the bench item. Salience
classification is heuristic and fails silently on facts stated mid-conversation
(synthetic long chat, turn 20). Skip-not-stop alone is a strict improvement and
could ship inside P1.

### P3: summarize-then-drop / retrieve dropped facts from memory

Before dropping, guarantee a fact-preserving summary of the dropped span
(synchronously, or block the drop until the async summary covers it).
Alternatively, rely on memory retrieval (`recall_memories`, the context pack's
relevant memories) to bring dropped facts back.

Trade-offs: an extra model call (cost, latency, and a sensitivity-gated egress
of the dropped span). Lossy by construction, because the summarizer chooses
what matters. Memory retrieval depends on memory formation having captured
the fact and on retrieval ranking it. That is right for cross-session recall
and the wrong tool for "what did I say ten minutes ago". This is the natural
complement for windows that are genuinely too small (local 8k), not the
primary fix.

## Recommendation

**P1, with skip-not-stop from P2**, and P3 kept as the small-window fallback.
P1 removes the cause: the model is never consulted, so it closes the gap on
every provider at once. It is also the policy the pluggability contract
already commits to. The 6,976 floor means no model is trimmed harder than
today.

## Governance invariants (must hold under any policy)

- **The sensitivity filter runs before budgeting, unchanged.** A larger window
  increases how many _permitted_ messages fit. It never changes which are
  permitted. The harness asserts this: a Secret-tagged fact is dropped at a
  None-tier session under both the production and the window-derived budget,
  on every model.
- Medical / financial / secret never reach external AI. The pre-call gate
  (`assertSensitivityPermitsAiCall`) is untouched. Sending more history must
  not bypass the session tier the gate evaluated.
- Foreign-principal turns keep an empty history (`FOREIGN_TURN_CONVERSATION`).
- Summarization stays behind the gate. If P3 is used, the synchronous summary
  call is a new egress and must go through the same gate.
- Memory never confers authority. Retained history informs. It does not
  authorize, and it changes nothing in `check-money-authority`.

## Acceptance test

1. **Harness green on the recommended policy.** Flip the production assertions
   in `context-trimming-parity.test.ts` to the candidate block's contract:
   every planted fact survives on every model whose window holds the
   conversation, small local windows still trim, and the governance test still
   passes. The window table moves from the test fixture to the production
   registry.
2. **Bench parity.** Re-run the intelligence-parity bench on the long-context
   subset, per provider (at least `anthropic` and `openai`, plus every provider
   with a key), with a pre-registered equivalence margin Δ = 1.0 point on the
   10-point scale. Test B″ ↔ B with **TOST** (two one-sided tests, α = 0.05
   each, i.e. the 90% cluster-bootstrap CI of mean(B″ − B) lies inside
   [−Δ, +Δ]). Pass = equivalent on every provider run. Use enough repetitions
   (≥ 5 per item) that the CI can fit inside the margin. If it cannot, the
   result is "inconclusive", not "pass".
3. Report cost and latency deltas (A ↔ B′ input tokens, TTFT) alongside, so the
   ceiling in P1 is set from measurement.
