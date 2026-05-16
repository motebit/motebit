# Chrome as state render

The slab's chrome is **`render(controlState × embodimentMode)`**, not a fixed layout that lives around the screencast. Every cell of the matrix has its own register; the chrome's job is to render whichever cell the slab is currently in. The cobrowser-shaped chrome that ships today — URL bar primary, nav buttons, screencast as a page the user might drive — is the `user × virtual_browser` register universalized as if it were the only register. That's the polarity error this doctrine corrects.

The slab is "the body's first-person perceptual field made visible" ([`motebit-computer.md`](motebit-computer.md)). When the chrome treats it as a cobrowser, that doctrine is contradicted at the chrome level. The pivot inverts the default register: motebit-driving with task-step narration becomes the baseline; cobrowse becomes a mode the user explicitly enters.

This is not a UI redesign. It's a category shift in what the chrome IS. The cobrowser register doesn't go away — it becomes one cell of a matrix instead of the entire surface.

## The polarity error today

`apps/web/src/web-app.ts` renders chrome around the URL bar. `_homeOverlayActive` is focus-derived off the URL bar. The control band re-renders to "reflect the new URL." `ControlState` lives in `packages/protocol/src/co-browse.ts:66-74` with the four-kind union — but the chrome doesn't render against it. Same chrome for every state. That's the cobrowse-default-as-only-register shape.

The pivot starts when the chrome's render signature becomes `f(controlState × embodimentMode)` and each cell has its own register, not when the URL bar moves.

## The principle

> The chrome's render is `f(controlState × embodimentMode)`. Each cell has its own register. The default register is `motebit × virtual_browser`. Cobrowse becomes a mode the user enters explicitly.

Three coordinated commitments:

1. **The render signature is the matrix, not a slot.** A chrome that reads "what content goes here?" carries the polarity error. The right read is "which cell are we in, and what's that cell's register?" Even when only one column ships, the dispatcher is shaped against the matrix.
2. **Each register is an information shape, not a UI component.** The `motebit` register's content is task-step narration regardless of whether the surface renders it as a chrome strip (web), voice (spatial AR-glasses), or ambient indicator (mobile). If the design only makes sense WITH chrome, you've built chrome-specific UI and called it doctrine. The [spatial-as-endgame](spatial-as-endgame.md) test in §"Spatial-as-endgame validation" below.
3. **Cobrowse is an entered mode, not a persistent default.** A specific affordance flips the register from `motebit × virtual_browser` to `user × virtual_browser`. Exit the mode and you're back to observer.

## The matrix

`ControlState` × `EmbodimentMode` = 4 × 6 = 24 cells. Most are sparse; the meaningful cells fall into three families.

**`motebit × *` family** (the new default register; six cells, ~5 of them meaningful):

| cell                        | register content                                                                                                  |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `motebit × virtual_browser` | task-step narration ("Reading the page") + URL inline-with-narration; default cell                                |
| `motebit × mind`            | thinking narration ("Considering the trade-offs"); no screencast, no URL                                          |
| `motebit × shared_gaze`     | observation narration ("Watching what you're doing"); polarity flips — the screencast IS the user's screen        |
| `motebit × tool_result`     | result narration ("Here's the screenshot from earlier"); held register, no live action                            |
| `motebit × desktop_drive`   | local-driving narration ("Working in your terminal"); same shape as `virtual_browser` register, different surface |
| `motebit × peer_viewport`   | peer-action narration ("Showing what the other motebit is doing")                                                 |

**`user × *` family** (cobrowse entered; collapses to 3-4 meaningful cells):

| cell                     | register content                                                                                     |
| ------------------------ | ---------------------------------------------------------------------------------------------------- |
| `user × virtual_browser` | editable URL bar + nav buttons + small "motebit is watching" indicator; the cobrowser register today |
| `user × shared_gaze`     | "you're driving your screen, motebit is observing"; mostly cosmetic since the gaze flow is one-way   |
| `user × desktop_drive`   | "you're at your desktop"; effectively no slab chrome (the desktop IS the surface)                    |

`user × mind`, `user × tool_result`, `user × peer_viewport` collapse — there's nothing for the user to drive in those embodiments.

**`handoff_pending × *` and `paused × *` families** (mostly mode-invariant):

