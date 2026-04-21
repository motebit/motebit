# Motebit Computer — the slab

A motebit is a droplet under surface tension. The body is passive; the interior is active. When the motebit _does something_ — calls a tool, executes a plan step, streams a response — that doing needs somewhere to become visible. Not buried in a transcript, not flattened into a sidebar, not painted as chrome on the droplet's surface. The slab is that somewhere.

This doctrine pins what the slab is, what renders on it, how items leave it, and what it looks like when nothing is happening. Every future renderer and controller binds to this shape.

## What it is

The slab is a **liquid glass plane** floating to the right of the motebit in the spatial scene. Sibling to: **constellation** (clusters of related records), **artifact** (detached, persistent outputs), **chat bubble** (ephemeral conversational messages). It is not a panel, not a window, not a HUD. It has a meniscus, not a frame; no titlebar, no close button, no scrollbar chrome.

The slab is **the substrate on which acts materialize**. In the records-vs-acts categorization ([`records-vs-acts.md`](records-vs-acts.md)), the slab is the canonical surface for acts-in-progress. Records belong in panels. Completed artifacts detach from the slab into their own scene objects. The slab holds only the live middle — the tokens streaming, the tool call resolving, the plan step running.

## Why it exists

Three structural gaps the slab closes:

1. **Records-vs-acts has no active-work primitive.** Panels hold records. The creature shows ephemeral acts (attention, mood, speaking). Chat bubbles carry conversational moments. But there was no canonical place for _computation in progress_ — tool calls, plan steps, streaming output. Those either buried in the transcript or flashed briefly as chat-adjacent text. The slab is the missing primitive.

2. **The spatial-canvas thesis ("objects materialize in scene, not chat") needs somewhere to materialize into before they detach.** An artifact that springs from nothing is magical; an artifact that _beads off_ a working surface is physical. The slab is the working surface.

3. **Calm software needs an honest empty state.** Every other AI UI fills silence with skeleton loaders and "thinking…" text. The slab empty-but-present (refraction, meniscus, no content) proves process is not performance.

## What renders on the slab

- **Streaming model tokens** — before they crystallize into a chat bubble or an artifact. If the user interrupts or the turn fails, the stream dissolves back into the slab.
- **Tool call cards** — `{tool name, input → output}` materializing as the call streams. One card per call. Persistent through the call's lifetime; either dissolves (ephemeral result) or detaches as an artifact (durable result).
- **Plan step rows** — each step of a running plan appears as it begins, updates with `running | complete | failed` state, and either dissolves with the plan or contributes to a detached plan artifact at the end.
- **Bash / shell output streams** — scroll on the slab as output emits.
- **Web fetch / search results** — appear while retrieving; either dissolve after a read or detach as a memory artifact.
- **Embedding / inference calls** — in-progress markers; dissolve on completion unless explicitly pinned.

**Not on the slab:**

- Records (credentials, settled receipts, memory index, balance history). Those are panel content.
- Chat bubbles. Those drift between motebit and user; they're conversational, not procedural.
- Constellations. Those cluster above the slab when their domain is active, but they are their own scene object.
- UI chrome (buttons, menus, inputs). If the user must click something, it's an affordance and lives on the creature or in a panel, not the slab.

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

| Primitive     | Role                                | Relationship to slab                                                                                                                                                                                                                         |
| ------------- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Creature      | identity, mood, attention           | The source. Slab work originates from the creature's current activity. Slab tilts toward the creature; breathing is sympathetic.                                                                                                             |
| Chat bubble   | user ↔ motebit conversational turns | Parallel. Chat bubbles render the dialogue; slab renders the work the dialogue triggered. Never collapse into one surface.                                                                                                                   |
| Artifact      | durable, detached output            | Downstream. Artifacts are what graduate off the slab via the detachment pinch. Before artifact, it lived on the slab.                                                                                                                        |
| Constellation | cluster of related records          | Above. When the slab's active items touch a domain with an associated constellation (credentials during an auth tool call, agents during a delegation), the constellation materializes above the slab area for the duration of the activity. |
| Panel         | record surface, user-summoned       | Orthogonal. Panels hold what the motebit _has_; the slab shows what the motebit is _doing_. Never duplicate data between them.                                                                                                               |

## Doctrine check before any slab PR

1. Is the thing you're adding an **act** (on-slab) or a **record** (off-slab, in a panel)? If record, stop.
2. Does it have a **durable output** that outlives the work? If yes, it must detach as an artifact — not persist on the slab.
3. Does it survive the **idle test** — would hiding it when the slab is idle break its semantics? If yes, it's probably chrome or a record in disguise.
4. Does its transition obey **droplet physics** — emergence as meniscus-expansion, dissolution as surface-ripple-absorption, detachment as bead-tension-release? If not, the metaphor is leaking.
5. Does it render **identically across web, desktop, spatial, and mobile**? If surface-specific, it's either a renderer detail (fine) or a capability split (needs justification per the capability-rings doctrine).

## References

- [`records-vs-acts.md`](records-vs-acts.md) — the substrate categorization.
- [`panels-pattern.md`](panels-pattern.md) — the cross-surface controller shape the slab extends to scene primitives.
- [`surface-determinism.md`](surface-determinism.md) — affordances that trigger slab work must be deterministic.
- `DROPLET.md` — the physics the slab inherits (Rayleigh–Plateau, surface tension, eigenmode breathing).
- `THE_ACTOR_PRINCIPLE.md` — agents-to-agents shape that shows on the slab as delegation traffic.
