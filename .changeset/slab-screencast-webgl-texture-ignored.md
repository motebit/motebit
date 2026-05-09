---
"@motebit/render-engine": patch
"@motebit/web": patch
---

slab-screencast-webgl-texture — promote the live-screencast visual
register from CSS3D-overlay to WebGL-texture-on-mesh.

**The seam Daniel surfaced.** When the slab is empty its meniscus
silhouette is visible — the apple-bite curve where the slab meets
the creature, doctrine-mandated droplet-family form
(`motebit-computer.md §"Visual properties"`). When the browser is
active, the screen content is a flat rectangle that doesn't follow
the slab's silhouette, and on rotation the HTML overlay punches
through the creature.

**Two render pipelines, no shared depth.** The slab is WebGL
geometry; the live screencast was an HTML `<img>` mounted via
`CSS3DObject` + `CSS3DRenderer`. CSS3DRenderer renders HTML in its
own DOM layer above the WebGL canvas. Two separate render passes
with no shared depth buffer:

- The HTML img is a flat rectangle with no silhouette — the
  slab's meniscus mesh can't clip it because the mesh doesn't do
  the clipping; the img sits in front as a div.
- At certain camera angles the overlay renders in front of the
  creature — CSS3D doesn't know the creature exists in the
  depth-buffer sense.

**The fix.** Add a third meniscus-shaped plane inside the slab
volume (sibling to the front + back panes, same z as the stage
anchor — 1mm in front of the back pane), carry the cloud-browser
JPEG bitstream as a `MeshBasicMaterial.map` on that plane.
Consequences:

- Silhouette: the screen mesh shares geometry with the front
  pane, so its silhouette IS the same droplet curve. The screen
  follows the slab shape.
- Depth: WebGL shared depth buffer with the creature. The
  creature occludes the screen at every angle; no through-punch.
- Refraction: the front pane's `transmission` samples the screen
  mesh through the glass — pixels embed in the slab volume,
  they don't sit in a parallel layer in front of it.

**API**

- `SlabManager.setScreencastImage(source: HTMLImageElement |
ImageBitmap)` — uploads a decoded frame as the texture image,
  shows the mesh. First call lazily initializes a single
  `THREE.Texture`; subsequent calls swap `.image` in place
  (`texture.needsUpdate = true`) so per-frame allocation is
  bounded.
- `SlabManager.clearScreencast()` — hides the mesh, disposes the
  texture, clears the material map. Idempotent. Closes
  ImageBitmap sources via `.close()` so GPU-side bitmap memory
  doesn't leak.
- Forwarded through the renderer adapter as
  `setSlabScreencastImage` / `clearSlabScreencast` (declared on
  `RenderAdapter` in `spec.ts`).

**HTML img stays — but invisible.** `live-browser.ts`'s img element
is now `opacity: 0`. It remains the input-capture surface
(`cobrowse-input-capture` attaches to it for clicks, keyboard,
paste, wheel — same screen-space rect, zero behavioral change),
but contributes nothing visually. The screen mesh is what the user
sees. New `BuildLiveBrowserDeps.onFrameDecoded` callback on
`buildLiveBrowserElement` hands each pre-decoded `HTMLImageElement`
upstream so the surface (apps/web) routes it to the renderer's
`setSlabScreencastImage`.

**apps/web wiring.** `openLiveBrowserSlabItem` adds
`onFrameDecoded: (image) => renderer.setSlabScreencastImage?.(image)`
to the slab item payload; `dissolveLiveBrowserSlabItem` calls
`renderer.clearSlabScreencast?.()` so a subsequent session opens
against a clean slate.

**Other slab kinds (chat cards, fetch cards, memory cards) stay
CSS3D.** The texture path earned its keep specifically for the
screencast — JPEG bitstream is the natural texture-map shape. Rich
HTML cards keep their CSS3D rendering until a second consumer
shows the same seam (three-consumer threshold).

**Tests**

- 6 new SlabManager tests in `slab.test.ts`: hidden-by-default,
  setScreencastImage shows mesh + populates map, in-place image
  swap (single texture across frames), clearScreencast hides +
  disposes, idempotent clear, ImageBitmap close-on-replace.
- 3 new `live-browser.test.ts` tests: img is opacity:0 + display
  block, `onFrameDecoded` fires after `Image.decode()` resolves
  with the decoded image, jsdom fallback path passes the visible
  img.

83 slab / 15 live-browser / 376 web tests pass; all 69 drift
defenses clean.

Sibling-anchored design note: the doctrine comment at
`slab.ts:137` already anticipated this slice as "step 3 of the
volume arc — content as a back-pane texture so it refracts
through the front" once the geometry depth was in place. This
commit cashes that in.
