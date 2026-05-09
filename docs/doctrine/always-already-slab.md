# Always-already slab

The slab on /computer was silent until motebit acted. The user landed on the workspace and saw a void; the chrome strip would mount only when a cloud session opened, the screencast would stream only when a tool called navigate. The slab was waiting for content to give it permission to exist.

That was wrong. The realization that closed it: **the slab precedes content, content embeds into the slab, empty states are READY, not absent.**

A slab whose existence is contingent on content is two surfaces stitched together — the absence-surface and the presence-surface — held together by stitching the user can perceive. A slab whose existence is constant is one surface in two registers (READY and LIVE), no seam.

## Lineage

The slab's permanence is not a new principle; it is inherited.

- [`DROPLET.md`](../../DROPLET.md) §VIII closes with sufficiency: "_It is one because it has not yet outgrown its surface. That is sufficient._" The body's existence is sufficient unto itself, not contingent on content. The body is what motebit IS — the creature, derived from variational calculus on surface tension, breathing at the Rayleigh eigenmode (~0.3 Hz), glass-transmissive.
- [`LIQUESCENTIA.md`](../../LIQUESCENTIA.md) and [`liquescentia-as-substrate.md`](liquescentia-as-substrate.md) name the medium the body inhabits. The medium is always-already present too — it permits the body, doesn't create it. The substrate is canonized in code as `ENV_LIGHT`, the canonical material, the 0.3 Hz breathing rhythm carried into every motebit-rendered surface.
- The slab inherits sufficiency through the substrate. The slab's material, eigenfrequency, glass-transmissive register, and now permanence all flow downward from DROPLET.md → LIQUESCENTIA.md → the slab as the medium's act-surface. The slab is an organ of the body — the body's first-person perceptual field per [`motebit-computer.md`](motebit-computer.md) — not a body itself.

The lineage is: **body (DROPLET.md) → substrate (liquescentia-as-substrate.md, the medium the body inhabits) → slab (this doctrine, the act-surface the substrate carries).** Three layers, three names, no overloading. Each layer cites the one below as its grounding.

## The principle

> **The slab precedes content. Content embeds INTO the slab's slots, never adjacent. Empty is READY, not absent.**

Three coordinated assertions, each implied by the others:

1. **Temporal — the slab precedes content.** The slab exists before content arrives, persists when content departs, and never depends on content for its existence. Lazy-mount-on-first-content is wrong by default. The slab inherits the body's sufficiency through the substrate.

2. **Spatial — content embeds, never adjacent.** Every content kind composes into the slab's typed slots. Adjacent mounts — decorations alongside the slab, fallback positions outside its silhouette — violate slab coherence. The slab has slots; content uses them.

3. **Modal — empty is READY.** When the slab has no content, it shows a sympathetic-breathing affordance announcing readiness, breathing at the same 0.3 Hz the body breathes at, inheriting the substrate's quiescence rhythm. The slab is never literally silent — only ever ready or live.

## Composition rules

The slab is the constant; content is the visitor.

- **Acts** (motebit doing something) compose into the slab's primary surface. They embed via the slab's typed content slot — part of the slab's geometry, not a child of an adjacent host.
- **Records** (panels of accumulated state) live outside the slab's silhouette by design (per [`records-vs-acts.md`](records-vs-acts.md)). Records are NOT slab content; they are a different category and a different surface.
- **Empty** is the slab's READY register. The empty state is not "no content" — it is "ready for content." The substrate's quiescence rhythm carries through into the READY register, making the empty slab quietly alive rather than silent.

The asymmetry "acts pass through the slab, records sit alongside it" is load-bearing: both are first-class, but only acts compose into the slab. The READY register applies only to the slab's act surface, never to record surfaces.

## Violations the principle catches

Every wrong move on /computer this codebase has made was a violation of one of those three assertions:

- **`setSlabControlBand` mounting chrome at the WebGL canvas viewport's top edge** when no live_browser handle existed. Adjacency violation: chrome floating beside the slab instead of embedded inside it. Slab coherence broken; the chrome read as an OS-level header bar, not part of the workspace.
- **Calm-chrome simplification fading the URL bar to transparent in dominant states.** Silence-not-calm violation: empty isn't absent. The chrome should be present even when its content is unobtrusive; fading it implied the affordance had been removed.
- **Lazy cloud-session warmup waiting for the AI's first `computer` tool call.** Temporal violation: slab waiting for content's permission to exist. The slab on /computer should announce itself the moment the user lands; cold-start is paid up-front, not delayed until uncertain need.

