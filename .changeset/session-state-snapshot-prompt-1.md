---
"@motebit/sdk": minor
---

Prompt-1 — runtime session-state surfaced to the AI's prompt as a
`[Now]` block. Closes the runtime-state-confabulation hallucination
class witnessed across the co-browse arc: the AI claims continuity
("the browser is already open on Hacker News") from conversation
memory after a refresh / runtime restart / dispose — when the
actual session is closed.

New exports from `@motebit/sdk`:

- `BrowserSessionInfo` — surface-supplied cloud-browser state.
  `status: "closed" | "open"`, plus optional `url` and
  `control: ControlState`. Surfaces register a provider via
  `runtime.setBrowserSessionProvider(...)`; absent provider →
  `{ status: "closed" }` default.
- `SessionStateSnapshot` — the full runtime-side composition: the
  surface's `BrowserSessionInfo` plus the runtime's
  `sensitivity` and `pixelConsent` fields. Built by
  `runtime.getSessionStateSnapshot()` once per AI turn and threaded
  into `ContextPack.sessionState`.
- `ContextPack.sessionState?: SessionStateSnapshot` — the new
  context-pack field. Loop threads it on every iteration (state
  can shift mid-turn — `/vision grant` flips consent; control
  transitions happen via the band).

Wire path:

```text
surface (web)              runtime                    ai-core
   │                          │                         │
   ├─ setBrowserSession        │                         │
   │  Provider(() => …)        │                         │
   │                          │                         │
                              getSessionStateSnapshot()
                              composes BrowserSessionInfo
                              + sensitivity + pixelConsent
                              │                         │
                              │   sendMessageStreaming  │
                              │   sessionState: …       │
                              │  ────────────────────►  │
                              │                         │
                              │                  contextPack
                              │                  .sessionState
                              │                         │
                              │                  formatSessionState
                              │                  → "[Now] Browser:
                              │                  open at … · Control:
                              │                  motebit driving · …"
```

Format restraint — only emit lines that have something to say.
Default state (closed browser, none sensitivity, denied consent)
collapses to `[Now] Browser: closed`. Elevated tiers and granted
consent get their own `·`-separated lines.

The PERCEPTION*DOCTRINE block in `packages/ai-core/src/prompt.ts`
extends with a rule: *"Runtime state is in the [Now] block — read
it, don't infer it. Do NOT claim 'the browser is already open' or
'we're on Hacker News' from conversation memory after a session
resumption — page refreshes, runtime restarts, and explicit
dispose calls all close sessions while leaving conversation
history intact. The [Now] block is the truth this turn."\_

Block named `[Now]` (not `[Session]`) to avoid collision with the
existing `[Session]` block, which describes conversation
continuity (when the user last spoke).

Open string-literal — additive new fields (e.g. desktop_drive
embodiment status, future per-domain consent) land without
breaking existing consumers.
