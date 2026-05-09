# Always-already slab

The slab on /computer was visible before invocation, with a duplicate off-slab chrome path and a breathing placeholder competing with the URL bar. Toggle-off faded the WebGL plane while the chrome lingered. "Always-already" had been read as "always-rendered" — the body got conflated with the slab, the slab got conflated with the workspace, and the user landed on /computer to a tool already taking the show from the body.

That was wrong. The realization that closed it: **"always-already" means instantly-instantiable, not always-rendered. The body is the show. The slab is a tool, summoned and dismissed, intact on both edges.**

The slab inherits the body's sufficiency through the substrate — when the user invokes it, it is structurally there, no cold-start cascade. But "structurally there" means available without construction time, not rendered without invocation. A slab pre-rendered before the user signals intent is a tool taking the body's stage; that violates the body-is-the-show principle as much as a slab that lazy-mounts after a tool call violates instantiation.

## Lineage

The slab's permanence is inherited.

- [`DROPLET.md`](../../DROPLET.md) §VIII closes with sufficiency: "_It is one because it has not yet outgrown its surface. That is sufficient._" The body's existence is sufficient unto itself, not contingent on content. The body is what motebit IS — the creature, derived from variational calculus on surface tension, breathing at the Rayleigh eigenmode (~0.3 Hz), glass-transmissive.
- [`LIQUESCENTIA.md`](../../LIQUESCENTIA.md) and [`liquescentia-as-substrate.md`](liquescentia-as-substrate.md) name the medium the body inhabits. The medium is always-already present too — it permits the body, doesn't create it.
- The slab inherits sufficiency through the substrate. The slab's material, eigenfrequency, glass-transmissive register, and the structural availability that lets it materialize intact-on-invocation all flow downward from DROPLET.md → LIQUESCENTIA.md → the slab as the medium's act-surface. The slab is an organ of the body — the body's first-person perceptual field per [`motebit-computer.md`](motebit-computer.md) — not a body itself.

The lineage is: **body (DROPLET.md) → substrate (liquescentia-as-substrate.md, the medium the body inhabits) → slab (this doctrine, the act-surface the substrate carries).** Three layers, three names, no overloading. Each layer cites the one below as its grounding. The body is rendered always (sufficiency); the substrate is present always (medium); the slab is instantly-instantiable on intent (organ).

## The principle

> **The slab is instantly-instantiable on intent. Content embeds INTO the slab's slots, never adjacent. Empty is READY, not absent.**

Three coordinated assertions, each implied by the others:

1. **Temporal — instantly-instantiable on intent.** When the user invokes the slab (slash command, key shortcut, AI tool call, drop URL), it materializes intact in the same frame: shell mounted, chrome present, empty register settled. No two-pass cold-start, no chrome-arrives-then-screencast-arrives cascade. "Always-already" means zero construction time at invocation. Before invocation, the slab is not rendered — the body is the show.

2. **Spatial — content embeds, never adjacent.** Every content kind composes into the slab's typed slots inside `stageEl`. Adjacent mounts — chrome on a sibling viewport-top slot outside the slab's silhouette, fallback overlays on the renderer container — violate slab coherence. The slab has slots; content uses them.

3. **Modal — empty is READY.** When the slab is up but has no live session, the empty register IS the chrome's existence. The URL input bar with placeholder text "type a URL" is the affordance, deterministic and typed; typing in it routes through the surface's session-aware forward closure to lazy-open a cloud session. The chrome is the READY signal — no decorative breathing mark, no centered caption, no second empty register stitched onto the first.

## What invokes the slab

The slab is gated on intent. Every mount routes through `WebApp.invokeComputer()` (idempotent — mounts the live_browser shell if not yet up, warms the cloud session if not yet warmed):

- `/computer` slash command in chat
- Option+C keyboard shortcut
- AI calls `computer({...})` tool — `attachSessionToLiveBrowser` mounts the shell when `onSessionLive` fires
- (Future) drop URL on the creature, click on the cloud-icon affordance, peer-viewport handoff

`WebApp.bootstrap` does **not** mount the shell. The bootstrap path holds the body and prepares the affordances; it does not pre-mount tools.

## Composition rules

The slab is the constant-when-invoked; content is the visitor.

