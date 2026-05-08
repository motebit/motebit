---
"@motebit/protocol": minor
---

v1.3 slice 2 — slab UI swap. The `live_browser` slab item kind
crystallizes the continuous JPEG screencast into a single visual
element on the plane, replacing the "slideshow of stills" register
that per-action screenshots produced.

`@motebit/protocol` adds `ScreencastFrameSource` — minimal
subscribe-shape interface (`{subscribe(callback): () => void}`) the
producer (apps' frame bus) and consumer (the slab's live element)
both consume. Sibling pattern to other observer surfaces in the
package.

`@motebit/render-engine` adds:

- `live_browser` to the `SlabItemKind` union; `defaultEmbodimentMode`
  maps it to `virtual_browser` so callers that don't pass `mode`
  explicitly land at the right mode boundary.
- `buildLiveBrowserElement(source)` — pure DOM builder. Returns
  `{element, dispose}`. The element is an `<img>` wrapped in a
  `slab-live-browser` div with a placeholder until the first frame
  arrives. Each subscribed frame replaces the placeholder, locks the
  aspect ratio to the captured viewport, and updates `img.src` with
  the JPEG data URL. Latest-wins on `timestamp` so out-of-order CDP
  frames don't paint backwards. `dispose` is idempotent; post-dispose
  publishes are silently dropped.
- 9 jsdom tests cover the subscribe → first-frame → subsequent-frames
  → dispose lifecycle plus the latest-wins ordering and the dispose
  → no-paint contract.

Why `<img>` and not `<canvas>`. `data:` URL src updates defer JPEG
decode + paint to the rendering thread; canvas would buy composite
control v1.3 doesn't need. If a future slice adds cursor overlays or
click ripples on the frame surface, swap to canvas as a contained
renderer change — the `(source) => {element, dispose}` contract
stays.
