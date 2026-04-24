# Motebit Computer — the slab

A motebit is a droplet under surface tension. Inside the droplet, a mind — it _perceives, acts, and reflects_. Motebits travel the web, drive the desktop, delegate to peers across a global network of agents. All of that work is experience the motebit is living through. Chat is the second-person surface where you _speak to_ the motebit. The Motebit Computer is the first-person surface where you _see through its eye, watch its hand move, and glimpse its mind reorganize_. Not a log. Not a sidebar. The motebit's experience, rendered in its own frame, while it lives.

This doctrine pins what the slab is, what renders on it, how items leave it, and what it looks like when nothing is happening. Every future renderer and controller binds to this shape.

## What it is

The slab is the motebit's **perceptual field rendered as a liquid-glass plane** floating to the right of the motebit in the spatial scene. Sibling to: **constellation** (clusters of related records), **artifact** (detached, persistent outputs), **chat bubble** (ephemeral conversational messages). It is not a panel, not a window, not a HUD. It has a meniscus, not a frame; no titlebar, no close button, no scrollbar chrome.

What appears on the slab is what the motebit is **seeing, doing, and attending to** — in its own first-person frame. The motebit doesn't describe the page it's fetching; the page _appears_ on the slab as the motebit reads it. The motebit doesn't narrate its shell command; the terminal _scrolls_ on the slab as the command runs. The motebit doesn't report a memory-recall tool call; memory _surfaces_ on the slab as it becomes relevant.

- **Chat is second-person** — you ↔ motebit, words exchanged.
- **Slab is first-person** — you watching through the motebit's eye, at what it lives.

In the records-vs-acts categorization ([`records-vs-acts.md`](records-vs-acts.md)), the slab is the canonical surface for acts. But acts are not _events_ — they are lived experiences, rendered in the perceptual modality they belong to. A web fetch is not "fetch status"; it is a page being seen. A delegation is not "task_request dispatched"; it is a bead leaving the slab toward a peer and returning with a signed receipt.

## Why it exists

Three structural gaps the slab closes:

1. **No first-person surface.** Every AI UI — chat bubble, panel, sidebar, HUD, status board — is a third-person or second-person view. There was no surface where the user can see the _motebit's own perceptual field_ as it lives. A motebit that browses the web, drives the desktop, and delegates to peers needs a surface where those experiences are what you see, not summaries of them. The slab is that surface.

2. **The spatial-canvas thesis ("objects materialize in scene, not chat") needs somewhere to materialize into before they detach.** An artifact that springs from nothing is magical; an artifact that _beads off_ a working surface is physical. The slab is the working surface.

3. **Calm software needs an honest empty state.** Every other AI UI fills silence with skeleton loaders and "thinking…" text. The slab empty-but-present (refraction, meniscus, no content) proves process is not performance.

## What renders on the slab

What appears on the slab is organized into three organs of the motebit's experience.

### Eye — perception

What the motebit is _seeing_ right now. The first-person visual field.