These are about authority transitions, not about what motebit is currently doing. The register is roughly the same across embodiment modes: `handoff_pending` shows the request line + accept/dismiss affordance; `paused` shows status + resume affordance. The 0.3 Hz breathing mark may pulse faster in `handoff_pending` to match the chrome's request register; specifics emerge in PR 3.

**Cells in scope for PR 1: one column (`* × virtual_browser`)** — `motebit × virtual_browser` (the new default) and `user × virtual_browser` (cobrowse-as-mode). Other embodiment columns are NAMED here and DEFERRED to PR N.

## The four control-state registers as information shapes

Each register is content, not visual treatment.

**`motebit` register — task-step narration.**

What motebit is currently doing, at the supervisor-cares-about granularity. Not action-step ("Typing 'm-o-t-e-b-i-t'") which reads as a status log and twitches the chrome at action-tick rate; not goal-step ("Looking up the M2 spec") which is the chat / mote-conversation register's job. The right slice is the chunk between action and goal:

```
"Reading the page"
"Filling in the form"
"Waiting for the page to load"
"Solving a CAPTCHA"
"Comparing prices across 3 sites"
"Hit a paywall — need your input"
"Submission didn't land — re-reading the page"
```

Apple's analog patterns converge on this layer: "Receiving 32 of 100 messages" not "fetched DNS for mail.google.com"; "Copying X items" not "wrote 4096 bytes"; "Indexing your Mac" not "scanned ~/Downloads/IMG_3847.jpeg". Granular enough that progress is visible (so the user knows it's not stuck), abstract enough that the chrome isn't twitchy (so calm-software holds).

Voice: first-person, motebit-voiced. "I'm reading the page" / "I hit a paywall — want me to log in?" The mote character is already there; the narration embodies it, not omnisciently narrates it.

Display: event-driven, not constantly-displayed. When motebit is actively doing something the narration appears; when idle/thinking/finished the slot recedes. Calm-software ideal: signals appear when needed and recede when not.

**`user` register — cobrowse mode entered.**

The cobrowser-shaped chrome that ships today, but as an _entered mode_ not the persistent default. Editable URL bar, nav buttons, click/scroll route to the page, motebit's role becomes assistant-on-standby. Includes a small indicator that motebit is watching (so the user knows they're not alone, and that motebit will narrate when they hand back).

**`handoff_pending` register — control transition requested.**

Explicit request line + accept/dismiss affordance. The 0.3 Hz breathing mark may pulse faster to match. Chrome inherits the breathing-rhythm doctrine from the substrate ([`liquescentia-as-substrate.md`](liquescentia-as-substrate.md)); specific rhythm emerges in PR 3.

**`paused` register — held state.**

Status + resume affordance. No animation. Held register; nothing moves until the user resumes.

## Hybrid narration source as the third typed-truth-perception triple

The narration text is **hybrid-sourced and typed-truth-validated**, paralleling the `dishonest-closing` exemplar. This is the third graduation of [`runtime-invariants-over-prompt-rules.md`](runtime-invariants-over-prompt-rules.md):

- **Exemplar 1 (closing-text fallback):** `synthesizeClosingFallback` — runtime synthesizes a closing sentence when `finalText.trim() === ""`. Cannot return empty. Pure function over `(toolCallsSucceeded, toolCallsFailed, lastToolName)`.
- **Exemplar 2 (closing-text correction):** `detectDishonestClosing` — runtime appends a correction when the model's draft closing text claims success that the typed truth contradicts. Walk-back over per-turn `toolResultsLog`. Append-correction (cannot UNSEND streamed text, so APPEND honest correction).
- **Exemplar 3 (in-flight narration):** the model proposes task-step narration; runtime validates against typed-truth before display; falsified lines never reach the chrome.

The triple for narration:

1. **Wire field.** A new `task_step_narration` field on the model's response, alongside tool selection. The model already reasons about what it's doing as part of choosing the next tool; surfacing that reasoning as a typed field is a small wire extension. NOT a separate LLM call dedicated to narration (cost, latency); NOT runtime-templated from tool kind (generic, not motebit-voiced). Option (a) — main loop's reasoning surfaces narration as a typed field. Spec lives on the `AIResponse` interface in `packages/sdk/src/index.ts`.
2. **Prompt clause.** `PERCEPTION_DOCTRINE` teaches: emit `task_step_narration` as a single first-person present-tense sentence describing what you're about to do or are doing right now. Granularity: task-step (between action and goal). Voice: motebit, first-person. Cap: ~80 chars (chrome is calm).
3. **Runtime validation before display.** A pure function in `packages/ai-core/src/dishonest-closing.ts` (or a sibling file) inspects the proposed narration against the most recent tool call's typed truth. If the narration claims "Reading apple.com" when the page URL is "google.com," falsify and substitute a runtime-templated fallback. The validation logic mirrors `detectDishonestClosing`: walk-back over `toolResultsLog`, claim-vs-typed-truth check, fall back when contradicted.

