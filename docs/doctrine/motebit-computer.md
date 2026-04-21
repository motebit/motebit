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

## Lifecycle

Three transitions — each one rooted in droplet physics, not CSS easing:

### Emergence

When work starts, a small glass droplet forms at the slab's anchor point and expands into a plane. The transition is the inverse of a droplet collapsing: a sphere relaxes into an oblate disk. ~400ms; size and opacity co-animate.

### Dissolution

When an item on the slab ends without producing a durable output (ephemeral tool result, interrupted stream, failed step), it **dissolves back into the slab surface** — the item's outline softens, the content fades inward, the slab's own surface briefly ripples at the dissolution site. ~300ms. No artifact is spawned.

### Detachment (the pinch)

When an item on the slab produces a durable output (a completed essay, a finalized code file, a signed receipt, a formed memory), it **detaches** into its own scene object. This is the load-bearing transition; get it wrong and the metaphor collapses into a CSS transform.

The physics: the slab surface dimples upward at the item's center as internal pressure rises. The dimple grows into a bead under surface tension. The bead separates from the slab with a brief tendril that snaps (Rayleigh–Plateau instability — the same physics the creature's breathing borrows from). The detached bead takes its artifact-appropriate shape mid-flight (text card, code pane, plan scroll, receipt orb, memory mote) and continues outward into the scene. The slab's surface ripples back to flat with a small residual oscillation. ~600–800ms total, eased on tension-release curves, not on generic `ease-out`.

Droplets bead → tension → release. The slab obeys the same law as its parent body.

### Recession

When all work completes and the slab holds no active items, the slab itself recedes: it fades to near-invisible refraction, retaining only its meniscus and a faint specular mark at the right edge of the scene. The plane is still present (identity preserved, no remount cost on the next turn) — just honest-empty. Reappears without re-emergence animation when the next item arrives; the emergence is the _first_ item's physics, not the plane's.

## Silent state

The slab has three ambient states; the doctrine requires all three to be implemented:

| State        | Visual                                                             | When                                                         |
| ------------ | ------------------------------------------------------------------ | ------------------------------------------------------------ |
| **idle**     | meniscus + refraction + faint specular; zero content, zero glow    | no active items; motebit thinking-without-tool-calling       |
| **active**   | internal warmth matched to soul color; items visible through glass | at least one item on the slab; work in progress              |
| **recessed** | edge refraction only, plane retained behind the scene envelope     | prolonged idle; next item will re-animate the first-item pop |

The idle state is not a bug. It is the proof that the slab respects silence — the motebit can think without performing for you. Do not fill the idle state with skeleton loaders, typing dots, progress bars, or "thinking…" strings. If the slab is idle, the slab shows idle.

## Visual properties (binding)

| Property              | Value                                                                               | Reason                                                                             |
| --------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Material              | Apple-Liquid-Glass (same cryst. family as the creature; same IOR derivation)        | One body, one material.                                                            |
| Aspect ratio          | ~16:9 to golden-ratio (~1.618:1)                                                    | Held-tablet feel, not wall-monitor.                                                |
| Tilt                  | ~10–15° forward (toward camera), ~5° yaw toward the motebit                         | Gaze axis. Makes the creature's attention legible.                                 |
| Edges                 | meniscus (rounded surface-tension curve), **no frame, no border, no corner radius** | Droplet family. The moment it has corners, it stops being a droplet.               |
| Breathing             | ~0.3 Hz sympathetic with the creature, amplitude ~30% of creature amplitude         | One body, one respiratory rhythm. The slab inherits, not imitates.                 |
| Tint when active      | derived from current soul color (cyan creature → cyan slab warmth)                  | The slab is body-adjacent, not brand-adjacent.                                     |
| Tint when idle        | none; refraction only                                                               | Idle has no identity to project.                                                   |
| Items on slab surface | ~1mm forward depth; subtle Fresnel on edges                                         | Cards feel lifted, not painted.                                                    |
| Chrome                | **none**                                                                            | No titlebar, no close, no scroll, no resize. Controls appear on gaze and dissolve. |

## Failure modes to avoid

- **Third-person logging disguised as experience.** A card that says `fetch → status: calling` is a log line. The Motebit Computer renders _the page being fetched_, not the act of fetching described. If a card reads like a CloudWatch stream, the metaphor has collapsed. Status strings, event names, and log-shaped presentation don't belong on the slab.
- **Rich-duplicating chat.** Chat and slab both rendering the _full_ content of an act — the whole fetched page in chat AND as a slab card, the complete terminal output in both — is the collapse. Chat may carry a one-line textual echo (accessibility + Ring-1 fallback); it must not replicate the slab's rich content. If the chat rendering grows beyond a one-liner, the frames have merged.
- **Growing chrome.** The first "let's add a close button so users can dismiss it" turns the slab into a browser tab. Users dismiss the slab by the motebit going idle; that's the doctrine.
- **Persistent items.** An item that stayed on the slab after work ended has either detached (artifact) or should have dissolved. Persistent-item-on-slab is the records-vs-acts boundary breaking.
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
4. Does it have a **durable output** that outlives the work? If yes, it must detach as an artifact — not persist on the slab.
5. Does it survive the **idle test** — would hiding it when the slab is idle break its semantics? If yes, it's probably chrome or a record in disguise.
6. Does its transition obey **droplet physics** — emergence as meniscus-expansion, dissolution as surface-ripple-absorption, detachment as bead-tension-release? If not, the metaphor is leaking.
7. Does it render **identically across web, desktop, spatial, and mobile**? If surface-specific, it's either a renderer detail (fine) or a capability split (needs justification per the capability-rings doctrine).

## References

- [`records-vs-acts.md`](records-vs-acts.md) — the substrate categorization.
- [`panels-pattern.md`](panels-pattern.md) — the cross-surface controller shape the slab extends to scene primitives.
- [`surface-determinism.md`](surface-determinism.md) — affordances that trigger slab work must be deterministic.
- `DROPLET.md` — the physics the slab inherits (Rayleigh–Plateau, surface tension, eigenmode breathing).
- `THE_ACTOR_PRINCIPLE.md` — agents-to-agents shape that shows on the slab as delegation traffic.
