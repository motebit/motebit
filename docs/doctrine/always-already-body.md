# Always-already body

The slab on /computer was silent until motebit acted. The user landed on the workspace and saw a void; the chrome strip would mount only when a cloud session opened, the screencast would stream only when a tool called navigate. The body was waiting for content to give it permission to exist.

That was wrong. The realization that closed it: **the body precedes content, content embeds into the body, empty states are READY, not absent.**

A body whose existence is contingent on content is two surfaces stitched together — the absence-surface and the presence-surface — held together by stitching the user can perceive. A body whose existence is constant is one surface in two registers (READY and LIVE), no seam.

## What counts as a body

"Body" is a category in motebit's vocabulary, with subtypes:

- **Identity body** — the creature. The motebit IS this body. Persistent, breathing, soul-tinted; renders from app boot regardless of activity. Canonically what "the body" means in [`motebit-computer.md`](motebit-computer.md).
- **Perceptual body** — a workspace surface where motebit acts and the user perceives those acts. The slab on /computer is the worked instance: the identity body's first-person perceptual field, itself a body in the geometric sense (glass volume, meniscus silhouette, typed content slots, sympathetic-breathing substrate).
- **Future bodies** — mobile's surface analog, spatial's primitive analog, a peer's slab visible through `peer_viewport`. Each will be its own perceptual body when implemented; each inherits this principle.

The principle below applies to **all** bodies. The slab is the worked instance because it's where the principle was first violated and corrected; the creature already obeyed it (the creature has never been contingent on content). Future bodies inherit the rule.

## The principle

> **Surfaces precede content. Content composes INTO them, never adjacent. Empty is READY, not absent.**

Three coordinated assertions, each implied by the others:

1. **Temporal — the body precedes content.** The body exists before content arrives, persists when content departs, and never depends on content for its existence. Lazy-mount-on-first-content is wrong by default; the body's permanence is its identity.

2. **Spatial — content composes into the body, never adjacent to it.** Chrome inside the slab item's `controlBandSlot`. Screencast inside the slab's screen mesh. Ghost-ready affordance inside the slab's `stageEl`. Nothing floats next to the slab; nothing mounts at viewport-edge fallback positions. Adjacency breaks body coherence.

3. **Modal — empty states are READY states.** When the body has no content (cold start, post-session-close, idle), the body shows a sympathetic-breathing affordance announcing its readiness — a pulsing mark + caption, breathing at the same 0.3 Hz the creature breathes at. The body is never literally blank, only ever ready or live.

## Composition rules

The body is the constant; content is the visitor.

- **Acts** (motebit doing something) compose into the body's primary surface. They embed via the body's typed content slot — part of the body's geometry, not a child of an adjacent host.
- **Records** (panels of accumulated state) live outside the body's silhouette by design (per [`records-vs-acts.md`](records-vs-acts.md)). Records are NOT body content; they are a different category and a different surface.
- **Empty** is the body's READY register. A body's empty state is not "no content" — it is "ready for content." The substrate's quiescence rhythm carries through into the READY register, making the empty body quietly alive rather than silent.

The asymmetry "acts pass through the body, records sit alongside it" is load-bearing: both are first-class, but only acts compose into the body. The READY register applies only to the body's act surface, never to record surfaces.

## Violations the principle catches

Every wrong move on /computer this codebase has made was a violation of one of those three assertions:

- **`setSlabControlBand` mounting chrome at the WebGL canvas viewport's top edge** when no live_browser handle existed. Adjacency violation: chrome floating beside the slab instead of embedded inside it. Body coherence broken; the chrome read as an OS-level header bar, not part of the workspace.
- **Calm-chrome simplification fading the URL bar to transparent in dominant states.** Silence-not-calm violation: empty isn't absent. The chrome should be present even when its content is unobtrusive; fading it implied the affordance had been removed.
- **Lazy cloud-session warmup waiting for the AI's first `computer` tool call.** Temporal violation: body waiting for content's permission to exist. The slab on /computer should announce itself the moment the user lands; cold-start is paid up-front, not delayed until uncertain need.

## Affirmative shape

The body is always-already there. Specifically, on /computer:

- `WebApp.bootstrapComputer` eagerly calls `registration.ensureDefaultSession()` at app boot — within 1-2s the live_browser slab item mounts via `onSessionLive`, chrome lands inside its proper slot.
- During the cold-start window AND on session close, the slab's `stageEl` shows a centered ghost-ready affordance: pulsing mark + `type a URL · or ask motebit`. Sympathetic-breathing at 0.3 Hz, body-coherent per [`liquescentia-as-substrate.md`](liquescentia-as-substrate.md) §"Quiescence rhythm."
- All chrome and content composes via the slab item's slots (`controlBandSlot`, screen mesh, `stageEl`) — never via legacy fallback mounts. The slab item is the body's content socket; nothing skips around it.

## What this is NOT

- Not "eager initialization everywhere." Other surfaces (memory panels, agent lists, settings) appropriately render when their data arrives. The principle applies to the body specifically — the act-surface — because the body IS the workspace, and a workspace exists before its work.
- Not "no empty states." Empty states are first-class — the ghost-ready affordance is the empty state's premium register. The principle forbids LITERAL emptiness (silence, void, blank), not the existence of empty states.
- Not "fight the renderer for visual continuity." If the body's geometry is invisible due to a real failure (WebGL context lost, init error), honest absence is correct; the principle governs the design intent, not the failure mode.

## Cross-cuts

- [`liquescentia-as-substrate.md`](liquescentia-as-substrate.md) — the medium every render surface inherits is always-already present too; the body's substrate is the medium, the medium is the substrate. This doctrine extends liquescentia from "the medium exists" to "the body always-already inhabits the medium."
- [`motebit-computer.md`](motebit-computer.md) — the slab is the motebit's first-person perceptual field; this doctrine names the slab's temporal property (always-already there) and spatial property (content embeds, never adjacent).
- [`records-vs-acts.md`](records-vs-acts.md) — body shows acts; panels hold records. This doctrine adds the empty-act rule: between acts, the body shows the READY register. The body persists between acts, not only during them.
- [`surface-determinism.md`](surface-determinism.md) — affordances invoke capabilities, not prompts. The ghost-ready caption (`type a URL · or ask motebit`) is a deterministic affordance pair: typing routes through `forwardUserInput`, asking routes through chat. Both are typed paths, never AI-loop-mediated.

## How this lands as code review

When reviewing slab-adjacent UI work, three questions:

1. **Does the body exist before its content?** If the surface waits for data/session/state to be visible, and the surface IS the workspace, that's wrong. Bootstrap eagerly.
2. **Does content embed into the body's slots, or float adjacent?** Chrome inside `controlBandSlot`. Screencast inside the screen mesh. Ghost inside `stageEl`. Adjacent mounts (viewport-top fallback, off-slab overlays) are violations.
3. **Are empty states READY, not absent?** A blank surface during cold-start, post-session, or idle violates the principle. The empty state should announce the body's readiness with a calm affordance — never literal void.