The narration's drift gate (sibling of `check-typed-truth-perception` Half-3) asserts the narration triple ships complete: wire field exists in the response schema, prompt clause exists in `prompt.ts`, runtime validation exists. The pattern compounds — the dishonest-closing intercept's structural shape becomes the structural shape for ALL motebit-voiced user-facing text.

## URL bar placement: option (ii) inline-with-narration

Three considered options for the `motebit × virtual_browser` register:

- **(i) Collapsed top-right glyph** (favicon + host as 12pt). Decouples URL from narration; user has to glance separately to see what motebit is looking at. Lower chrome density but loses the "this URL is what motebit is reading" tether.
- **(ii) Inline within narration strip** ("Reading apple.com →" with URL as a soft chip). Tethers the URL to what motebit is doing with it; the URL stops being navigation chrome and becomes context for the narration. The chip is read-only in the `motebit` register; tapping it does NOT navigate. Tapping it would be a candidate handoff trigger (see §"Take-the-wheel affordance in PR 1" below).
- **(iii) Bottom-right ambient label.** Makes the URL ambient infrastructure. Doesn't tether to narration. Calmest, but loses context.

**Decision: option (ii).** Rationale: in the agent-surface register the URL isn't an _affordance for the user_ (they're not navigating); it's _context for motebit's narration_ (the page motebit is currently working with). Tethering them spatially mirrors the semantic relationship — "I'm reading [this place]." The chip-vs-button distinction enforces read-only-ness visually; tapping the chip is a candidate handoff gesture in PR 2 (see below).

Option (i) becomes the right call only if dogfooding shows the inline chip overcrowds the narration strip. That's an emergent decision, not a PR 1 one.

## Take-the-wheel affordance in PR 1

PR 1 ships the polarity inversion AND the escape valve. Without a handoff path, PR 1 is broken for any flow that requires user input — CAPTCHA, login, MFA, "is this the right one?", "log into your bank for me." Real flows. PR 1 cannot ship as a regression even temporarily.

**Minimal handoff path in PR 1: a `/wheel` slash command + a focus-the-URL-chip click target.**

- `/wheel` flips `controlState` from `motebit` to `user`. Slash command is the cheapest surface to ship.
- Tapping the URL chip in the narration strip ALSO flips control. The chip is the most spatially-natural target since it represents "the page motebit is on" — handing over control means "I'll drive that page now."
- A `/back` slash command (or the same chip when in `user` mode showing "motebit waiting") flips back.

PR 2 polishes the affordance: explicit "take the wheel" button, gesture-based hand-off, the visual cue motebit gives when it's offering control vs when the user is grabbing it. PR 1 ships the path, not the polish.

## PR 1 scope

**In scope:**

1. State-driven chrome scaffolding. The chrome renderer dispatches on `controlState` × `embodimentMode`. Even though only one column (`* × virtual_browser`) ships content, the dispatcher is shaped against the matrix.
2. `motebit × virtual_browser` register. Task-step narration strip; URL inline as chip; screencast underneath. Replaces today's URL-bar-primary chrome as the default.
3. `user × virtual_browser` register. Editable URL bar + nav buttons + "motebit is watching" indicator. Same content as today's cobrowser chrome, but rendered as the `user` cell instead of as the universal default.
4. `task_step_narration` wire field, prompt clause, runtime validation. The third typed-truth-perception triple.
5. `/wheel` and `/back` slash commands; chip-tap as handoff trigger.
6. Drift gate for narration triple completeness.

**Out of scope (named here, deferred to PR 2-N):**

