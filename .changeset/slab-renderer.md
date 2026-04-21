---
"@motebit/render-engine": minor
---

Pass 2 of the Motebit Computer (slab) implementation — Three.js
`SlabManager` rendering the liquid-glass plane + items in the
creature's scene.

What it renders:

- A `THREE.Mesh` plane using `MeshPhysicalMaterial` that inherits
  the creature's IOR / roughness / transmission / tint from
  `CANONICAL_MATERIAL` (one body, one material).
- The plane floats to the creature's right at a held-tablet pose
  (~12° forward, ~5° yaw toward the creature) and hangs off the
  creature's scene group so drift/sag/bob are inherited.
- Sympathetic breathing — ~0.3 Hz, 30% of the creature's amplitude,
  locked in phase by reading the same `t` the creature does.
- Items mount via `CSS2DObject` on the plane surface (same pattern
  as `ArtifactManager`), stacked vertically from the top edge.
- Phase animations: emerge (scale + opacity easing), active (steady),
  dissolve (inverse of emerge), pinch placeholder (Pass 3 replaces
  with Rayleigh–Plateau vertex displacement).
- Ambient: invisible before any item ever opens; active while items
  are present; idle (meniscus-only) between items; recessed
  (near-invisible) after a 10s idle window.

`ThreeJSAdapter` wires `addSlabItem` / `dissolveSlabItem` /
`detachSlabItemAsArtifact` / `clearSlabItems` through to the manager.
Detach routes graduated items through the existing `ArtifactManager`
so slab-spawned artifacts settle in the same spatial canvas as any
other artifact.

12 new tests for SlabManager covering lifecycle, phase transitions,
detach handler plumbing, plane visibility curve (pre-first-item,
active, idle, recessed), and listener exception isolation. 261
render-engine tests + 612 runtime tests + 28 drift gates pass.

Pass 3 (pinch physics + sibling-surface wiring) next.