- **Web pages** the motebit is reading render on the slab — the actual page content (or a faithful preview of it), not a URL string. If the motebit fetches a URL, the page _appears_ as it loads.
- **Search results** appear as the motebit reads them; each result is rendered as the motebit's eye moves through it.
- **Files** it opens are shown as they are — code highlighted, text rendered, images displayed.
- **Peer motebit replies** land as beads arriving from offscreen, carrying the peer's identity and the returned receipt.
- **Desktop regions** the motebit is attending to (when driving the user's desktop) render as a live fragment.

### Hand — action

What the motebit is _doing_ right now. Work in motion, not work being labeled.

- **Shell / terminal output** scrolls on the slab as commands run.
- **Forms filling** — fields populate as the motebit completes them.
- **Code being written** — the editor-like surface types as the motebit codes.
- **Files being edited** — diffs appear as the motebit applies them.
- **Delegation outbound** — a packet leaves the slab when the motebit delegates to a peer; returns as a bead with a signed receipt, the peer's identity visible on arrival.

### Mind — reflection

What the motebit is _thinking_ right now. Internal reorganization made visible.

- **Streaming tokens** of its current response — before crystallization into a chat bubble.
- **Memory surfacing** — nodes rise into attention as they become relevant to the current task; drift back down as they fall away.
- **Plan walking** — the current step focuses on the slab; prior steps recede; next steps ghost in.
- **Embedding / inference** — the moment of a thought being formed, rendered as a brief condensation on the slab.

**Not on the slab:**

- **Records** (credentials, settled receipts, memory index, balance history). Those are panel content — what the motebit _has_, not what it is doing right now.
- **Chat bubbles.** Second-person conversational moments. The slab is first-person experience. (Chat may carry a _minimal textual echo_ of an act — "reading example.com…" — for accessibility and Ring-1 fallback when the slab isn't visible. See "Rings-aware duplication" below.)
- **Third-person summaries of experience rendered as the slab's main content.** A slab card whose entire content is `fetch: calling…` is a log entry, not a perception. The slab renders what the motebit _sees_, not a label describing the fetch.
- **Constellations.** Those cluster above the slab when their domain is active, but they are their own scene object.
- **UI chrome** (buttons, menus, inputs). If the user must click something, it's an affordance and lives on the creature or in a panel, not the slab.

### Rings-aware duplication — when chat _may_ echo the slab

The slab is a **Ring 3 capability** (3D creature / scene; requires WebGL, an on-screen creature, and a wide-enough viewport). Chat is **Ring 1** (identical everywhere; text always available). A rule that says "one surface per act" would sound clean but silently regresses accessibility whenever Ring 3 isn't available — screen-reader users, voice-first users, headless browsers, and narrow viewports would lose all signal that a tool ran.

Rule of thumb:

- **Rich experience** — the page rendering, the terminal scrolling, the memory node surfacing — lives on the slab. One rich rendering, in the perceptual modality the act belongs to.
- **Minimal textual echo** — a one-line status, completed with a checkmark — may live in chat. Acceptable when it serves accessibility, voice, or Ring-3-unavailable surfaces. Kept intentionally thin so it doesn't compete with the slab for attention.
- **Rich in both** is the failure mode. If chat also renders the fetched page's full content, or the terminal's full output, or the memory node's detail — the slab isn't canonical and the frames have collapsed into each other.

## The user's touch — supervised agency

The Motebit Computer is not a movie and not a remote desktop. It is a third state: **supervised agency**. The motebit has its own momentum — it perceives, acts, reflects on its own schedule. The user can _touch_ that momentum: redirect it, pin what matters, feed it new perception, halt it, or let it go. Two agents share one surface.

Frames the doctrine rules out:

- **Movie** — the user only observes. There is no way for them to arrest, redirect, or contribute. The motebit runs on rails.
- **Remote desktop** — the user drives every tool call; the motebit has no initiative. The slab is just a viewport onto the user's own hands.

Frame the doctrine holds us to:

- **Supervised agency** — the motebit leads; the user can perturb. The slab's items have their own lifecycle (emerge, active, rest, dissolve / pinch) set by the motebit's work. The user's touch is another force that acts on that lifecycle — a second tension on the same surface.

### Affordances that emerge from the surface, not conventional window chrome

The slab has **no conventional window chrome** — no macOS stoplight buttons, no titlebar, no tab strip with drop-shadow, no resize grips. That rule holds. But a workstation holding resting items needs _some_ affordances for workstation operations: closing an item you no longer need, scrolling when work accumulates, pinning something so the FIFO pressure doesn't evict it. The doctrine draws the line at **how** the affordance is expressed, not whether:

- **Allowed** — affordances that _emerge from the surface itself_ and feel like interactions with the droplet. A close-× that materializes as a meniscus dip in the card's upper-right corner when the pointer enters; a pinned state rendered as a visible tension-knot on the card; native scroll within a card's content when it overflows; a plane-level scroll or deck-stack when many items rest. These are not chrome — they're how the surface responds to intent.
- **Forbidden** — conventional window chrome bolted on. Gray square close buttons with drop-shadows. A title bar running across the top of the plane. A tab strip with macOS-style tabs. "Minimize / maximize / resize" grips. The moment the slab starts looking like a program window, the metaphor has collapsed.

The test: if the affordance would feel at home on a water droplet or a sheet of liquid glass, ship it. If it would feel at home in a 1990s OS chrome library, it's the wrong direction.

User control primarily happens through _physical gestures on the droplets themselves_. Gestures are first-class; affordances are the desktop-native equivalent that emerges when gestures aren't natural (hover, right-click surface).

The minimum viable set of gestures (per the surface-determinism doctrine — each routes through `invokeCapability`, never through a constructed prompt):

| Gesture                                     | Effect                                                                                           |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Tap an item                                 | Focus — pauses its dissolve timer, reveals detail in place. No modal, no overlay.                |
| Long-press an item                          | Pin — converts to a scene artifact that won't dissolve on its own. The motebit can still see it. |
| Drag item off the slab                      | Force-detach — runs the pinch animation eagerly, settles as a scene artifact.                    |
| Drag a file / URL / snippet _onto_ the slab | Feed perception — the motebit now sees that; its next turn incorporates it.                      |
| Swipe an item away                          | Force-dissolve — it ripples back into the slab surface immediately.                              |
| Two-finger hold on the plane                | Halt — motebit pauses its current work; items stop their lifecycle; release to resume.           |

Additions to this set need a justification: they must be physical interactions with droplets, not chrome, and must route through a typed capability — no prompt-injection backdoor.

### What the user's touch is _not_

- **Not a kill switch.** The halt gesture is a pause, not a disconnect. Killing the motebit happens at the identity layer, not on the slab.
- **Not a tool driver.** The user does not steer individual tool calls from the slab. If the motebit chose to fetch X, the user can swipe that away or redirect the focus, but they do not directly invoke the fetch themselves from here — affordances for the user's own actions live on the creature or in panels.
- **Not a chat input.** Feeding perception via drag is not the same as sending a message; it adds context the motebit perceives, but does not enter the conversational turn.

### Failure modes specific to supervised agency

- **Drift toward movie.** Shipping rich rendering without any gestures or affordances. The slab becomes a window you can't open. Every per-kind renderer needs at least `tap` (focus) and a dismiss path (swipe or hover-close) before it counts as shipped.
- **Drift toward remote desktop.** Adding affordances that let the user _drive the motebit's tools_ from the slab — "run tool X," "re-run this call with different args," "pick which URL to fetch next." That collapses the motebit's agency into the user's. Dismissing / pinning / feeding perception is fine; steering individual tool invocations is not.
- **Conventional window chrome.** Gray drop-shadow close buttons, titlebars, tab strips with stoplight controls, OS-style resize grips. These turn the slab into a program window and break the metaphor. See "Affordances that emerge from the surface" above — droplet-native affordances are allowed; OS-native chrome is not.
- **Prompt-backdoor gestures.** A drag-to-feed that secretly appends text to the next user message. Perception is not a message; keep the two channels typed and separate.

## Embodiment modes — governance-gated perception

A motebit perceives through many embodiments, not one. The tool result is the thinnest embodiment; the others land on the same surface as the motebit grows. The Motebit Computer is **the single liquid-glass surface where whatever embodiment the motebit is currently occupying is rendered live**, governed by what the user has granted.

This is the load-bearing distinction from the market. Operator picks one cell (virtual browser). Cowork picks another (desktop drive). Nobody unifies the spectrum. The slab does.

### The spectrum

| Mode                | What the motebit sees / does                                                         | Governance gate                                                                                         |
| ------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| **mind**            | Its own memory / reasoning surfacing; internal state reorganizing.                   | Always permitted — it's the interior. No external gate.                                                 |
| **tool_result**     | Cleaned output from a sandboxed tool call (fetch text, shell output, search hits).   | Turn-scoped; implicit by invocation. The thinnest embodiment.                                           |
| **virtual_browser** | An isolated browser viewport the motebit is navigating; user watches.                | Session-scoped consent. User can revoke; motebit can't persist beyond the session without explicit pin. |
| **shared_gaze**     | A source the user and motebit both look at (Zed-pattern): user's tab, motebit reads. | Per-source consent. User points the motebit at something.                                               |
| **desktop_drive**   | The motebit acts on the user's real desktop (Claude Cowork shape).                   | Explicit, revocable grant. Highest agency. Halt gesture always in reach.                                |
| **peer_viewport**   | Looking through a peer motebit's work via federation; a signed delegation returning. | Signed delegation + trust graph. Peer identity visible on arrival.                                      |

Every slab item carries a mode. Most tool calls default to `tool_result`; memory surfacing defaults to `mind`; delegation to `peer_viewport`. The runtime can override per item (e.g., a `read_url` that ships with a real embedded page upgrades from `tool_result` to `virtual_browser`).

### Mode × end state matrix

Modes and end states are **orthogonal**. Any mode can land in any end state. Sensible defaults:

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

Under polymorphic embodiment, the user's supervised agency (see "The user's touch") extends from _per-item dismiss/pin_ to _per-mode grant/revoke_:

- **Granting a mode** — the user opens a new embodiment for the motebit (e.g., "you may drive my desktop for this session"). Before the grant, items of that mode cannot appear on the slab.
- **Revoking a mode** — the user closes an embodiment mid-session. Active items of that mode dissolve; new items of that mode won't emerge until the grant is reinstated.
- **Mode visibility** — the slab visibly reflects which modes are currently permitted. Granted modes light a small meniscus marker on the plane's edge; revoked modes are dark. (Implementation is a follow-up pass; the primitive lands first.)

Governance gates live in the runtime, not the renderer. The slab renders the _consequence_ of governance (what's permitted is what appears), never the mechanism.

### Failure modes specific to modes

- **Collapsing modes into one.** Treating every slab item as `tool_result` — the current poverty. Mode makes the spectrum first-class so embodiments can grow.
- **Mode without governance.** Adding `desktop_drive` or `virtual_browser` without the grant/revoke gate. High-agency modes without explicit consent break supervised agency.
- **Mode mixed into kind.** Don't rename `fetch` to `virtual_browser_fetch`. Kind is the fine-grained shape of the content; mode is the coarse-grained embodiment category. A `fetch` kind can be `tool_result` mode today and `virtual_browser` mode tomorrow without a protocol break.
- **Governance as chrome.** Don't show granted modes as a settings panel bolted to the slab's edge. Mode visibility emerges from the surface (a meniscus marker, a plane-color wash) — same doctrine as other affordances.

### Why this completes the doctrine

The first-person framing was right but the implementation constrained "eye" to tool output. That's the thinnest embodiment. The spectrum names what the motebit's eye can _become_ — and the Motebit Computer is the one surface where whichever embodiment is active gets rendered, with three end states, droplet physics, body-adjacency to the creature, and governance made visible.

That configuration is unclaimed by the incumbents. Operator ships `virtual_browser`. Cowork ships `desktop_drive`. Comet ships a variant of `shared_gaze`. Nobody ships all of them unified on one surface with governance, three end states, and a body-adjacent display. The slab does.

## Three end states — dissolve, rest, detach

An item that finishes its active work has three possible next states. The motebit-computer is a **workstation**, not a theater — most of what finishes on the slab doesn't graduate to the scene and doesn't vanish; it _stays on the workstation_ as working material. Picking the wrong end state for a kind makes the slab feel either like a log stream (everything dissolves, nothing persists) or like a magical factory (everything graduates into the scene).

| End state    | What it means                                                                                                                           | Examples                                                                                                                 |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| **Dissolve** | Ephemeral plumbing; the work is done _and_ there's nothing meaningful to keep. Ripples back into the slab surface, ~300ms.              | Embedding / inference call that returned a vector; memory touched in transit; a tool call that failed uninformatively.   |
| **Rest**     | Working material; the content is still load-bearing in the session. Stays on the slab, available to consult, until dismissed.           | Fetched page the motebit read; terminal output the motebit's still using; the turn's streamed response card; open "tab." |
| **Detach**   | Graduation; the output is a finished, portable piece the user may want to keep separate from the current workstation. Pinches to scene. | Signed ExecutionReceipt; a formed/promoted memory the motebit decided to commit; a finalized artifact the user accepted. |

The default for most tool calls is **rest**, not dissolve. The previous doctrine implicitly treated finishing as an either-dissolve-or-detach decision; that's wrong. A workstation's natural state is work piling up, being consulted, being dismissed by the user when done — not auto-dissolving seconds after arriving.

### What ends rest

An item leaves rest when one of:

- The user dismisses it (swipe, hover-close, or explicit gesture).
- The motebit explicitly closes it ("done with this source, moving on") — a runtime signal.
- The turn's broader context ends (user starts a fresh unrelated thread; rest items from the prior thread dissolve after a short grace window, ~10–30s).
- The slab runs out of visible room and the item is the oldest, least-touched rest item (FIFO pressure; the motebit or user can pin items to exempt them).

Dissolution still means dissolution — items leaving rest use the same physics (soft outline fade, brief ripple). Dissolution is the mechanism; rest is the prior life.

### What ends the session

The motebit going idle does **not** force the slab to empty. A workstation with open tabs doesn't disappear when you stop typing. The slab auto-hides (§Dismissal below) only when it holds _no_ items — neither active nor resting. Rest persists through the motebit's idle.

## Lifecycle

Four transitions — each one rooted in droplet physics, not CSS easing:

### Emergence

When work starts, a small glass droplet forms at the slab's anchor point and expands into a plane. The transition is the inverse of a droplet collapsing: a sphere relaxes into an oblate disk. ~400ms; size and opacity co-animate.

### Settling into rest

When an item's active work finishes and the end state is rest, the card's edges soften slightly — its internal warmth eases, its shadow deepens a touch — marking it as "held" rather than "in motion." ~200ms. The card retains its position and content; the change is purely in how it sits on the surface. Subsequent updates (a parent motebit reopening it, the user tapping to expand) can re-animate within rest without a full re-emergence.

### Dissolution

When an item dissolves — either because its end state was dissolve, or because it's leaving rest (user-dismissed, grace-window-expired, FIFO-evicted) — it **dissolves back into the slab surface**: the item's outline softens, the content fades inward, the slab's own surface briefly ripples at the dissolution site. ~300ms. No artifact is spawned.

### Detachment (the pinch)

When an item on the slab produces a durable output that should **graduate to the scene** (a completed essay, a finalized code file, a signed receipt, a formed memory), it **detaches** into its own scene object. This is the load-bearing transition; get it wrong and the metaphor collapses into a CSS transform.

The physics: the slab surface dimples upward at the item's center as internal pressure rises. The dimple grows into a bead under surface tension. The bead separates from the slab with a brief tendril that snaps (Rayleigh–Plateau instability — the same physics the creature's breathing borrows from). The detached bead takes its artifact-appropriate shape mid-flight (text card, code pane, plan scroll, receipt orb, memory mote) and continues outward into the scene. The slab's surface ripples back to flat with a small residual oscillation. ~600–800ms total, eased on tension-release curves, not on generic `ease-out`.

Droplets bead → tension → release. The slab obeys the same law as its parent body. Detachment is **not** what happens to every finished item — only the ones that have become _graduates_ of the workstation.

### Dismissal

When the slab holds no items at all — neither active nor resting — it fades away completely, clearing space so the creature droplet is the sole iconic presence in the scene. A plane sitting empty next to the creature (even subtly) dilutes that icon and breaks the calm-software thesis: absence is the most honest empty state. The plane re-materializes with full emergence physics when the next item arrives.

## Ambient states

The slab has **two** ambient states — a plane that's there because work is happening, or a plane that isn't there:

| State      | Visual                                                             | When                                                                                             |
| ---------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| **absent** | no plane; creature droplet alone in the scene                      | no items of any kind on the slab, and the user has not held the plane open                       |
| **active** | internal warmth matched to soul color; items visible through glass | at least one active or resting item on the slab; work in progress _or_ work resting as reference |

The absent state is not a bug. It is the proof that the slab respects silence — the motebit can think without performing for you, and the creature droplet doesn't have to compete with an empty screen for focus. Do not fill the absent state with a ghost plane, skeleton loaders, typing dots, progress bars, or "thinking…" strings. If the slab is absent, the slab is absent.

The **active** state covers both kinds of presence: the motebit currently working (emerging / active items), and the workstation holding material the user may still consult (resting items). The slab does not go absent just because no tool is running; it goes absent when the workstation itself is empty.

### User-held visibility (orthogonal)

The user can pull the empty plane into view on purpose — to drag perception in (future gesture), to inspect where slab items will land, to have the computer "open and ready" before giving the motebit a task. This is orthogonal to the ambient state: user-held-visible + no items = plane stays open; items arrive = stays open; user releases the hold + no items = absent.

Bindings:

- **Option+C** (desktop + web): toggle user-held visibility
- **`/computer`** slash command (desktop + web): same toggle via the command palette

User-held visibility is a hold, not a kill switch. When there are items, the plane is visible regardless; the user's hold only matters in the empty case.

## Visual properties (binding)

| Property              | Value                                                                               | Reason                                                                                                                                                                                                                                                                                    |
| --------------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Material              | Apple-Liquid-Glass (same cryst. family as the creature; same IOR derivation)        | One body, one material.                                                                                                                                                                                                                                                                   |
| Aspect ratio          | golden-ratio (φ ≈ 1.618:1) per [`design-ratios.md`](design-ratios.md)               | Held-tablet feel, not wall-monitor. The slab is the first body-adjacent display surface under that rule; direct descendants (artifact cards, constellation clusters when sized) default to φ unless a stronger governing law applies.                                                     |
| Tilt                  | ~10–15° forward (toward camera), ~5° yaw toward the motebit                         | Gaze axis. Makes the creature's attention legible.                                                                                                                                                                                                                                        |
| Edges                 | meniscus (rounded surface-tension curve), **no frame, no border, no corner radius** | Droplet family. The moment it has corners, it stops being a droplet.                                                                                                                                                                                                                      |
| Breathing             | ~0.3 Hz sympathetic with the creature, amplitude ~30% of creature amplitude         | One body, one respiratory rhythm. The slab inherits, not imitates.                                                                                                                                                                                                                        |
| Tint when active      | derived from current soul color (cyan creature → cyan slab warmth)                  | The slab is body-adjacent, not brand-adjacent.                                                                                                                                                                                                                                            |
| Tint when idle        | none; refraction only                                                               | Idle has no identity to project.                                                                                                                                                                                                                                                          |
| Items on slab surface | ~1mm forward depth; subtle Fresnel on edges                                         | Cards feel lifted, not painted.                                                                                                                                                                                                                                                           |
| Chrome                | **no conventional window chrome**; droplet-native affordances allowed               | No OS-style titlebar, stoplight buttons, tab strip, resize grips. Affordances that emerge from the surface (hover-reveal close as a meniscus dip; pinned state as a tension knot; native scroll within / between cards when work accumulates) are how the workstation responds to intent. |

## Failure modes to avoid

- **Third-person logging disguised as experience.** A card that says `fetch → status: calling` is a log line. The Motebit Computer renders _the page being fetched_, not the act of fetching described. If a card reads like a CloudWatch stream, the metaphor has collapsed. Status strings, event names, and log-shaped presentation don't belong on the slab.
- **Rich-duplicating chat.** Chat and slab both rendering the _full_ content of an act — the whole fetched page in chat AND as a slab card, the complete terminal output in both — is the collapse. Chat may carry a one-line textual echo (accessibility + Ring-1 fallback); it must not replicate the slab's rich content. If the chat rendering grows beyond a one-liner, the frames have merged.
- **Drift toward movie or remote desktop.** See "The user's touch — supervised agency." A slab with no user gestures becomes a movie; a slab with "run this tool" buttons becomes a remote desktop. Both break the third state.
- **Conventional window chrome.** OS-style titlebars, stoplight close buttons with gray drop shadows, resize grips, tab strips with program-window affordances. Turns the slab into a browser tab. Droplet-native affordances (hover-reveal meniscus close, tension-knot pin, native surface scroll) are not chrome — they're how the workstation responds to intent. See the "Affordances" subsection of "The user's touch" for the boundary.
- **Everything-dissolves mindset.** Treating every finished item as something that must either dissolve or graduate. A workstation's natural state is work resting on it — read-and-consulted pages, the turn's response, open "tabs." Rest is the third end state; most tool calls end _there_. Collapsing that to dissolve makes the slab feel like a log stream, not a computer.
- **Everything-detaches mindset.** The opposite failure — graduating every finished tool call to a scene artifact. The scene fills with crates; nothing stays on the workstation. Detach is for _graduates_ (signed receipts, committed memories, accepted artifacts), not ordinary working material.
- **Uncoordinated emergence.** The slab's emergence and the first item's emergence fighting for the user's attention. Sequence: slab emerges, pauses briefly (~150ms), first item pops. Never concurrent.
- **CSS-transform detachment.** A `translate3d` sliding an item off the slab while the slab surface stays rigid. That's not physics, that's animation. The slab must dimple, bead, release.
- **Idle-state chatter.** Skeleton loaders, "thinking…" text, or persistent progress bars in idle. Kill on sight.
- **Per-surface divergence.** Three surfaces shipping three slabs whose detachment physics subtly differ. The slab is a Ring-1 capability (identical everywhere) per the capability-rings doctrine; all three surfaces render the same types and obey the same physics.

## Architectural shape

The slab is a cross-surface scene primitive. The same shape applies to every layer:

- **`@motebit/protocol` (Layer 0, MIT).** Declares the types: item kinds, lifecycle phases (including the detach-pinch transition as a typed phase, not a private animation detail), the protocol contract any third-party motebit implementer must honor. Pure types; no implementation.
- **`@motebit/render-engine` (Layer 2, BSL).** Declares the `SlabRenderer` adapter interface alongside the existing `RenderAdapter`. Exposes `addSlabItem(spec) → handle`, `detachSlabItemAsArtifact(id, artifactSpec)`, `dissolveSlabItem(id)`. Concrete Three.js / WebGL / Canvas implementations live per-surface.
- **`@motebit/runtime` (Layer 4, BSL).** Emits slab events as a stream: the runtime's internal LLM turn, tool calls, plan steps translate to `slab.itemOpened` / `slab.itemUpdated` / `slab.itemDetached` / `slab.itemDissolved`. Surfaces subscribe. This makes the slab driveable by the same event source that drives the rest of the live state.
- **Per-surface renderers (Layer 5).** Each surface wires a `SlabRenderer` implementation to its scene graph. The web/desktop/spatial versions use Three.js; mobile uses WebView or a stand-in. All honor the same phase transitions and the same material.

One type surface, one event stream, three renderers — following the existing panels-pattern shape ([`panels-pattern.md`](panels-pattern.md)) extended to scene primitives.

## Relationship to other scene primitives

| Primitive     | Role                                | Relationship to slab                                                                                                                                                                                                                                                                                                                                                                            |
| ------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Creature      | identity, mood, attention           | The source. Slab work originates from the creature's current activity. Slab tilts toward the creature; breathing is sympathetic.                                                                                                                                                                                                                                                                |
| Chat bubble   | user ↔ motebit conversational turns | Parallel, different frames. Chat bubbles render the dialogue in second-person (you talking with the motebit); the slab renders the motebit's first-person experience of the work that dialogue triggered. Chat may carry a _minimal textual echo_ of acts for a11y and Ring-1 fallback; rich rendering stays on the slab. Rich-duplication is the failure mode (see "Rings-aware duplication"). |
| Artifact      | durable, detached output            | Downstream. Artifacts are what graduate off the slab via the detachment pinch. Before artifact, it lived on the slab.                                                                                                                                                                                                                                                                           |
| Constellation | cluster of related records          | Above. When the slab's active items touch a domain with an associated constellation (credentials during an auth tool call, agents during a delegation), the constellation materializes above the slab area for the duration of the activity.                                                                                                                                                    |
| Panel         | record surface, user-summoned       | Orthogonal. Panels hold what the motebit _has_; the slab shows what the motebit is _doing_. Never duplicate data between them.                                                                                                                                                                                                                                                                  |

## Doctrine check before any slab PR

1. Is this a **first-person perception / action / thought**, or a third-person label about one? Status strings ("calling…"), event names ("fetch", "tool*call"), and log-shaped cards are labels. The slab renders what the motebit \_sees, does, and thinks*, in the modality that belongs to. If you're rendering a noun for an experience instead of the experience itself, you're on the wrong surface.
2. Is the thing you're adding an **act** (on-slab) or a **record** (off-slab, in a panel)? If record, stop.
3. Does **chat already render this richly** as text? A one-line textual echo in chat ("reading example.com…") is acceptable as Ring-1 fallback; a full reproduction of the act's content in both places is the collapse. If chat renders more than a thin status, the frames have merged — trim chat back to a one-liner.
4. Which **embodiment mode** does the item belong to — `mind`, `tool_result`, `virtual_browser`, `shared_gaze`, `desktop_drive`, or `peer_viewport`? Most items default from their kind (tool_call → tool_result, memory → mind, delegation → peer_viewport); higher-agency modes need an explicit governance grant. If you're unsure, you're probably flattening modes into `tool_result` — the failure mode the spectrum was introduced to prevent.
5. Which of the **three end states** does the item land in when its active work finishes — dissolve (ephemeral plumbing, nothing to keep), rest (working material, stays on the workstation), or detach (graduate, pinches to scene)? The default for most tool calls is rest, not dissolve. Explicitly chose one; don't leave it to an implicit policy.
6. Does it survive the **absent test** — would the plane going absent (because no items remain) break this item's semantics? Active items say no (they shouldn't persist after their work ends). Resting items say yes (they persist through the motebit's idle until the user or the session dismisses them). Records-in-disguise also say yes — if the answer is yes for a reason other than rest, it's probably a panel record, not a slab item.
7. Does its transition obey **droplet physics** — emergence as meniscus-expansion, dissolution as surface-ripple-absorption, detachment as bead-tension-release? If not, the metaphor is leaking.
8. Does it render **identically across web, desktop, spatial, and mobile**? If surface-specific, it's either a renderer detail (fine) or a capability split (needs justification per the capability-rings doctrine).
9. Does it have the **minimum gesture set** — tap (focus) and swipe (dismiss) at least? A kind with rich rendering but no user touch drifts toward movie. A kind with "run tool" chrome drifts toward remote desktop. Ship the third state, not either adjacent one.

## References

- [`records-vs-acts.md`](records-vs-acts.md) — the substrate categorization.
- [`panels-pattern.md`](panels-pattern.md) — the cross-surface controller shape the slab extends to scene primitives.
- [`surface-determinism.md`](surface-determinism.md) — affordances that trigger slab work must be deterministic.
- [`DROPLET.md`](../../DROPLET.md) — the physics the slab inherits (Rayleigh–Plateau, surface tension, eigenmode breathing).
- [`THE_ACTOR_PRINCIPLE.md`](../../THE_ACTOR_PRINCIPLE.md) — agents-to-agents shape that shows on the slab as delegation traffic.