- **Acts** (motebit doing something) compose into the slab's primary surface. They embed via the slab's typed content slot — part of the slab's geometry, not a child of an adjacent host.
- **Records** (panels of accumulated state) live outside the slab's silhouette by design (per [`records-vs-acts.md`](records-vs-acts.md)). Records are NOT slab content; they are a different category and a different surface.
- **Empty** is the slab's READY register. The empty state is not "no content" — it is "ready for content." The chrome strip with its URL input is the rendered affordance; the slab body is the perceptual field around it.

The asymmetry "acts pass through the slab, records sit alongside it" is load-bearing: both are first-class, but only acts compose into the slab. The READY register applies only to the slab's act surface, never to record surfaces.

## Violations the principle catches

Every wrong move on /computer this codebase has made was a violation of one of those three assertions:

- **`setSlabControlBand` mounting chrome at the renderer container's top edge** when no live_browser handle existed, outside `stageEl`. Adjacency violation: chrome floating beside the slab instead of embedded inside it. Slab coherence broken; the chrome's lifecycle decoupled from the slab's, so toggle-off faded the slab body while the chrome lingered. Resolved by deleting `setSlabControlBand` + `controlBandSlotEl`; chrome lives only in the live_browser shell's `controlBandSlot` inside `stageEl`.
- **Eager mount of the live_browser shell + cloud session on bootstrap.** Temporal misread of "always-already": the shell pre-mounted before any user signal of intent, putting a tool on stage in front of the body. Resolved by routing every mount through `WebApp.invokeComputer()`, called only on intent (slash command, key shortcut, AI tool call).
- **Two redundant empty registers — slab-level ghost-ready affordance AND live_browser pre-frame breathing dot.** Composition violation: two ready signals competing for the same body, with a perceptible transition as one mounted on the other. Resolved by deleting both decorative empty markers; the chrome itself (URL input, "type a URL" placeholder) is the affordance.
- **Slab body and chrome fading at different rates on toggle-off.** Coherence violation: the WebGL plane eased smoothly while the CSS3D chrome lingered through the easing window. The slab must move as one piece. Resolved by `setUserVisible(false)` snapping `planeVisibility = 0`, mirroring the snap-on-reveal pre-warm; both registers cross the visibility threshold in the same frame.

## Affirmative shape

The slab is instantly-instantiable on intent. On /computer:

- Default landing: creature only. The body holds the surface; the slab is not yet rendered.
- Invocation routes through `WebApp.invokeComputer()` — idempotent: mounts the `live_browser` shell inside `stageEl` (chrome strip in `controlBandSlot`, screencast `<img>` in the screen-mesh slot), warms a cloud-browser session through `ensureDefaultSession()`. Same call from every entry point: slash command, Option+C, AI computer tool, future drop-URL/affordance paths. Re-invoking after a hide is a no-op on mount, just flips visibility.
- Mount and visibility move together. `setUserVisible(true)` pre-warms `planeVisibility` to `MEMBRANE_OPACITY` immediately; on the same frame the WebGL plane crosses the visibility threshold and the CSS3D `stageAnchor.visible` flips. Slab and chrome enter intact.
- Empty register: shell-without-session. The chrome strip with its URL input is the affordance; typing routes through the shell's session-aware forward closure to lazy-open a session. No decorative breathing mark, no caption — the input field IS the affordance, deterministic and typed.
- Live register: shell-with-screencast. Frames flow through `onFrameDecoded` → `setSlabScreencastImage` into the WebGL screen-mesh texture, depth-shared with the creature, silhouette-clipped by the meniscus geometry per [`liquescentia-as-substrate.md`](liquescentia-as-substrate.md) §"Cohesive permeability." Chrome remains present.
- Toggle-off: `setUserVisible(false)` snaps `planeVisibility = 0`. WebGL plane mesh and CSS3D stage anchor both flip invisible in the same frame. The slab leaves intact, mirroring how it entered.
- Sessions attach and detach via `attachSessionToLiveBrowser` / `detachSessionFromLiveBrowser`. The shell persists across session boundaries; toggle-off does not unmount the shell, it hides it. Re-invoke = re-show. The user perceives one continuous tool, summoned and dismissed.
- All chrome and content composes via the live_browser shell's slots (`controlBandSlot`, screen mesh) inside `stageEl` — never via legacy fallback mounts. The shell is the slab's content socket; nothing skips around it.