## Affirmative shape

The slab is always-already there. Specifically, on /computer:

- `WebApp.bootstrapComputer` eagerly calls `registration.ensureDefaultSession()` at app boot — within 1-2s the live_browser slab item mounts via `onSessionLive`, chrome lands inside its proper slot.
- During the cold-start window AND on session close, the slab's `stageEl` shows a centered ghost-ready affordance: pulsing mark + `type a URL · or ask motebit`. Sympathetic-breathing at 0.3 Hz, slab-coherent through the substrate per [`liquescentia-as-substrate.md`](liquescentia-as-substrate.md) §"Quiescence rhythm."
- All chrome and content composes via the slab item's slots (`controlBandSlot`, screen mesh, `stageEl`) — never via legacy fallback mounts. The slab item is the slab's content socket; nothing skips around it.

## What this is NOT

- Not a claim that the slab IS a body. The slab is the body's first-person perceptual field — an organ of the body, not a body itself. The slab inherits the body's sufficiency through the substrate; it does not become a body by inheriting. "Body" continues to mean what it has meant in the chain since DROPLET.md: the creature, single referent, physics-grounded.
- Not "eager initialization everywhere." Other surfaces (memory panels, agent lists, settings) appropriately render when their data arrives. The principle applies to the slab specifically — the act-surface — because the slab IS the workspace, and a workspace exists before its work.
- Not "no empty states." Empty states are first-class — the ghost-ready affordance is the empty state's premium register. The principle forbids LITERAL emptiness (silence, void, blank), not the existence of empty states.
- Not "fight the renderer for visual continuity." If the slab's geometry is invisible due to a real failure (WebGL context lost, init error), honest absence is correct; the principle governs the design intent, not the failure mode.

## Cross-cuts

- [`DROPLET.md`](../../DROPLET.md) §VIII — the body's sufficiency. The slab inherits sufficiency through the substrate, not through being a body. The lineage runs body → substrate → slab; this doctrine names the third link.
- [`LIQUESCENTIA.md`](../../LIQUESCENTIA.md) and [`liquescentia-as-substrate.md`](liquescentia-as-substrate.md) — the medium the body inhabits. The medium is always-already present; the slab inherits its permanence from the medium, which inherits its permanence from the body.
- [`motebit-computer.md`](motebit-computer.md) — the slab is the body's first-person perceptual field. This doctrine names the slab's temporal property (always-already there) and spatial property (content embeds, never adjacent).
- [`records-vs-acts.md`](records-vs-acts.md) — body shows acts; panels hold records. This doctrine adds the empty-act rule: between acts, the slab shows the READY register. The slab persists between acts, not only during them.
- [`surface-determinism.md`](surface-determinism.md) — affordances invoke capabilities, not prompts. The ghost-ready caption (`type a URL · or ask motebit`) is a deterministic affordance pair: typing routes through `forwardUserInput`, asking routes through chat. Both are typed paths, never AI-loop-mediated.

## Generalization without categorization

The principle generalizes when other act-surfaces ship — mobile's surface analog, spatial's primitive analog, the viewport-grade rendering of `peer_viewport`. They will inherit the same physics through the same lineage: the substrate (always-already-present medium) carries the body's sufficiency outward; act-surfaces inherit by being IN the substrate.

This is generalization through inheritance, not through categorization. The substrate is the canonical inheritance medium — surfaces become act-surfaces by inhabiting it, not by being reclassified as bodies. Body remains singular; substrate propagates outward; act-surfaces are what the substrate carries.

## How this lands as code review

When reviewing slab-adjacent UI work, three questions:

1. **Does the slab exist before its content?** If the surface waits for data/session/state to be visible, and the surface IS the workspace, that's wrong. Bootstrap eagerly.
2. **Does content embed into the slab's slots, or float adjacent?** Chrome inside `controlBandSlot`. Screencast inside the screen mesh. Ghost inside `stageEl`. Adjacent mounts (viewport-top fallback, off-slab overlays) are violations.
3. **Are empty states READY, not absent?** A blank surface during cold-start, post-session, or idle violates the principle. The empty state should announce the slab's readiness with a calm affordance — never literal void.
