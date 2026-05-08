---
"@motebit/render-engine": minor
"@motebit/web": patch
---

v1.3 slice 2 — render-engine `live_browser` builder + apps-side
wiring. Closes the loop end-to-end so the slab actually shows live
motion when the cloud browser is running.

`@motebit/render-engine`:

- New `live_browser` member of the `SlabItemKind` union;
  `defaultEmbodimentMode` maps it to `virtual_browser` so callers
  that don't pass `mode` explicitly land at the right mode boundary.
- `buildLiveBrowserElement(source)` — pure DOM builder. Returns
  `{element, dispose}`. The element is an `<img>` wrapped in a
  `slab-live-browser` div with a placeholder until the first frame
  arrives. Each subscribed frame replaces the placeholder, locks the
  aspect ratio to the captured viewport, and updates `img.src` with
  the JPEG data URL. Latest-wins on `timestamp` so out-of-order CDP
  frames don't paint backwards. `dispose` is idempotent; post-dispose
  publishes are silently dropped. 9 jsdom tests cover the full
  lifecycle.

Why `<img>` and not `<canvas>`. `data:` URL src updates defer JPEG
decode + paint to the rendering thread; canvas would buy composite
control v1.3 doesn't need. If a future slice adds cursor overlays or
click ripples on the frame surface, swap to canvas as a contained
renderer change — the `(source) => {element, dispose}` contract
stays.

Apps-side wiring (`@motebit/web`):

`apps/web/src/screencast-bus.ts` — new `ScreencastFrameBus` class
implementing `ScreencastFrameSource`. Producer-agnostic, consumer-
agnostic relay between the cloud-browser dispatcher's
`openScreencast({onFrame})` and the slab's `live_browser` element.
Inverts the lifecycle dependency: the dispatcher publishes, the slab
item subscribes when it mounts. New subscribers receive the most
recent frame immediately, so a slab item that mounts mid-stream
paints with the current state instead of the placeholder.

`apps/web/src/computer-tool.ts` accepts new optional fields:

- `screencastBus` — when supplied, the registration calls
  `dispatcher.openScreencast` right after `openSession` and pipes
  frames into the bus. Fail-soft: a screencast failure leaves the
  per-action screenshot fallback intact.
- `onSessionLive(cloudSessionId)` / `onSessionEnding(cloudSessionId)`
  — surface hooks to mount/dissolve the `live_browser` slab item.

`closeAndEmit` runs the surface dissolve → bus.reset → screencast
stop → close-event emit ordering so the slab dissolves while the
subscription is still alive.

`apps/web/src/web-app.ts` instantiates the bus once per WebApp,
passes it through to `registerWebComputerTool`, and exposes
`openLiveBrowserSlabItem` / `dissolveLiveBrowserSlabItem` — both
keyed off the cloud session id so a new session opens a fresh slab
item.

`apps/web/src/ui/slab-items.ts` adds `case "live_browser"` in
`buildCardForKind` (calls `buildLiveBrowserElement` with the
payload's `frameSource`). Per-item disposers are tracked in a
module-scoped Map; `releaseLiveBrowserItem(itemId)` unsubscribes when
the item leaves the slab.

7 ScreencastFrameBus tests cover subscribe/publish, latest-frame
replay on subscribe, throwing-subscriber isolation, and reset
semantics. End-to-end is exercised manually against the running
service.
