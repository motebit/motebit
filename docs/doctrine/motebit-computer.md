# Motebit Computer — the slab

The slab is the motebit's **workstation, rendered as a liquescent plane** beside the creature. It holds pages the motebit has read, terminals it is using, responses it has streamed, delegations in flight, peer replies returning with signed receipts. Work stays available until the user dismisses it or the session ends.

- **Chat is second-person** — you ↔ motebit, words exchanged.
- **Slab is first-person** — the agent's frame, where the work it has been doing lives in the modality it belongs to.

First-person here doesn't mean watching live (AI is faster than human perception, most of the time); it means inhabiting the agent's view of the work it has been doing. The agent's eye, hand, and mind, made into a workstation you can see and touch.

**The three organs carry three truth-grades, and the render must never flatten them.** The eye shows _typed perception_ (every field provenance-marked — [`typed-truth-perception.md`](typed-truth-perception.md)); the hand shows _receipted acts_ (signed, offline-verifiable); the mind shows _validated narration_ — a model's account of its own reasoning, the weakest truth-grade in the system, admitted to the slab only because `task_step_narration` is a dishonesty-narration-class field with an explicit producer AND validator (the only field class that needs both). Rendering mind-pane text with the visual authority of receipted acts would launder confabulation as mechanism — the one way this taxonomy rots from engineering into decoration. (The organ words are an index over typed structures, never load-bearing themselves; the sibling entry-law lives in [`sensorium.md`](sensorium.md), a deliberately different axis — display taxonomy here, entry discipline there.)

## What it is

A liquescent plane floating to the right of the motebit. Sibling to **constellation** (clusters of related records), **artifact** (detached, persistent outputs), **chat bubble** (ephemeral conversational messages). It is not a panel, not a window, not a HUD. It has a meniscus, not a frame; no titlebar, no close button, no scrollbar chrome.

What appears on the slab is what the motebit is — or has been — **seeing, doing, and attending to**, in its own first-person frame. Pages appear as the motebit reads them; terminals scroll as commands run; memory surfaces as it becomes relevant. Most items rest after their active phase ends; ephemeral plumbing dissolves; durable outputs detach into the scene.

In [`records-vs-acts.md`](records-vs-acts.md): the slab is the canonical surface for **acts**. Acts are lived experiences rendered in the perceptual modality they belong to — a web fetch is a page being seen, not a "fetch status."

## What renders — three organs

### Eye — perception

The first-person visual field. Active fetches stream, read pages rest.

