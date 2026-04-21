---
"@motebit/runtime": minor
---

Add `bindSlabControllerToRenderer` — surface-neutral subscription
bridge that wires a `SlabController` (runtime) to any renderer that
implements the slab surface of `RenderAdapter` (render-engine).

The bridge owns the diff:

- New items → `renderer.addSlabItem({id, kind, element})` where the
  caller's `renderItem(item)` produces the element.
- Payload-only changes on phase-stable items → optional
  `updateItem(item, element)` mutates in place.
- Transition to `pinching` with a `__slabDetach` payload marker →
  `renderer.detachSlabItemAsArtifact(id, artifactSpec)`. If the
  optional `renderDetachArtifact` factory is missing OR throws, the
  bridge falls back to dissolution — no silent failure.
- Transition to `dissolving` → `renderer.dissolveSlabItem(id)`.

Surfaces supply per-item-kind factories and never reimplement the
diff. `renderItem` exceptions are logged + the item is abandoned
(not retried on every state emit, which was the naïve shape). The
bridge also guards against double-emission of terminal transitions:
once an item enters pinching or dissolving, further emissions are
suppressed at the bridge layer regardless of downstream timing.

Zero dependency on `@motebit/render-engine` — the renderer's slab
surface is declared inline as `SlabRendererTarget`, so the bridge
stays nominal and render-engine-swappable. The runtime package owns
the semantics; renderers obey.

13 new tests covering mount/unmount, payload diff, dissolve path,
detach-with-and-without-renderer, exception isolation, double-
transition guards, and idempotent unsubscribe. 625 runtime tests +
28 drift gates pass.

Next: wire this bridge into the web surface's bootstrap so slab
items actually render on motebit.com.
