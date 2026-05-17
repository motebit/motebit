---
"@motebit/render-engine": minor
"@motebit/web": patch
"@motebit/desktop": patch
---

Slab honesty (part 1) — empty-held membrane register + drag-hover
lift.

The empty user-held slab used to read as a "blank rectangle" at
opacity 0.85 — visually indistinguishable from the active register,
which conflated "the slab is present" with "the slab is working." The
membrane work fixes that asymmetry:

- `MEMBRANE_OPACITY = 0.20` — empty + held slab. Membrane-at-rest. Soul
  tint still attenuates (body coherence with the creature). 0.3Hz
  breathing stays. You can see the creature _through_ the slab. No
  outline, no chrome, no "drop here" text — the surface acknowledges
  the `/computer` invocation by becoming present, not by lighting up.
- `DRAG_HOVER_OPACITY = 0.65` — drag-summoned register. When the user
  starts dragging content over the document, the slab lifts to this
  target so it signals "I can take this" without crossing into the
  active register. Faster ease (rate 6 vs 4) so the slab answers the
  gesture promptly. Override applies whether or not the slab was
  user-held — the active gesture is the strongest intent signal.

`SlabCore.setDragHover(boolean)` + `SlabManager.setDragHover` +
`RenderAdapter.setSlabDragHover` (optional). Apps' drop handlers
(`apps/web/src/ui/drop.ts` + desktop sibling) wire `dragenter` /
`dragover` → true, `drop` / `dragend` / `dragleave-with-no-relatedTarget`
→ false. Document-level listeners; the existing `feedPerception`
routing is unchanged.

Active items still own the plane during drag-hover (no double-lift)
— the drag-hover branch only fires when `activeCount === 0`. 4 new
slab tests cover the membrane/drag-hover/active-precedence states;
all 375 render-engine tests pass; all 69 drift gates green.

Mode-owns-shape (the third item from the slab-honesty list — slab
geometry reshapes per embodiment mode) is deferred until co-browse
forces it. Once the user is _driving_ inside the slab, aspect-ratio
mismatch will start mattering physically (cursor coordinates would
map wrong). That's the implementation pressure that makes the
geometry rework non-speculative.