## What this is NOT

- Not a claim that the slab IS a body. The slab is the body's first-person perceptual field — an organ of the body, not a body itself. The slab inherits the body's sufficiency through the substrate; it does not become a body by inheriting. "Body" continues to mean what it has meant in the chain since DROPLET.md: the creature, single referent, physics-grounded.
- Not "eager render everywhere." The body is always rendered; the slab is invoked. Other surfaces (memory panels, agent lists, settings) appropriately render when their data arrives or when the user opens them. The principle applies to the slab specifically because the slab IS the workspace — it must be intact-on-invocation, not partially-mounted-on-intent-and-then-completed.
- Not "no empty states." The empty register is first-class — it is the chrome's existence as deterministic affordance. The principle forbids LITERAL emptiness inside an invoked slab (silence, void, blank chrome), not the existence of empty states.
- Not "always-rendered." Always-already means structurally available without construction time at invocation. A slab pre-rendered before invocation takes the body's stage and violates body-is-the-show; a slab that lazy-mounts after a tool call violates instantiation. Both fail the principle from opposite directions.
- Not "fight the renderer for visual continuity." If the slab's geometry is invisible due to a real failure (WebGL context lost, init error, cloud-browser unconfigured), honest absence is correct; the principle governs the design intent, not the failure mode.

## Cross-cuts

- [`DROPLET.md`](../../DROPLET.md) §VIII — the body's sufficiency. The slab inherits sufficiency through the substrate as instant-instantiability, not as always-rendered presence. The lineage runs body → substrate → slab; this doctrine names the third link.
- [`LIQUESCENTIA.md`](../../LIQUESCENTIA.md) and [`liquescentia-as-substrate.md`](liquescentia-as-substrate.md) — the medium the body inhabits. The medium is always-already present; the slab inherits its structural availability from the medium, which inherits its presence from the body.
- [`motebit-computer.md`](motebit-computer.md) — the slab is the body's first-person perceptual field. This doctrine names the slab's temporal property (instantly-instantiable on intent) and spatial property (content embeds, never adjacent).
- [`records-vs-acts.md`](records-vs-acts.md) — body shows acts; panels hold records. This doctrine adds the empty-act rule: between acts within the same invocation, the slab shows the READY register (chrome as affordance). The slab persists between acts within an invocation; it does not persist across invocations — invocations summon and dismiss.
- [`surface-determinism.md`](surface-determinism.md) — affordances invoke capabilities, not prompts. The chrome's URL input is a deterministic affordance: typing routes through `forwardUserInput` to the cloud-browser session, not through the AI loop. Both /computer slash command and the URL bar are typed paths.

## Generalization without categorization

The principle generalizes when other act-surfaces ship — mobile's surface analog, spatial's primitive analog, the viewport-grade rendering of `peer_viewport`. They will inherit the same physics through the same lineage: the substrate (always-already-present medium) carries the body's sufficiency outward; act-surfaces inherit instant-instantiability by being IN the substrate.

This is generalization through inheritance, not through categorization. The substrate is the canonical inheritance medium — surfaces become act-surfaces by inhabiting it, not by being reclassified as bodies. Body remains singular; substrate propagates outward; act-surfaces are what the substrate carries.

## How this lands as code review

When reviewing slab-adjacent UI work, three questions:

1. **Does the slab mount on intent, not on bootstrap?** If a surface auto-mounts the slab at app boot or at route landing, that's wrong. Bootstrap holds the body; intent invokes the slab. Every mount path must route through a single intent-gated entry point (`invokeComputer` for web today).
2. **Does content embed into the slab's slots inside `stageEl`, or float adjacent?** Chrome inside `controlBandSlot`. Screencast inside the screen mesh. Adjacent mounts (renderer-container slots, viewport-top overlays) are violations.
3. **Does the slab move as one piece on toggle?** Both registers (WebGL plane + CSS3D chrome) must enter and leave in the same frame. Easing one without the other creates the frankenstein the user perceives as a chrome strip lingering past the slab body. Snap on both edges; instant-instantiability applies to dismissal too.