- **Web pages** the motebit is reading — the actual content (or a faithful preview), not a URL string.
- **Search results** as the motebit reads them.
- **Files** it opens, rendered as they are (code highlighted, text rendered, images displayed).
- **Peer motebit replies** as beads arriving from offscreen, carrying the peer's identity and the returned receipt.
- **Desktop regions** the motebit is attending to, as a live fragment (when driving the user's desktop).

### Hand — action

Work in motion, then work in place — not work being labeled.

- **Shell / terminal output** scrolls as commands run.
- **Forms filling** as fields populate.
- **Code being written** as the editor-like surface types.
- **Files being edited** as diffs appear.
- **Delegation outbound** — packet leaves the slab; returns as a bead with a signed receipt, peer identity visible.

### Mind — reflection

Internal reorganization made visible.

- **Streaming tokens** of the current response, before crystallization into a chat bubble.
- **Memory surfacing** — nodes rise into attention as they become relevant; drift back as they fall away.
- **Plan walking** — current step focuses, prior steps recede, next steps ghost in.
- **Embedding / inference** — the moment of a thought being formed, rendered as a brief condensation.

### Not on the slab

- **Records** (credentials, settled receipts, memory index, balance history) — panel content, not slab content.
- **Chat bubbles** — second-person, parallel surface.
- **Third-person labels** — `fetch: calling…` is a log line; the slab renders the page itself.
- **Constellations** — they cluster above the slab when their domain is active; their own scene object.
- **UI chrome** (buttons, menus, inputs) — affordances live on the creature or in panels.

## Body register — the tri-state

The slab's body region (the area below the chrome strip) is in exactly one of three registers at any moment. The register is **typed at `@motebit/render-engine::SlabBodyRegister`** and **lives in `slab-core.ts` as the single source of truth**; the renderer derives screen-mesh visibility from it, and surfaces mount the body content based on it. One value, two physical levers (the WebGL screen mesh and the CSS3D `bodySlot`), zero possibility of drift.

| Register       | What's in the body                                                   | Screen mesh | Texture                                 |
| -------------- | -------------------------------------------------------------------- | ----------- | --------------------------------------- |
| **home**       | The home view — forward-framed affordances. The slab's READY floor.  | hidden      | released (paired `clearSlabScreencast`) |
| **live**       | The live screencast — the page the motebit is browsing.              | visible     | installed, replaced per-frame           |
| **transition** | The home view overlays a dim screencast (URL-bar focus mid-session). | hidden      | preserved (resume is cold-start-free)   |

The two **cause-bits** that compose the register live on the surface (web: `_onHomeRegister` from URL state, `_homeOverlayActive` from URL-bar focus state). The composition is `effectiveBodyRegister()` — one mapping, one writer, one reader, no implicit coupling. Prior to 2026-05-11 the register was implicit in `{screenTexture present, screencastSuppressed boolean}` and `home` was indistinguishable from `transition` at the renderer (both rendered as "mesh hidden") despite having opposite texture lifecycles. The typed register names the difference and makes the renderer's derivation honest.

### Home — the could-be register

Of the three registers, `home` deserves its own subsection — it's the fourth content register alongside eye / hand / mind, and the one that names the slab's **READY floor**. When no session is active (cold-start, post-dismiss, `about:blank`), the body shows forward-framed launchpads informed by the motebit's own signed audit log of past navigates. The framing is what makes it slab-native rather than panel-native:

- **Forward verb, not chronological entry.** Tiles read as `Continue google.com`, not `Visited 2 days ago`. The DATA is past-affinity (the same redacted audit-log records that populate the sovereign panel); the TILE means "I would like to go here next." Same data, two surfaces, two reading registers — records-as-records (panel) vs records-as-resumption (slab).
- **Privacy-aligned through the audit log's existing redaction.** The audit log keeps only scheme + host (`co-browse.ts` §"URL-redacted navigate detail"), exactly the coarseness resumption needs.
- **Empty-empty is "Anywhere."** First-time user with no history yet: one soul-tinted watermark word, breathing at 0.3 Hz, no decorative mark, no caption competing with the chrome's `"type a URL · or ask motebit"`. Two ready signals competing is a violation; one of them must speak.
- **Substrate-bubbles, not cards.** Lower bg alpha + heavier backdrop blur than a card. Tiles read as content **rising through** the slab rather than sitting on it. The materiality delta from "card" → "bubble" is the difference between close-but-not-exact and exactly-the-doctrine.

Doctrine compounds: home is `records-as-resumption` — the records-vs-acts test (`records-vs-acts.md`) holds because the same byte-records appear in two **registers**, not because records moved onto the body. The panel's credential list is records-as-records; the slab's home tile is records-as-resumption. Both refer to the same signed data, neither is the other.

### Home, refined (2026-06-04): the resting face

> **The slab's home is the motebit's self-knowledge rendered as its resting face.**

Everything below follows from that line. The current default — a URL bar + `"type a URL"` + `"Anywhere."` — is **browser chrome wearing the costume of the workstation** (the eye organ standing in for the whole). The home register is not a browser; it is the slab at rest, showing what this motebit _is_ and _could do next_.

**Chrome is ingress; the body is the home register.** Reconciles the seam with [`intent-gated-slab`](intent-gated-slab.md) §"Modal — empty is READY" ("the chrome IS the affordance… URL input"): the **chrome strip** is the always-on _way in_ (ask / name a destination); the **slab body** is the home register (the content). Both present, never competing — the URL input is the chrome, this §home is the body. The de-browser fix is in the chrome's _lead_: "ask me, or name where to go" — the URL is one affordance, not the slab's identity.

**The body has two content sources and an arc between them:**

- **Resumption tiles** — audit-log-derived (`Continue google.com`), history-gated. The full-state above.
- **Capability-seed tiles** — registry-derived (`Find an agent`, `Read a page`), available from N=0. The workstation introducing what it can do.

The arc _is_ the accumulation thesis at the home layer:

```
N=0      capability-seed         "here's what I am / could do next"
N grows  resumption fills in     "here's where we've been"; capability recedes to secondary
N large  resumption-dominant     "this is yours now"
```

So the home register is a **what-can-we-do surface whose content shifts from invitation to resumption** — not a resumption viewer with a blank fallback. The longer it runs, the more _yours_ it is: identity formation rendered in tiles.

**Derive the seed; never author it.** The seed is `capability-registry × config-state`, sourced from the rings + tool-registry + readiness the motebit already tracks — not a hand-maintained list (which would drift from what's actually wired: the claimed-vs-enforced hazard this repo gates against). So the N=0 surface _cannot lie_ about what the motebit can do — a mirror, not a brochure. Three layers, by readiness:

1. **Intrinsic floor — never gated.** The irreducible self is the **identity** (key-derived: sigil + `motebit_id`), present at absolute zero. This is the metabolic principle as the home floor — _the body is yours, the identity is yours, the intelligence is pluggable_ ([`THE_METABOLIC_PRINCIPLE.md`](../../THE_METABOLIC_PRINCIPLE.md)). With it: **declare-intent** (`Set a goal` — a local record, genuinely model-free) and **address-me** (the chat input is always present). The floor presents _the self and the path to a mind_.
   > **Precision (load-bearing).** "Ask me" is the _address-surface_ (always present) — but a working _answer_ is model-gated. A bare motebit (no model) shows the self + `connect a mind`, **never a chat that pretends to think** (the honest-degradation violation of [`surface-determinism`](surface-determinism.md)). Self present, mind not yet plugged in. The floor can be neither hidden (erosion) nor made to over-promise.
2. **Config-gated — instance-wired.** `Find an agent` (relay), `Read a page` (the computer), `Hire` (wallet + relay). Surface only when the dependency is wired. Honest by construction.
3. **Setup-affordances — when a dependency is missing.** `Connect a model`, `Connect a relay` — the honest first move for an unconfigured motebit (the path to _become more_). **Calm, not nags:** they recede once wired; a setup-affordance that persists after wiring is a noisier failure than the blank it solved.

This supersedes the bare "`Anywhere.` — one watermark word, no decorative mark" reading of empty-empty: `Anywhere.` stays as the **watermark soul** (a workstation word — "I can take you anywhere"), but it is the chrome's backdrop, not the body — the capability-seed is the body. A few soul-tinted invitations, breathing; never a launcher grid (the sci-fi-dashboard anti-pattern). Every tile routes deterministically — typed `forwardEvent` for navigation, typed panel-open CustomEvents for record surfaces (the cobrowse-chip precedent), `invokeCapability` for delegation-shaped tiles when they arrive — and NEVER a synthesized prompt ([`surface-determinism`](surface-determinism.md)); the tile-action union is promptless by construction (`HomeTileAction` carries no free-text variant).

**Spatial rehearsal.** The same home register renders as the slab-beside-the-creature on web/desktop today and as the motebit's held-Presentation home on glasses — one controller, render targets per surface ([`panel-presentation-modes`](panel-presentation-modes.md)).

**Status:** SHIPPED (2026-07-09, the home-register arc): the derived capability-seed (`deriveHomeSeed` in `apps/web/src/ui/slab-home-model.ts` — closed `HOME_CONFIG_KEYS`, per-tile `basis`, promptless action union), the de-browsered rest chrome with the `Anywhere.` watermark backdrop + honest ingress (`ask_or_go`/`go_only`), and the resumption arc over the redacted navigate record. Honesty is gate-locked by `check-home-seed-basis` (registry × live-accessor coupling × recede tests × single-producer scan).

**Disclosure (operator-transparency register).** Resumption tiles fetch favicons from `icons.duckduckgo.com` — the one third-party read the resting face performs, disclosing the (path-redacted) visited hosts to that service on mount. A cache/proxy is deferred-with-trigger: first privacy review of the resting face, or a user report.

## Rings-aware duplication

The slab's **renderer** is Ring 3 (3D creature / scene; requires WebGL, on-screen creature, wide-enough viewport). Chat is **Ring 1** (text always available).

- **Rich experience** lives on the slab. One rich rendering.
- **Minimal textual echo** in chat — a one-line status with a checkmark — acceptable for accessibility, voice, or Ring-3-unavailable surfaces. Intentionally thin.
- **Rich in both is the failure mode.** If chat renders the full fetched page or terminal output, frames have collapsed.

## Supervised agency — the user's touch

Not a movie (user only observes). Not a remote desktop (user drives every tool). The third state: **supervised agency**. The motebit has its own momentum; the user can perturb — redirect, pin, feed perception, halt, or let go.

### Gestures (minimum viable set)

Each routes through `invokeCapability`, never through a constructed prompt (see [`surface-determinism.md`](surface-determinism.md)).

| Gesture                                     | Effect                                                                  |
| ------------------------------------------- | ----------------------------------------------------------------------- |
| Tap an item                                 | Focus — pauses dissolve timer, reveals detail in place. No modal.       |
| Long-press an item                          | Pin — converts to a scene artifact that won't dissolve.                 |
| Drag item off the slab                      | Force-detach — pinch animation runs eagerly, settles as scene artifact. |
| Drag file / URL / snippet **onto** the slab | Feed perception — the motebit now sees that.                            |
| Swipe an item away                          | Force-dissolve — ripples back into the surface.                         |
| Two-finger hold on the plane                | Halt — pauses current work; release to resume.                          |

Additions need justification: physical interactions with droplets, not chrome, routing through a typed capability.

### Affordances — droplet-native, not OS-chrome

The slab has no conventional window chrome (no stoplight buttons, titlebar, tab strip, resize grips). But a workstation needs affordances for closing items, scrolling, pinning. The doctrine draws the line at **how** the affordance is expressed:

- **Allowed** — affordances that emerge from the surface and feel like droplet interactions. A close-× that materializes as a meniscus dip on hover. A pinned state rendered as a visible tension-knot. Native scroll within a card. Plane-level scroll or deck-stack when many items rest.
- **Forbidden** — gray drop-shadow close buttons. Title bars. Tab strips. Minimize/maximize/resize grips. The moment the slab looks like a program window, the metaphor has collapsed.

Test: would the affordance feel at home on a water droplet? Ship it. On a 1990s OS chrome library? Wrong direction.

### Perception input — drop kinds and handlers

Drag-onto-slab is typed end-to-end. A drop lands as a closed-union `DropPayload` at the protocol layer (`@motebit/protocol::perception.ts`); the runtime's `feedPerception(payload)` is the single entry point; per-kind handlers stage the perception as a slab item the user sees on drop. Platform-native drop events (DOM `dataTransfer`, WebXR pinch-and-throw, share-sheet) translate into the same payload — Ring 1 contract, Ring 3 surface translation.

Categorical drop kinds (closed at the protocol layer):

| Kind         | Carries                                                       | v1 status                                                                                  |
| ------------ | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| **url**      | Hyperlink + optional source HTML frame                        | shipped — kind=`fetch`, mode=`shared_gaze`                                                 |
| **text**     | Plain or markdown text                                        | shipped — kind=`stream`, mode=`shared_gaze`                                                |
| **image**    | Raster bytes + MIME                                           | shipped — kind=`embedding`, mode=`shared_gaze` (rich preview v1.1 with vision integration) |
| **file**     | Opaque bytes + filename + MIME                                | allowlisted — defers to v1.1                                                               |
| **artifact** | Motebit-produced signed artifact (bytes + `ExecutionReceipt`) | allowlisted — defers until multi-motebit UX provides a consumer                            |

The mode is `shared_gaze` because the user is the driver, the motebit is the observer, and the source is user-fed external material (Zed-pattern). `mind` would be a category error — `mind` is interior cognition.

A future `mode-grant` kind (drag a permission token: "you may drive my desktop for this session") waits for `EmbodimentMode` to lift from `@motebit/render-engine` to `@motebit/protocol`. Registry append, not wire-format break.

**Two-level pattern.** Categorical kinds are closed (protocol commitment); per-kind handlers are open (registered via `registerDropHandler(kind, handler)`). Same `agility-as-role` pattern as `SuiteId` / `ToolMode` / `GuestRail`.

**Three drop targets, three governance scopes.** Every payload carries `target: "slab" | "creature" | "ambient"`. Not equivalent drop zones with different visual effects — meaningfully different persistence and governance:

- `slab` — turn/session-scoped perception. Classifier inspects payload; `tier-bounded-by-source` per `shared_gaze`. v1 surfaces default here.
- `creature` — identity-adjacent state mutation (memory graph, trust graph, capability bindings, persona). Persistent across sessions. **Requires explicit confirmation / signed user intent.** Closer to changing the agent's body than feeding task context. Per-target governance UX must ship before the gesture does.
- `ambient` — workspace-scoped reference with source-consent + expiration. **Invariant: consultable context, not automatic prompt context.** The motebit reaches for them when a turn calls for it; ambient drops never auto-fill the prompt.

v1 surfaces only set `slab`. Dimensionality is not the gate; governance is. `feedPerception` fails closed on `target: "creature"` and `target: "ambient"` until their consumers exist — naming the missing consumer in the error.

**Attestation of intentional delivery, not content authenticity.** Each `DropPayload` carries a `UserActionAttestation`. The gesture proves the user meant to deliver; it does NOT prove the payload is unforged. Authenticity comes from separate provenance: source URL the runtime fetched, signature on bytes, `ExecutionReceipt` carried with artifact, content hash from trusted source.

**Effective sensitivity composes session × tier-bounded modes.** The runtime's `getEffectiveSessionSensitivity` reads slab items in `tier-bounded-by-source` modes (`shared_gaze`, `virtual_browser`, `peer_viewport` — user-fed) AND `tier-bounded-by-tool` modes (`tool_result` — tool-fed). The thesis claim "medical/financial/secret never reach external AI" structurally covers five egress boundaries: session-elevated state, drops, classified tool outputs, memory-write candidates, conversation-message persistence. `all-tiers` modes (`mind`, `desktop_drive`) don't contribute. The conversation-message boundary is closed both sides: the write-side floor stamps each persisted message at `max(default, effective)` for cross-device sync; the read-side filter in `ConversationManager.trimmed()` excludes any message tagged above the current effective tier. Filter is dynamic — elevation regains access; None excludes Secret. Untagged legacy messages flow through unchanged.

Drift gate `check-drop-handlers` (#77) enforces: every `DropPayloadKind` has a registered handler or an explicit allowlist entry, AND every per-surface drop handler routes through `runtime.feedPerception`.

### What the user's touch is NOT

- **Not a kill switch.** Halt is a pause; killing the motebit happens at the identity layer.
- **Not a tool driver.** The user does not steer individual tool calls from the slab. Affordances for the user's own actions live on the creature or in panels.
- **Not a chat input.** Feeding perception is not a message; it adds context the motebit perceives without entering the conversational turn.

### Failure modes specific to supervised agency

- **Drift toward movie.** Rich rendering without gestures. Every per-kind renderer needs `tap` (focus) + a dismiss path before it counts as shipped.
- **Drift toward remote desktop.** Affordances that let the user drive the motebit's tools from the slab — "run tool X," "re-run this with different args." Dismissing / pinning / feeding perception is fine; steering individual tool invocations is not.
- **Conventional window chrome.** See "Affordances" above.
- **Prompt-backdoor gestures.** A drag-to-feed that secretly appends text to the next user message. Perception is not a message.

## Embodiment modes

A motebit perceives through many embodiments. The Motebit Computer is **the single liquescent surface where whatever embodiment is currently occupied is rendered live**, governed by what the user has granted. This is the load-bearing distinction from the market — Operator picks `virtual_browser`, Cowork picks `desktop_drive`, nobody unifies. The slab does.

### The spectrum

| Mode                | What the motebit sees / does                                                         | Governance gate                                                    |
| ------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| **mind**            | Its own memory / reasoning surfacing; internal state reorganizing.                   | Always permitted — interior.                                       |
| **tool_result**     | Cleaned output from a sandboxed tool call.                                           | Turn-scoped; implicit by invocation. Thinnest embodiment.          |
| **virtual_browser** | An isolated browser viewport the motebit is navigating; user watches.                | Session-scoped consent. Revocable; needs explicit pin to persist.  |
| **shared_gaze**     | A source the user and motebit both look at (Zed-pattern): user's tab, motebit reads. | Per-source consent. User points the motebit at something.          |
| **desktop_drive**   | The motebit acts on the user's real desktop (Cowork shape).                          | Explicit, revocable grant. Highest agency. Halt always in reach.   |
| **peer_viewport**   | Looking through a peer motebit's work via federation; signed delegation returning.   | Signed delegation + trust graph. Peer identity visible on arrival. |

Every slab item carries a mode. Most tool calls default to `tool_result`; memory surfacing defaults to `mind`; delegation to `peer_viewport`. The runtime can override per item (a `read_url` shipping with a real embedded page upgrades from `tool_result` to `virtual_browser`).

**v1 implementation status (2026-05-08):** all six modes have shipped v1 cuts; v1.1 / v1.2 / v1.5 refinements have landed since. `mind` / `tool_result` are automatic via runtime's built-in slab emission. `desktop_drive` ships on desktop via the Tauri Rust bridge (`apps/desktop/src-tauri/src/computer_use.rs` — `xcap` + `enigo` + macOS Vision OCR). `shared_gaze` ships across all surfaces via the drag-drop perception substrate. `virtual_browser` v1 is `CloudBrowserDispatcher` in `@motebit/runtime` talking to Playwright at `services/browser-sandbox`. Session-scoped consent + per-action approval for irreversible clicks (Submit / Buy / Pay / File / Send / Permanently delete / I agree / Authorize / Upload — `@motebit/policy-invariants`). `peer_viewport` v1 stamps the mode at `delegation_start`, renders `delegation_receipts[]` as per-hop rows with signed-checkmark indicators (✓ / —), fills in-flight body with `Waiting for $peer…`. **Shipped post-v1:** v1.1 per-dispatcher mode stamping + `normalizeEmbodimentMode` + `check-computer-dispatcher-modes` (#79); v1.2 `ComputerSessionManager.halt/resume/isHalted` (spec §3.3); v1.2b two-finger-hold + `/halt` / `/resume` slash commands; v1.5 `ComputerSessionReceipt` (every session crystallizes at close into one signed artifact under `motebit-jcs-ed25519-b64-v1`). **Still deferred to v1.5+:** promote `motebit/computer-use@1.0` from `@alpha` to `@beta`; HA badge / trust-score live composition / bead-arrival animation on `peer_viewport` cards.

### Mode contract — six declarations per mode

Naming each invariant explicitly turns the spectrum from prose into an enforceable contract. A future mode addition must answer each field; a drift gate over slab mode tagging asserts consumers honor the declared boundaries. Same shape as [`agility-as-role`](agility-as-role.md).

**Agency** — who drives, who watches, what surface is in scope:

| Mode                | Driver                              | Observer                         | Source                                                               |
| ------------------- | ----------------------------------- | -------------------------------- | -------------------------------------------------------------------- |
| **mind**            | motebit (self)                      | motebit (self)                   | interior — memory, reasoning, state                                  |
| **tool_result**     | motebit (via AI loop or capability) | user                             | sandboxed tool call output                                           |
| **virtual_browser** | motebit                             | user                             | isolated browser viewport                                            |
| **shared_gaze**     | user                                | motebit                          | user-selected (browser tab / desktop / editor / file / video / call) |
| **desktop_drive**   | motebit                             | user                             | real OS / desktop                                                    |
| **peer_viewport**   | peer agent                          | motebit (and user, transitively) | peer's federated work — a signed delegation receipt                  |

**Governance + lifecycle** — what gates entry, which sensitivity tiers, how items end:

| Mode                | Consent / proof boundary                                                                  | Sensitivity routing                                                                                           | Lifecycle defaults                                                    |
| ------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| **mind**            | always permitted (interior)                                                               | all tiers — interior is sovereign-tier by definition                                                          | dissolve (memory that fades) → detach (formed / promoted memory)      |
| **tool_result**     | turn-scoped; per-tool `PolicyGate`                                                        | tier-bounded by tool + session sensitivity                                                                    | rest (default) → dissolve (ephemeral plumbing)                        |
| **virtual_browser** | session-scoped consent + per-action policy                                                | bounded by what motebit navigates to                                                                          | rest (in-flight) → detach (captured page artifact)                    |
| **shared_gaze**     | per-source consent (re-fires on source change)                                            | IN-direction routing — observed content inherits dissolution pressure of actively-stored content of that tier | rest (source the user is on) → detach (snapshot) → dissolve (glanced) |
| **desktop_drive**   | explicit grant + per-action approval (`classifyComputerAction` gates sensitive typing)    | all tiers; secret / financial typing fires `require_approval`                                                 | rest (sequence in view) → detach (completed workflow receipt)         |
| **peer_viewport**   | signed delegation + trust graph (the receipt **is** the proof — no live consent re-fires) | bounded by federation peer's policy + composed trust score                                                    | rest (delegation in flight) → detach (signed `ExecutionReceipt`)      |

A new embodiment-mode addition fails review if any of the six is unanswered.

### Mode × end state matrix

Modes and end states are orthogonal. Any mode can land in any end state. Defaults:

|                     | dissolve (ephemeral) | rest (working material)     | detach (graduate)           |
| ------------------- | -------------------- | --------------------------- | --------------------------- |
| **mind**            | memory that fades    | pinned reasoning            | formed / promoted memory    |
| **tool_result**     | plumbing call        | fetched page, shell output  | receipt-bearing tool result |
| **virtual_browser** | failed session       | in-flight research tabs     | captured page artifact      |
| **shared_gaze**     | glanced, moved on    | source the user is on       | screenshot / snapshot       |
| **desktop_drive**   | aborted action       | sequence of actions in view | completed workflow receipt  |
| **peer_viewport**   | unsigned reply       | delegation in flight        | signed ExecutionReceipt     |

The default for most items is `rest`. Detach is reserved for genuinely durable outputs.

### Governance as first-class

Under polymorphic embodiment, the user's supervised agency extends from per-item dismiss/pin to per-mode grant/revoke:

- **Granting a mode** — the user opens a new embodiment ("you may drive my desktop for this session"). Before the grant, items of that mode cannot appear.
- **Revoking a mode** — active items of that mode dissolve; new items don't emerge until reinstated.
- **Mode visibility** — granted modes light a small meniscus marker on the plane's edge; revoked modes are dark.

Governance gates live in the runtime, not the renderer. The slab renders the consequence (what's permitted is what appears), never the mechanism.

### Failure modes specific to modes

- **Collapsing modes into one.** Treating every slab item as `tool_result` — the prior poverty. Mode makes the spectrum first-class.
- **Mode without governance.** Adding `desktop_drive` or `virtual_browser` without grant/revoke gates.
- **Mode mixed into kind.** Don't rename `fetch` to `virtual_browser_fetch`. Kind is fine-grained content shape; mode is coarse-grained embodiment.
- **Governance as chrome.** Granted modes show as meniscus marker / plane-color wash, not as a settings panel bolted to the edge.
- **`peer_viewport` rendered as live perception.** `shared_gaze` is live perception (user-pointed, no signature). `peer_viewport` is verifiable evidence (delegation receipt IS the proof). Rendering `peer_viewport` as a streaming feed loses the cryptographic distinction. Should render as signed-evidence shape — sealed satellite, verified scroll, artifact whose hue tracks chain-verification state.

## Three end states — dissolve, rest, detach

| End state    | What it means                                                                                               | Examples                                                                                               |
| ------------ | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| **Dissolve** | Ephemeral plumbing; work done, nothing to keep. Ripples back into the slab surface, ~300ms.                 | Embedding / inference returning a vector; memory touched in transit; failed-uninformatively tool call. |
| **Rest**     | Working material; content still load-bearing in the session. Stays on the slab, available, until dismissed. | Fetched page; terminal output still in use; turn's streamed response; open "tab."                      |
| **Detach**   | Graduation; output is a finished, portable piece the user may want to keep separate. Pinches to scene.      | Signed `ExecutionReceipt`; formed/promoted memory; finalized artifact the user accepted.               |

The default for most tool calls is **rest**, not dissolve. A workstation's natural state is work piling up, being consulted, being dismissed by the user — not auto-dissolving seconds after arriving.

### What ends rest

- User dismisses (swipe, hover-close, gesture).
- Motebit explicitly closes ("done with this source") — runtime signal.
- Turn's broader context ends (fresh unrelated thread; rest items dissolve after ~10–30s grace).
- FIFO pressure on the oldest least-touched item (motebit or user can pin to exempt).

Items leaving rest use the same physics (soft outline fade, brief ripple). Dissolution is the mechanism; rest is the prior life.

### Session end

The motebit going idle does NOT empty the slab. A workstation with open tabs doesn't disappear when you stop typing. The slab auto-hides (§Dismissal) only when it holds NO items — neither active nor resting.

## Lifecycle

Four transitions, each rooted in droplet physics (not CSS easing):

- **Emergence (~400ms)** — small liquescent droplet forms at the slab's anchor and expands into a plane. Inverse of a droplet collapsing: sphere relaxes into oblate disk. Size + opacity co-animate.
- **Settling into rest (~200ms)** — card's edges soften, internal warmth eases, shadow deepens. Held, not in motion. Position and content retained.
- **Dissolution (~300ms)** — outline softens, content fades inward, slab surface briefly ripples at the dissolution site. No artifact spawned.
- **Detachment / pinch (~600–800ms)** — surface dimples upward at the item's center as internal pressure rises. Dimple grows into a bead under surface tension. Bead separates with a brief tendril that snaps (Rayleigh–Plateau instability — same physics as the creature's breathing). Detached bead takes its artifact-appropriate shape mid-flight and continues outward. Slab ripples back to flat with small residual oscillation. Eased on tension-release curves, not generic `ease-out`.
- **Dismissal** — when the slab holds no items at all, it fades away completely. Empty plane next to creature dilutes the icon and breaks calm-software thesis: absence is the most honest empty state. Re-materializes with full emergence when the next item arrives.

## Ambient states

| State      | Visual                                                             | When                                                                               |
| ---------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| **absent** | no plane; creature droplet alone                                   | no items of any kind, user has not held the plane open                             |
| **active** | internal warmth matched to soul color; items visible through glass | at least one active or resting item; work in progress OR work resting as reference |

Absent is not a bug. Do not fill it with ghost planes, skeleton loaders, typing dots, progress bars, or "thinking…" strings. The active state covers both currently-working (emerging / active items) and workstation-holding-material (resting items). The slab does not go absent just because no tool is running; it goes absent when the workstation is empty.

**User-held visibility (orthogonal).** The user can pull the empty plane into view to drag perception in, to inspect where items will land, to have the computer "open and ready." Bindings: Option+C / `/computer` slash command. User-held visibility is a hold, not a kill switch — when there are items, the plane is visible regardless; the hold only matters in the empty case.

## Visual properties (binding)

| Property              | Value                                                                                                                                                                                         | Reason                                                                                                             |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Material              | Liquescent (same family as the creature; optics borrow from Apple's Liquid Glass design language + glass-physics IOR derivation)                                                              | One body, one material. Both creature and slab are liquescent; "glass" is the optical reference, not the ontology. |
| Aspect ratio          | golden-ratio (φ ≈ 1.618:1) — `GOLDEN_RATIO` from `@motebit/render-engine`                                                                                                                     | Held-tablet feel, not wall-monitor. Local default for body-adjacent display surfaces.                              |
| Tilt                  | ~10–15° forward (toward camera), ~5° yaw toward the motebit                                                                                                                                   | Gaze axis. Makes the creature's attention legible.                                                                 |
| Edges                 | meniscus (rounded surface-tension curve) — no frame, no border, no corner radius                                                                                                              | Droplet family. The moment it has corners, it stops being a droplet.                                               |
| Breathing             | ~0.3 Hz sympathetic with the creature, amplitude ~30% of creature amplitude                                                                                                                   | One body, one respiratory rhythm. The slab inherits, not imitates.                                                 |
| Tint (always)         | derived from current soul color, on `attenuationColor`; carried at idle and during work                                                                                                       | Body coherence: the slab is an organ of the motebit.                                                               |
| Glow (variable)       | soul color on `emissive`; faint baseline at idle, brightening with `activeWarmth`                                                                                                             | Activity is visible as light. Peak intentionally gentle so the slab never outshines the creature.                  |
| Items on slab surface | ~1mm forward depth; subtle Fresnel on edges                                                                                                                                                   | Cards feel lifted, not painted.                                                                                    |
| Chrome material       | Inherits the slab's substrate — same material, same tint, same breathing. Chrome is NOT a separate object floating above the slab; it is the slab's edge region with affordances embedded.    | One material throughout. URL input + nav glyphs are slab-resident, not pill-shaped overlays.                       |
| Chrome affordances    | Tinted glyphs, borderless (back / forward / reload as SF-Symbol-shape icons). Framed cells with their own corner radius and border are forbidden — they read as web-form UI, not slab-native. | Apple HIG pattern for ornament-style chrome.                                                                       |
| Content inset         | Webview / content surface inset ~16pt from the slab's edge so the meniscus breathes                                                                                                           | Content abutting the rounded edge gets clipped and visually fights the slab silhouette.                            |
| Empty register        | The URL input itself is the empty state — centered placeholder `"type a URL · or ask motebit"`, breathing at the slab's 30% amplitude. No second empty indicator.                             | The chrome IS the affordance. Two ready signals competing is a violation.                                          |

## Failure modes to avoid

- **Third-person logging disguised as experience.** A card that says `fetch → status: calling` is a log line. The Motebit Computer renders the page being fetched, not the act described. If a card reads like a CloudWatch stream, the metaphor has collapsed.
- **Rich-duplicating chat.** Chat and slab both rendering the full content of an act. Chat may carry a one-line textual echo; it must not replicate the slab's rich content.
- **Drift toward movie or remote desktop.** See "Supervised agency."
- **Conventional window chrome.** See "Affordances — droplet-native."
- **Two competing materials.** A URL bar that's an opaque white pill floating above a translucent slab fractures the surface into two objects. One material throughout — chrome and content share the slab's substrate.
- **Everything-dissolves mindset.** Treating finishing as either-dissolve-or-detach. A workstation's natural state is work piling up, being consulted, being dismissed — most tool calls end in **rest**.
- **Everything-detaches mindset.** Graduating every finished tool call to a scene artifact fills the scene with crates and empties the workstation. Detach is for graduates only.
- **Uncoordinated emergence.** Slab and the first item fighting for attention. Sequence: slab emerges, pauses briefly (~150ms), first item pops. Never concurrent.
- **CSS-transform detachment.** `translate3d` sliding an item off the slab while the slab surface stays rigid. That's animation, not physics. Dimple, bead, release.
- **Idle-state chatter.** Skeleton loaders, "thinking…" text, persistent progress bars in idle. Kill on sight.
- **Per-surface divergence.** Three surfaces shipping three slabs whose detachment physics subtly differ. The slab's contract is Ring 1 (controller, lifecycle types, embodiment-mode semantics — identical everywhere); the renderer is Ring 3 (requires WebGL). Surfaces with the renderer obey the same physics; surfaces without it fall back to the Ring-1 chat echo, never to a divergent slab.

## Creature-slab relationship — fork (a) shipped by construction

Earlier doctrine named this an open decision between (a) **attached organ** (slab perched on the creature's lower-rim, shares shadow and breath, reads as the body's extended perceptual field) and (b) **invoked-only** (chrome is creature-less, Siri-orb pattern). Grepping the code on 2026-05-11 found fork (a) is **already shipped by construction**, and the doctrine prose had simply not caught up.

The construction:

- **Parented in the scene graph.** `SlabManager` constructor adds `this.group` to `creatureGroup` (slab.ts:432), not to the scene root. The slab inherits every transform applied to the creature group — position drift, buoyancy bob, gravity sag, curiosity tilt — automatically.
- **Overlap by construction.** With `SLAB_OFFSET_X = 0.38m`, `SLAB_WIDTH = 0.54m`, `BODY_R = 0.14m`, the slab's left edge sits at `x = 0.11m` while the creature's right edge sits at `x = 0.14m`. The two silhouettes overlap by **3 cm on the X axis**; with `SLAB_OFFSET_Z = -0.02m`, the slab is slightly behind the creature, so the body's sphere intrudes into the slab's silhouette from the front camera.
- **Sympathetic breath.** Creature and slab both compute breath as `sin(t · 0.3 · 2π)` damped on the negative half — identical formula, identical frequency, shared `t`. Slab amplitude is the doctrine-pinned 30% of creature amplitude (`SLAB_BREATHE_AMPLITUDE_FACTOR = 0.3`, derived from Rayleigh eigenmode at body scale per `liquescentia-as-substrate.md` §V.2). Inflation phases lock without inter-object signaling.
- **Shared body coherence.** Soul tint flows through `attenuationColor` on both creature body material and slab front pane + silhouette companion. Soul glow flows through `emissive`. One body, one identity, two organs.

The visible register: the creature's round body silhouette cuts a curved bite out of the slab's rectangular silhouette. **An emergent property** — no offset was chosen for that effect; it falls out of `SLAB_OFFSET_X = 0.38m` + `BODY_R = 0.14m` + `SLAB_WIDTH = 0.54m`. The silhouette is iconic, and bears a recognized resemblance to a registered trademark (Apple, Inc.'s 1977 Rob Janoff mark) which carries 50 years of public meaning. **Ratify-or-soften is deferred** until trademark counsel weighs in:

- **Ratify** — pin the offsets as load-bearing, document the bite as the canonical motebit silhouette, the soul-droplet consuming / opening its workstation. Iconic; invites trade-dress comparison.
- **Soften** — increase `SLAB_OFFSET_X` to ~0.42m so the silhouettes touch without overlapping. Loses the iconography, avoids the comparison.
- **Hold** — today's position. Document the emergence in doctrine (this section), don't pin or churn, decide later.

Today the doctrine is at **hold**. The constants are not yet declared load-bearing; an unrelated refactor that nudged them would silently change the silhouette character. A future doctrine pass that decides ratify-or-soften should also add a doctrine binding (or its absence) to the three load-bearing constants.

Fork (b) — invoked-only — remains a future-thinkable but is **not** an active alternative today; the body-coherence work in `liquescentia-as-substrate.md` and the soul-coupling in slab.ts pull strongly toward fork (a)'s "one body, two organs" reading.

## Architectural shape

Same shape applies to every layer.

- **`@motebit/render-engine`** (Layer 2, BSL) — types + adapter + renderer. Declares `SlabItemKind`, `SlabItemPhase` (with detach-pinch as a typed phase), `EmbodimentMode`, `SlabItemSpec`, `SlabItemHandle` alongside `RenderAdapter` slab methods (`addSlabItem`, `dissolveSlabItem`, `detachSlabItemAsArtifact`, `clearSlabItems`, `setSlabVisible`, `toggleSlabVisible`) and the Three.js `SlabManager`. **Future:** split protocol-shape members up to `@motebit/protocol` (Layer 0, Apache-2.0) so third-party motebit implementers can target them without depending on the renderer; deferred until the contract has at least one external consumer.
- **`@motebit/runtime`** (Layer 4, BSL) — controller + bridge. `SlabController` translates LLM turns, tool calls, plan steps, delegations into `openItem` / `updateItem` / `restItem` / `endItem` / `dismissItem`. Surfaces subscribe via `bindSlabControllerToRenderer`.
- **Per-surface renderers** (Layer 5) — wiring. Each surface wires a `RenderAdapter` slab implementation to its scene graph. Web + desktop today use Three.js with mostly-mirrored per-kind HTML renderers in `slab-items.ts`. **Honest divergence**: web has cobrowse extensions (live-browser screencast + input capture) that desktop does not, so the two files differ by ~260 lines as of 2026-05-11; the rendering of every per-kind item (`stream`, `tool_call`, `plan_step`, `shell`, `fetch`, `embedding`, `delegation`, `memory`) is mirrored. Sibling-boundary discipline applies: changes to a shared kind MUST land on both. Three consumers (web + desktop + spatial slab-as-held-tablet) is the extraction trigger, per the panels-pattern doctrine. Spatial (WebXR held-tablet) and mobile (WebView-hosted) follow.

One type surface, one event stream, multiple renderers — see [`panels-pattern.md`](panels-pattern.md). Contract is Ring 1; renderer is Ring 3.

### Compositing — content vs chrome split

The slab is **one coherent surface, multiple specialized compositing layers, zero unnecessary abstraction**. On the open web, the split is forced by the platform — there is no Metal-equivalent OS compositor — and resolves as:

| Layer                                                            | Tech                                                                       | Why                                                                                                                                                                                                                                                                                                                                            |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Slab plane geometry                                              | Three.js WebGL                                                             | 3D scene primitive: meniscus + sympathetic breathing + depth-shared with the creature.                                                                                                                                                                                                                                                         |
| Browser content frames (screencast)                              | WebGL texture on the slab's screen-mesh, inside the volume                 | Silhouette clipping by the meniscus geometry, shared depth buffer with the creature (no off-axis through-punch), refraction through the front pane's transmission. CSS3D `<img>` was the prior path; its three structural failures (flat rectangle, no shared depth, no refraction) are why the migration happened on 2026-05-09 (`8fef57e9`). |
| Interactive chrome — URL input, nav glyphs, slab item HTML cards | CSS3D DOM inside `stageEl`                                                 | Native text input, caret, IME, focus, accessibility, right-click, keyboard shortcuts. Re-rendering these as WebGL would mean rebuilding the OS interaction primitives from scratch — the wrong trade.                                                                                                                                          |
| Input-capture geometry                                           | Invisible HTML `<img>` (`opacity: 0`) at the screencast's logical position | `getBoundingClientRect()` math for click → Chromium logical-pixel coord translation. Visual register is the WebGL texture; capture register is the DOM rect. Both move together because the live_browser shell positions them together.                                                                                                        |

The split disappears on AR-glasses surfaces, where native compositing (RealityKit / Metal / equivalent) handles both pipelines under one OS-level layer. On the web, the split is the right Apple-spirit compromise. Apple's pattern, translated: _rasterized content as a material surface; interactive controls as native-feeling UI._

**The pixels-vs-truth invariant.** The screencast is presentation only. Actions never route through pixel coordinates — they route through typed semantic primitives (`navigate`, `click_element`, `type_into`, `key`, `keypress`, `paste`, `scroll`) on `ComputerSessionManager.forwardUserInput`. Pixel-coord input on the WebGL texture is structurally impossible; the typed-truth-perception doctrine + `check-affordance-routing` gate (#28) enforce. The frame is what the page looks like; the AX tree + typed actions are what it means.

**Future renderer promotion.** The renderer promotes from WebGL to WebGPU — same scene graph, swap at the `RenderAdapter` seam, same physics. Three.js's `WebGPURenderer` ships with TSL auto-fallback, so the migration carries no parallel-maintenance tax. Three triggers (AR-glasses platform alignment, compute-shader requirement, voluntary endgame) can fire it on their own merits — see [`liquescentia-as-substrate.md`](liquescentia-as-substrate.md) §"AR glasses" for the full pin.

### Inscribed-rectangle body — the slab-shape vs rectangular-content resolution

The slab has a 16% corner radius (5× Apple visionOS's typical 3% window radius). Rendering rectangular web content inside a heavily-rounded silhouette creates structural tension: page corners get clipped at the slab's rounded corners, or the body mesh competes with the silhouette by rounding its own corners.

Motebit resolves this via the **iOS / visionOS inscribed-rectangle pattern**: the body mesh is a plain rectangle inscribed inside the slab's safe area, with consistent glass margins on all four sides. The slab's rounded corners become explicitly visible glass framing the content, not a competing border on the content itself. Same shape as iPhone's notch and Dynamic Island — content lives in the safe rectangle; the device's curve is visible character around it.

Implementation in `packages/render-engine/src/slab.ts`:

```
INSCRIBED_INSET_WORLD = SLAB_CORNER_RADIUS × (1 − 1/√2)  ≈ 25pt
BODY_TOP_INSET_WORLD  = 10pt   (visible breathing between chrome strip and body)

SCREEN_MESH_WIDTH  = SLAB_WIDTH − 2 × inscribed_inset
SCREEN_MESH_HEIGHT = body_region_height − inscribed_inset − top_inset
SCREEN_MESH_CENTER_Y = body_center + (inscribed_inset − top_inset)/2
```

The body mesh's geometry is a plain `THREE.PlaneGeometry` — no rounded corners. The rounded character of the slab is supplied by the silhouette around the mesh, never by the mesh competing with the silhouette. The "rounded card inside rounded slab" pattern (commit `be02845c`) was structurally reversed on 2026-05-11 in favor of "rectangular content inside rounded frame," which is the visionOS-Safari-adapted-for-motebit pattern.

### Capture-pipeline end-game — JPEG-over-WebSocket → WebCodecs + GPUExternalTexture

Today's screencast pipeline emits JPEG-base64 frames from Playwright's CDP at every-other-frame, 60% quality. Client-side: `<img>.decode()` → `HTMLImageElement` → `texSubImage2D` to the WebGL screen-mesh texture. This is **deliberate v1 — bandwidth + JPEG-encode CPU vs frame fidelity** — and the architecture has a clear end-game:

| Stage    | Wire format                       | Decode path                             | GPU upload path                                                                                              |
| -------- | --------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Today    | JPEG-base64 over WebSocket        | `<img>.decode()` → `HTMLImageElement`   | `texSubImage2D` (WebGL) / `copyExternalImageToTexture` (WebGPU) — both incur a copy from decoded RGBA to GPU |
| End-game | H.264 / VP9 / AV1 streaming codec | WebCodecs `VideoDecoder` → `VideoFrame` | `GPUDevice.importExternalTexture()` — **zero-copy YUV sampled directly in the fragment shader**              |

The end-game's load-bearing capability is `importExternalTexture` reading the GPU-decoded video frame's YUV planes directly, eliminating the JPEG-decode + RGBA-upload round-trip. For a 60fps slab at higher resolutions, this is the difference between a frame-upload stall and free.

Three caveats survive the research:

- **External texture lifetime is per-task.** `GPUExternalTexture` is destroyed as a microtask after each render — re-import every frame, rebuild the bindgroup every frame. Three.js's WebGPURenderer handles this internally for `VideoTexture`; raw WebGPU code must bake it into the render loop.
- **Source swaps need explicit dispose.** Three.js issue #29925: changing `<video>` source mid-render crashes the WebGPURenderer when the old external texture is released. Pattern: `texture.dispose()` and create a new `VideoTexture` rather than reassigning `video.src`.
- **`texture.colorSpace = THREE.SRGBColorSpace`** on the `VideoTexture` under WebGPURenderer or the page renders washed out.

Triggers — independent from the renderer migration:

1. **Measured throughput or thermal ceiling** — desktop telemetry shows frame-upload jank correlating with page complexity or screencast resolution; **on mobile (iOS / iPadOS sustained sessions on battery), the symptom flips to warm chassis + faster battery drain before frame jank appears** because iOS will throttle CPU frequency to hold FPS, hiding the throughput signal while the thermal/power cost stays real. Same root cause (JPEG decode + RGBA upload as the hot path), different observability surface. Hardware-decoded H.264/VP9 through `importExternalTexture` routes through Apple's dedicated media engine — materially cheaper per frame than the JPEG path on battery-budgeted runtime.
2. **Higher fidelity required** — operator-grade browsing where 60% JPEG is no longer acceptable (multi-stream surfaces, peer_viewport screencasts, demo-quality recording).
3. **Multi-stream futures** — when several screencasts compose on one slab (federated peer_viewport overlays, comparison views), per-stream decode CPU at JPEG rates blows past the budget.

The renderer migration and the capture-pipeline migration **must not be conflated**. The renderer migration is a small swap at the `RenderAdapter` seam. The pipeline migration is a substantial rewrite spanning `services/browser-sandbox` (encoder), the wire format (`ScreencastFrame` discriminated union — JPEG-base64 OR codec stream), and the client decode + texture path. Each has its own trigger; each ships independently.

## Relationship to other scene primitives

| Primitive     | Role                                | Relationship to slab                                                                                                                                                                             |
| ------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Creature      | identity, mood, attention           | The source. Slab work originates from the creature's current activity. Slab tilts toward the creature; breathing is sympathetic.                                                                 |
| Chat bubble   | user ↔ motebit conversational turns | Parallel, different frames. Chat is second-person; slab is first-person. Chat may carry a minimal textual echo for accessibility. Rich-duplication is the failure mode.                          |
| Artifact      | durable, detached output            | Downstream. Artifacts graduate off the slab via the detachment pinch.                                                                                                                            |
| Constellation | cluster of related records          | Above. When slab activity touches a domain with an associated constellation (credentials during auth, agents during delegation), the constellation materializes above the slab for the duration. |
| Panel         | record surface, user-summoned       | Orthogonal. Panels hold what the motebit HAS; the slab shows what the motebit is DOING. Never duplicate data between them.                                                                       |

## Doctrine check before any slab PR

1. **First-person experience or third-person label?** Status strings ("calling…"), event names ("fetch", "tool_call"), and log-shaped cards are labels. The slab renders what the motebit sees, does, and thinks, in the modality that belongs to.
2. **Act or record?** Records live in panels, not on the slab.
3. **Does chat already render this richly?** A one-line textual echo is fine; a full reproduction is the collapse. Trim chat back to a one-liner if it grew.
4. **Which embodiment mode?** `mind` / `tool_result` / `virtual_browser` / `shared_gaze` / `desktop_drive` / `peer_viewport`. Most items default from their kind; higher-agency modes need explicit governance grants. If you're unsure, you're probably flattening into `tool_result`.
5. **Which end state?** `dissolve` (ephemeral, nothing to keep), `rest` (working material), or `detach` (graduate). Default for most tool calls is `rest`. Explicitly choose; don't leave it to implicit policy.
6. **Survives the absent test?** Would the plane going absent break the item's semantics? Active says no, resting says yes, records-in-disguise say yes — if yes for a reason other than rest, it's probably a panel record.
7. **Droplet physics?** Emergence as meniscus-expansion, dissolution as surface-ripple-absorption, detachment as bead-tension-release. CSS easing leaks the metaphor.
8. **Identical across surfaces?** Per-surface specialization is either a renderer detail (fine) or a capability split (needs justification per capability-rings).
9. **Minimum gesture set?** Tap (focus) + swipe (dismiss) at least. A kind with rich rendering but no user touch drifts toward movie.

## References

- [`intent-gated-slab.md`](intent-gated-slab.md) — when the slab is rendered and what's load-bearing about its instantiation.
- [`records-vs-acts.md`](records-vs-acts.md) — the substrate categorization.
- [`panels-pattern.md`](panels-pattern.md) — the cross-surface controller shape extended to scene primitives.
- [`surface-determinism.md`](surface-determinism.md) — affordances triggering slab work must be deterministic.
- [`spatial-as-endgame.md`](spatial-as-endgame.md) — the slab in spatial is a held-tablet the motebit presents to you, anchored to its gesture. Ring 1 contract / Ring 3 renderer split lets the same lifecycle types serve desktop/web (Three.js plane) and glasses (WebXR held-tablet).
- [`liquescentia-as-substrate.md`](liquescentia-as-substrate.md) — material constants the slab inherits. Sympathetic breathing at 30% creature amplitude is the same 0.3 Hz Rayleigh oscillation.
- [`DROPLET.md`](../../DROPLET.md) — the physics the slab inherits (Rayleigh–Plateau, surface tension, eigenmode breathing).
- [`THE_ACTOR_PRINCIPLE.md`](../../THE_ACTOR_PRINCIPLE.md) — agents-to-agents shape that shows on the slab as delegation traffic.
