---
"@motebit/render-engine": minor
---

Add the "Motebit Computer" (slab) scene-primitive contract: the
liquid-glass working surface floating next to the creature where
acts-in-progress materialize, and from which durable outputs detach as
artifacts via a surface-tension pinch.

New exports from `@motebit/render-engine`:

- `SlabItemKind` — procedural categories of live work: `stream` |
  `tool_call` | `plan_step` | `shell` | `fetch` | `embedding`.
- `SlabItemPhase` — lifecycle phases, with `pinching` and `detached`
  as typed phases (not private animation details) so cross-surface
  renderers can't silently diverge on the detachment physics.
- `SlabItemSpec` — the surface-native HTMLElement host-pattern, same
  shape as `ArtifactSpec` so renderers stay Three.js-free.
- `SlabItemHandle` — `getPhase()` + `onPhaseChange(listener)` for
  lifecycle coordination.

New optional methods on `RenderAdapter`:

- `addSlabItem(spec) → handle` — place an item on the slab.
- `dissolveSlabItem(id)` — fade back into the surface with no artifact
  spawn (ephemeral end, interrupt, failure).
- `detachSlabItemAsArtifact(id, artifact)` — run the pinch physics
  (dimple → bead → Rayleigh–Plateau snap) and return the artifact
  handle the detached bead settles into.
- `clearSlabItems()` — immediate clear, no animation.

Doctrine: `docs/doctrine/motebit-computer.md`. Indexed in root
CLAUDE.md. Concrete Three.js implementation per surface lands in
follow-up commits; the contract is what ensures they don't drift.
