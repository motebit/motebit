# Always-already slab

The slab is **instantly-instantiable on intent**, not always-rendered. Bootstrap holds the body; intent invokes the slab. Once invoked, the slab materializes intact — chrome present, empty register settled, no two-pass cold-start.

The principle has three coordinated assertions, each implied by the others:

1. **Temporal — instantly-instantiable on intent.** Every mount routes through one entry point (`WebApp.invokeComputer()` on web). Slash command, key shortcut, AI `computer({...})` tool call, future drop-URL — same idempotent call. Before invocation the slab is not rendered.
2. **Spatial — content embeds, never adjacent.** Every content kind composes into the slab's typed slots inside `stageEl`. Chrome in `controlBandSlot`. Screencast in the screen-mesh texture. Adjacent mounts — chrome on a viewport-top sibling, fallback overlays on the renderer container — break slab coherence.
3. **Modal — empty is READY.** When the slab is up but has no live session, the chrome IS the affordance. URL input with `"type a URL"` placeholder. Typing routes through the surface's session-aware forward closure to lazy-open a cloud session. No decorative breathing mark, no centered caption competing with the input.

## What invokes the slab

The slab is gated on intent. `WebApp.bootstrap` does NOT mount the shell; it prepares the body and the affordances.

- `/computer` slash command in chat
- Option+C keyboard shortcut
- AI calls `computer({...})` tool — `attachSessionToLiveBrowser` mounts the shell when `onSessionLive` fires
- (Future) drop URL on the creature, click cloud-icon affordance, peer-viewport handoff

`invokeComputer` is idempotent: mounts the `live_browser` shell if not yet up, warms the cloud session via `ensureDefaultSession()`. Re-invoking after a hide flips visibility only.

## Composition

The slab is the constant-when-invoked; content is the visitor.

- **Acts** (motebit doing something) compose into the slab's primary surface via the slab's typed content slot — part of the slab's geometry, not a child of an adjacent host.
- **Records** (panels of accumulated state) live outside the slab's silhouette by design — see [`records-vs-acts.md`](records-vs-acts.md). Records are not slab content.
- **Empty** is the slab's READY register. The chrome strip with its URL input is the rendered affordance.

What occupies the body region (below the chrome) is typed at `@motebit/render-engine::SlabBodyRegister` and lives in `slab-core.ts` as the **single source of truth**: `home` (forward-framed affordances, no live session), `live` (screencast occupies the body), `transition` (home overlays a dim screencast during URL-bar focus, Apple Safari pattern). The renderer derives screen-mesh visibility from the register; surfaces mount body content based on it. One value, two physical levers (WebGL screen mesh + CSS3D `bodySlot`), no implicit coupling. See [`motebit-computer.md`](motebit-computer.md) §"Body register — the tri-state."

## Violations the principle catches

Past wrong moves on /computer were violations of one of the three assertions:

- **`setSlabControlBand` mounting chrome at the renderer container's top edge** outside `stageEl` — adjacency violation. Chrome floated beside the slab; toggle-off faded the body while the chrome lingered. Resolved by deleting `setSlabControlBand` + `controlBandSlotEl`; chrome lives only in the shell's `controlBandSlot` inside `stageEl`.
- **Eager mount of the live_browser shell + cloud session on bootstrap** — temporal violation. The shell pre-mounted before any user intent. Resolved by routing every mount through `WebApp.invokeComputer()`, called only on intent.
- **Two redundant empty registers** (slab-level ghost-ready affordance AND live_browser pre-frame breathing dot) — composition violation. Two ready signals competing. Resolved by deleting both decorative markers; the URL input IS the affordance.
- **Slab body and chrome fading at different rates on toggle-off** — coherence violation. WebGL plane eased smoothly; CSS3D chrome lingered. Resolved by `setUserVisible(false)` snapping `planeVisibility = 0`, mirroring the snap-on-reveal pre-warm; both registers cross the visibility threshold in the same frame.

## Affirmative shape

- **Default landing**: creature only. The body holds the surface.
- **Invocation**: `invokeComputer()` mounts the `live_browser` shell inside `stageEl` (chrome strip in `controlBandSlot`, screencast `<img>` in the screen-mesh slot) and warms a cloud-browser session through `ensureDefaultSession()`.
- **Mount and visibility move together**: `setUserVisible(true)` pre-warms `planeVisibility` to `MEMBRANE_OPACITY` immediately; on the same frame the WebGL plane crosses the visibility threshold and the CSS3D `stageAnchor.visible` flips. Slab and chrome enter intact.
- **Empty register**: shell-without-session. The URL input is the affordance; typing routes through `forwardUserInput` to lazy-open a session.
- **Live register**: shell-with-screencast. Frames flow through `onFrameDecoded` → `setSlabScreencastImage` into the WebGL screen-mesh texture, depth-shared with the creature, silhouette-clipped by the meniscus geometry. Chrome remains present.
- **Toggle-off**: `setUserVisible(false)` snaps `planeVisibility = 0`. Both registers flip invisible in the same frame. The slab leaves intact, mirroring how it entered.
- **Sessions attach and detach** via `attachSessionToLiveBrowser` / `detachSessionFromLiveBrowser`. The shell persists across session boundaries; toggle-off hides, doesn't unmount. Re-invoke = re-show.

## Cross-cuts

- [`motebit-computer.md`](motebit-computer.md) — what the slab IS (workstation, organs, embodiment modes, lifecycle, visual properties).
- [`liquescentia-as-substrate.md`](liquescentia-as-substrate.md) — material constants (`CANONICAL_MATERIAL`, `ENV_LIGHT`, 0.3 Hz breathing) the slab inherits.
- [`records-vs-acts.md`](records-vs-acts.md) — acts pass through the slab, records sit alongside.
- [`surface-determinism.md`](surface-determinism.md) — the URL input is a deterministic affordance; typing routes through `forwardUserInput`, not through the AI loop.

## Code review

Three questions when reviewing slab-adjacent UI:

1. **Does the slab mount on intent, not on bootstrap?** Auto-mount at app boot or route landing is wrong. Every mount path must route through `invokeComputer`.
2. **Does content embed into the slab's slots inside `stageEl`, or float adjacent?** Chrome inside `controlBandSlot`. Screencast inside the screen mesh. Adjacent mounts are violations.
3. **Does the slab move as one piece on toggle?** Both registers (WebGL plane + CSS3D chrome) must enter and leave in the same frame. Snap on both edges.