- Other embodiment columns (`mind`, `shared_gaze`, `tool_result`, `desktop_drive`, `peer_viewport`).
- `handoff_pending` and `paused` registers' specific visual treatment. (The control-state machine handles transitions correctly; the chrome's specific render for these states emerges in PR 3.)
- Mobile-native rendering of the same registers. (Mobile inherits the information shapes; the surface-specific render is its own pass.)
- Spatial AR-glasses rendering of the same registers as voice + gaze + ambient indicators. (Inherits same way; surface-specific.)
- Animation rhythms for state transitions. (Existing 0.3 Hz breathing applies; specifics emerge.)
- Visual polish on the `take-the-wheel` affordance (button, gesture, cue choreography).

## PR 2 scope (mobile, shipped 2026-05-13)

PR 2 ships the **second surface dispatcher against the same matrix**, lifting the doctrine from one-instance-deep (web alone could be a special case) to a generalizable pattern.

**Shape:**

- Pure dispatcher in `apps/mobile/src/slab-chrome.ts` exports `dispatchSlabChrome(state, embodimentMode, opts) → SlabChromeCell | null`. The cell description is surface-agnostic — a discriminated union over the four `controlState` registers — and the React Native component (`apps/mobile/src/components/SlabChrome.tsx`) maps each variant to a subtree.
- Splitting pure description from surface render makes the doctrine's "each register is an information shape, not a UI component" line legible in code: the dispatcher's return type IS the information shape, and the render is downstream. A future spatial renderer would consume the same `SlabChromeCell` shape without rewriting the dispatcher.
- `task_step_narration` chunk handling lands in `apps/mobile/src/use-chat-stream.ts` (alongside web's `apps/web/src/ui/chat.ts`): set on chunk arrival, cleared in a `try/finally` so a stale narration never outlives the turn (every-termination-path discipline per [`feedback_streaming_state_cleanup_every_path`]).
- `/wheel` and `/back` slash commands ship in `apps/mobile/src/slash-commands.ts` as the surface-deterministic affordance counterparts; the URL-chip and "motebit waiting" chip in the dispatcher's rendered cells dispatch the same slash commands.

**Structural lock:** `check-slab-chrome-coverage` (drift-defense #94) asserts each surface in the `SLAB_SURFACES` registry handles every `ControlState` and references every deferred embodiment in its dispatcher source. Adding a new surface (desktop, spatial) extends the registry and the gate forces matrix completeness in the new dispatcher.

**Mobile-as-renderer:** mobile has no live cobrowse session yet (cloud-browser dispatcher remains web-only at the consumer layer), so the `user × virtual_browser` / `handoff_pending × virtual_browser` / `paused × virtual_browser` cells are present in the dispatcher but inert at runtime today. The wire is set; the moment a mobile cloud-browser surface lands, the chrome's cells route through the existing `CoBrowseControlMachine` capability without further dispatcher work.

## PR 3 scope (spatial, shipped 2026-05-13)

PR 3 ships the **third surface dispatcher**, lifting the matrix from two-instance-deep to three-instance-deep and closing the spatial-as-endgame validation: the registers translate to a chromeless surface (voice + ambient + gaze) without semantic loss.

**Shape:**

- Pure dispatcher in `apps/spatial/src/slab-chrome.ts` exports `dispatchSlabChrome(state, embodimentMode, opts) → SlabChromeCell | null` — same signature, same cell-shape variants as mobile's. The dispatcher's body is 12 lines of switch-case over `ControlState`; per `feedback_endgame_not_mvp` × "rule of three," two duplicated dispatchers don't yet justify lifting to `@motebit/render-engine`. When a fourth slab surface arrives (desktop chrome, perhaps), promote `SlabChromeCell` + `dispatchSlabChrome` + `formatUrlHostForChip` to the shared package; drift-defense #94's `SLAB_SURFACES` registry is the discipline trigger.
- Spatial render adapter `renderCellToActivity(cell) → string | null` lives in the same file. The HUD's active-task field is spatial's chrome render (per `apps/spatial/CLAUDE.md` Rule 1: HUD is the non-negotiable safety floor — connection state, balance, active task); the cell maps directly into it. Voice cues + creature-gaze updates compose on top of the same cell when their adapters arrive (out of scope for PR 3 — the activity label is the minimum semantic render that demonstrates the doctrine).
- `task_step_narration` chunk handling in `spatial-app.ts` routes through the slab-chrome dispatcher (not `deriveStreamActivity`'s default arm), so the matrix-as-primitive path is the canonical seam. The two paths converge on the same string when narration alone fires; the slab-chrome path composes URL + narration (`"Reading the page · apple.com"`) and stands ready for the user / handoff / paused cells.

**Structural lock:** `check-slab-chrome-coverage` (drift-defense #94) now asserts 3 surfaces × 4 control states + 5 deferred embodiments — matrix fully covered across web, mobile, and spatial.

**Spatial-as-endgame validation closed:** the doctrine's claim "registers as information shapes survive the chromeless surface" is now testable end-to-end. The `SlabChromeCell` discriminated union flows from the dispatcher into surface-specific renders without any web-chrome assumptions leaking through. A future AR-glasses production renderer reads the same cell shape and composes voice + gaze + ambient indicators without re-deriving the matrix.

## Spatial-as-endgame validation

The registers are correct **only if they translate to surfaces without chrome**.

On AR glasses ([`spatial-as-endgame.md`](spatial-as-endgame.md)) there is no chrome strip. The same registers must render as voice + gaze + ambient indicators:

- `motebit × virtual_browser`: voice narration ("I'm reading the page"); gaze indicator showing where motebit is looking; URL as ambient label in the user's peripheral view.
- `motebit × mind`: voice narration ("Considering the trade-offs"); no gaze direction (motebit is internal); no URL.
- `user × virtual_browser`: cobrowse-mode entered means motebit's gaze withdraws (the indicator fades); the user's gaze is the active gaze; voice indicator confirms "I'm watching, hand back when ready."
- `handoff_pending`: spatial mark pulses faster (same 0.3 Hz substrate, faster cadence) + spatial audio cue.

If any register only makes sense WITH the chrome strip, it's chrome-specific UI dressed as doctrine. The validation criterion: each register's information shape must compose into a chromeless surface without semantic loss. The matrix survives the surface change; the visual treatment doesn't.

This is the test that prevents the pivot from being a 2D UI redesign. The matrix as architectural primitive is end-game-correct only if it translates.

## Cross-doctrine compose

This pivot composes with five doctrines that today live as separate concerns:

- **[`intent-gated-slab`](intent-gated-slab.md)** — the slab is the state-render's substrate, always-already present. The chrome's state-driven render is the substrate's state-driven content.
- **[`goals-vs-tasks`](goals-vs-tasks.md)** — registers cleanly split: goals → chat (mote conversation), task-steps → slab chrome. The seam is the doctrinal cut you already named.
- **[`runtime-invariants-over-prompt-rules`](runtime-invariants-over-prompt-rules.md)** — hybrid narration extends the typed-truth exemplar to in-flight motebit-voiced text. Exemplar 3.
- **[`motebit-computer`](motebit-computer.md)** — chrome finally reflects the slab as motebit's perceptual field, not a cobrowser. The doctrine's "first-person perceptual field made visible" line stops being aspirational.
- **[`spatial-as-endgame`](spatial-as-endgame.md)** — registers as information shapes survive the chromeless surface. The matrix as architectural primitive holds across web → mobile → spatial.

The pivot doesn't introduce new doctrines; it surfaces the structural cut where these five compose. The chrome's state-driven render is where they meet.

## What this doctrine deliberately does NOT specify

These decisions stay emergent. Specifying them now ossifies what should remain in motion through PR 2-N.

- **Specific visual treatments inside each register.** Typography, color, spacing, animation cadence — these emerge through PR 1 design + dogfooding.
- **Per-cell content for non-PR-1 cells.** The `motebit × shared_gaze` register's narration phrasing, the `paused × *` register's resume-affordance shape, the `user × desktop_drive` cell's chrome (or lack of it). These are named here as deferred; PR 2-N specifies them.
- **The chat / mote-conversation register's interaction with the chrome.** The `goals → chat, task-steps → chrome` cut is named; the seam itself (when does mote speak vs when does chrome narrate; do they ever overlap; what happens when both have content) emerges through PR 2 + dogfooding.
- **Animation rhythms for state transitions.** The 0.3 Hz breathing inheritance from [`liquescentia-as-substrate.md`](liquescentia-as-substrate.md) holds; specific cadences for `handoff_pending` pulse-up, `paused` hold, etc. emerge.
- **Mobile-native and spatial-native renders of the matrix.** The surfaces inherit the information shapes via the spatial-as-endgame validation; their specific render is each surface's own pass.

The contract this doctrine freezes is the architectural primitive (`f(controlState × embodimentMode)`), the four registers as information shapes, the third typed-truth-perception triple, the URL bar placement decision, and PR 1's scope. Everything else stays in motion.
