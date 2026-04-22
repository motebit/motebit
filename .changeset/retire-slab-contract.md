---
"@motebit/render-engine": minor
---

Retire the "Motebit Computer" (slab) scene-primitive contract.

The types and doctrine shipped as a contract to pin cross-surface
variants before any renderer was written. No consumer on the main
branch ever imported them; the concrete implementations only ever
landed on an unshipped exploration branch. On review, the metaphor
(liquid-glass plane, surface-tension pinch, six embodiment modes)
was framing around a product shape the market now ships under
plainer names without the metaphoric overhead. The motebit-unique
layers — sovereign identity, self-verifiable receipts, peer
delegation, governance at the boundary — sit above whichever
execution mode is active and don't need a bespoke scene primitive
to express themselves.

Removed from `@motebit/render-engine`:

- `SlabItemKind`, `SlabItemPhase`, `SlabItemSpec`, `SlabItemHandle`.
- Optional `RenderAdapter` methods: `addSlabItem`, `dissolveSlabItem`,
  `detachSlabItemAsArtifact`, `clearSlabItems`.

Removed from the tree:

- `docs/doctrine/motebit-computer.md`.
- Doctrine index line in root `CLAUDE.md`.

The agent-workstation surface will return as a concrete product —
spec'd from shipping code rather than ahead of it.

The original exploration is archived at tag
`motebit-computer-exploration-2026-04-21` and the original contract
at commit `c12dc462b35fd460d6642b581b548d6a6286b33e`. Both stay
reachable for reference.
