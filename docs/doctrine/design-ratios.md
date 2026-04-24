# Design ratios

One rule: **aspect-ratio decisions for body-adjacent display surfaces in motebit's droplet/material family default to the golden ratio (φ ≈ 1.618) unless a stronger governing law applies.**

The canonical constant is `GOLDEN_RATIO`, exported from [`@motebit/render-engine`](../../packages/render-engine/src/design-ratios.ts). New consumers import it; nobody hardcodes `1.618`, nobody redefines the constant, nobody picks a near-φ number and hopes for the best.

## What the rule governs

A "body-adjacent display surface" in the droplet/material family is a scene-level visual primitive that (a) shares the creature's Liquid Glass material lineage, and (b) serves as a display / working surface near the creature's body. The slab is the first. Artifact cards, when they become first-class scene primitives, are the expected direct descendants — but their aspect ratio is a design decision that _may_ default to φ under this rule, not a fact the protocol forces.

`width / GOLDEN_RATIO` gives height; `height * GOLDEN_RATIO` gives width; `1 / GOLDEN_RATIO` gives the conjugate (≈ 0.618) for proportional stepping.

## What the rule does NOT govern

The rule is deliberately narrow so it doesn't swallow things governed by different laws:

- **The creature itself** — droplet physics. Its `base_radius: 0.14, height: 0.12` (ratio ≈ 1.167) comes from the Rayleigh–Plateau eigenmode that gives the body its breathing rhythm. Forcing φ there would stop reading as a droplet.
- **Physics-derived deformations** — pinch displacement, sympathetic breathing, surface-tension curves. Bound by the same droplet lineage as the creature.
- **Typography scale** — proportional type stepping (1/φ, 1, φ, φ²) is a classical modular-scale technique, governed by its own rule if and when motebit adopts one. The constant may be shared; the rule is separate.
- **System-native tokens** — 16px Apple HIG tap targets, 8pt grid snapping, native platform scroll physics.
- **Data or network shapes** — no visual dimension to govern.
- **One-shot debug / devtool overlays** — utility, not family.

When physics or platform tokens pin a dimension, use them. When a dimension is a free aesthetic choice for a body-adjacent display surface, φ is the default.

## Why a named constant, and not a magic number

Motebit's architecture pattern: when a value has a role across the family, the role gets a name. Permissive-floor is a role, Apache-2.0 is an instance. Cryptosuite is a role, Ed25519 is an instance. Tool-policy is a role, each tool is a row. φ as "the aspect ratio for body-adjacent display surfaces in the droplet family" is a role, not a number the next engineer has to recognize from a math-literacy test.

Leaving φ as `1.618` (or worse, `0.54 / 0.34`) in the source scatters the design language. The first real artifact card will either copy-paste the magic number (invisible duplication) or hardcode a different one (silent drift). Naming it closes both failure modes with one line.

This is the same synchronization-invariant meta-principle that governs the rest of the codebase: when a canonical source exists, everyone consumes it; when it doesn't, things drift silently.

## Current consumers

- [`packages/render-engine/src/slab.ts`](../../packages/render-engine/src/slab.ts) — `SLAB_HEIGHT = SLAB_WIDTH / GOLDEN_RATIO`

## Expected descendants

This is the _intended design law beginning with the slab and expected to govern its direct descendants_ — not a claim that every future consumer is architecturally inevitable. Named so the next consumer has a canonical default rather than a fresh design guess:

- Artifact cards (`packages/render-engine/src/artifacts.ts`) — [`motebit-computer.md`](motebit-computer.md) §"Detachment" frames them as graduates of slab items. When they gain an explicit aspect ratio, this rule is the default.
- Constellation clusters — when they gain visual sizing in the scene.

When these land, they import `GOLDEN_RATIO` from `@motebit/render-engine` and compute from it.

## Escape hatch

If a consumer believes φ is wrong for its case, the burden of proof is on the consumer, not the constant. The consumer documents which physics / platform token / measurable constraint dictates the different number, either in a JSDoc on the dimension or in a doctrine doc of its own. "It looked better at 1.5" is not a constraint; "Apple HIG requires 44pt tap target" is.

## References

- [`packages/render-engine/src/design-ratios.ts`](../../packages/render-engine/src/design-ratios.ts) — the canonical module
- [`motebit-computer.md`](motebit-computer.md) §"Visual properties (binding)" — the slab's aspect is the first application
- [`DROPLET.md`](../../DROPLET.md) — the physics lineage the droplet family inherits from
