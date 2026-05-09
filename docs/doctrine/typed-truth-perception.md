# Typed-truth perception

The AI never interprets natural-language outcomes. Every tool result carries semantic-intent truth as structured fields; the prompt's `PERCEPTION_DOCTRINE` teaches the AI to read them and branch; the dispatch enforces the same condition structurally so the AI's behavior is never the only protection.

## The anti-pattern

A free-form tool result like `"navigated to nba.com"` and a prompt that says "the AI should describe what happened." On a slow load, the model says "didn't load" because it pattern-matches on conversation memory. On a same-URL re-navigation, it narrates a fresh navigation. Both are confabulations grounded in the model's predispositions, not in observed truth. Daniel's three-screenshot repro that drove `navigate-noop-when-already-there` is the canonical instance: same URL, same outcome, three avoidable steps in between because nothing structural caught the redundancy.

## The principle

> Tool results carry typed fields. The prompt teaches the AI to read them. The dispatch enforces the condition. The pair travels together.

Three coordinated commitments per typed-truth field:

1. **The wire format includes the semantic field.** Not only `ok: true` — also `already_there: boolean`, `slow_load: boolean`, `text_appeared: boolean`, `bytes_omitted_reason: string`, etc. The AI branches on these.

2. **`PERCEPTION_DOCTRINE` teaches reading them.** A prompt clause names each field's meaning and the right next move. Without the clause, the model invents.

3. **The dispatch enforces the condition structurally.** If the AI ignores the rule, the dispatch returns the right typed truth anyway. `urlsAreEquivalent` short-circuits `navigate` to the current URL with `already_there: true`. The runtime session manager's gate refuses `computer({...})` from `coBrowseControl.kind !== "motebit"` with `not_in_control`. The structural floor doesn't depend on the AI doing the right thing.

## Instances today

- **`not_in_control`** — runtime gate at the session manager refuses dispatch when `coBrowseControl.getState().kind !== "motebit"`; clause "Runtime gates ... arrive as typed errors on a tool call — never as 'a feeling' or an inference."

- **`navigate-noop` / `already_there`** — `services/browser-sandbox/src/url-equivalence.ts` short-circuits `doNavigate` when the requested URL canonicalizes equal to `session.page.url()`; clauses "Before navigating, read the [Now] block's browser line" and "`already_there: true` means the page was unchanged."

- **`text_appeared`** — `services/browser-sandbox`'s `evaluate` snapshot inside `doType` returns whether the typed text actually landed in a focused element; clause "A `type` action's `ok: true` only means keystrokes fired — it does NOT mean the text landed in the target field."

- **`bytes_omitted_reason`** — runtime's perception gate strips bytes from screenshots / image drops when sensitivity / pixel-consent gates fire; clauses on `bytes_omitted` going stale once the gate flips and on reading `sensitivity_blocked`.

- **`slow_load` / `visual_content_detected` / `blank_page_detected` / `access_denied_detected`** — `doNavigate`'s heuristic + readiness-state truth fields; clause on reading the metadata before describing the result.

## Why both halves

Without the dispatch floor, the AI's behavior is the only protection. Bad models, prompt drift, and confabulation all bypass an interpretation-only rule. The Daniel-typed-"open nba.com"-twice repro proved this: the prompt's `[Now]` block already surfaced `Browser: open at <url>` from `prompt-1`; the AI had truth in the prompt and re-fired the navigate anyway.

Without the prompt clause, the AI doesn't know to read the field. The dispatch returns truth that the model ignores or describes wrong. The cobrowse-input-capture truth-feedback shipped 2026-05-08 made this concrete: `text_appeared: false` was a useless byte until the prompt taught the AI to branch on it.

The pair is non-negotiable. New typed-truth fields ship with all three commitments — wire field, prompt clause, dispatch enforcement — or they don't compose.

## Where this lives

- **Wire format / semantic fields:** `services/browser-sandbox/src/action-executor.ts` (action results), `packages/runtime/src/computer-session-manager.ts` (gate refusals), `packages/runtime/src/perception.ts` (drop-payload outcomes).
- **Prompt clauses:** `packages/ai-core/src/prompt.ts` `PERCEPTION_DOCTRINE` constant.
- **Tests pin both sides:** `packages/ai-core/src/__tests__/prompt.test.ts` (clause text), `services/browser-sandbox/src/__tests__/action-executor.test.ts` (dispatch behavior), `services/browser-sandbox/src/__tests__/url-equivalence.test.ts` (comparator).

## Cross-cuts

- [`surface-determinism.md`](surface-determinism.md) — for affordance-driven invocations (button taps, slash commands, scene-object clicks), no AI in the loop. Typed-truth-perception is the AI-in-the-loop side: the AI IS the interpreter, but only of structured fields, never of free-form output.
- [`motebit-computer.md`](motebit-computer.md) — the slab is the body's first-person perception. The body shows acts; the AI describes them with typed-truth grounding, never confabulates around them.
- [`self-attesting-system.md`](self-attesting-system.md) — every claim is user-verifiable. Typed-truth fields make the AI's claims grounded in the same evidence the user has access to: the field exists in the audit log; the prompt clause is committed code; the dispatch enforcement is committed code.
