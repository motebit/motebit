# Design ratios

One rule: **aspect-ratio decisions for droplet-family surfaces default to the golden ratio (φ ≈ 1.618) unless physics dictates otherwise.**

The canonical constant is `GOLDEN_RATIO`, exported from [`@motebit/render-engine`](../../packages/render-engine/src/design-ratios.ts). New consumers import it; nobody hardcodes `1.618`, nobody redefines the constant, nobody picks a near-φ number and hopes for the best.

## The rule, stated twice

**For visual primitives in the droplet family** — slab, artifact cards, constellation clusters, typography scale, and anything downstream that inherits the Liquid Glass material lineage — when a designer or engineer has to pick an aspect ratio, the default is φ. `width / GOLDEN_RATIO` gives height; `height * GOLDEN_RATIO` gives width; `1 / GOLDEN_RATIO` gives the conjugate (≈ 0.618) for modular scales (type sizes, nested-panel hierarchy).

**Physics beats aesthetics where they conflict.** The creature droplet is an oblate sphere under surface tension; its `base_radius: 0.14, height: 0.12` (ratio ≈ 1.167) comes from the Rayleigh–Plateau eigenmode that gives the droplet its breathing rhythm. Forcing φ there would stop reading as a droplet. The rule does not apply to:

- The creature itself (droplet physics)
- System-native tokens (16px Apple HIG tap targets, 8pt grid snapping)
- Data or network shapes (no visual dimension)
- One-shot debug / devtool overlays (utility, not family)

When physics or platform tokens pin a dimension, use them. When a dimension is a free aesthetic choice, use φ.

## Why a named constant, and not a magic number

The motebit codebase has a pattern: when a value has a role across the family, the role gets a name. Permissive-floor is a role, Apache-2.0 is an instance. Cryptosuite is a role, Ed25519 is an instance. Tool-policy is a role, each tool is a row. φ as "the aspect ratio for the droplet family" is a role, not a number the next engineer has to recognize from a math-literacy test.

Leaving φ as `1.618` (or worse, `0.54 / 0.34`) in the source scatters the design language. The next consumer — the first real artifact card, the first constellation cluster, the first call site that reaches for an aspect — either copy-pastes the magic number (invisible duplication) or hardcodes a different one (silent drift). Naming it closes both failure modes with one line.

This is the same synchronization-invariant meta-principle that governs the rest of the codebase: when a canonical source exists, everyone consumes it; when it doesn't, things drift silently.

## Current consumers

- [`packages/render-engine/src/slab.ts`](../../packages/render-engine/src/slab.ts) — `SLAB_HEIGHT = SLAB_WIDTH / GOLDEN_RATIO`

## Expected future consumers

These are architecturally inevitable, not speculative:

- Artifact cards (`packages/render-engine/src/artifacts.ts`) — doctrine ([`motebit-computer.md`](motebit-computer.md) §"Detachment") frames them as graduates of slab items; they inherit the family.
- Constellation clusters — when they gain visual sizing.
- Typography scale across surfaces — modular scale stepping by φ and 1/φ.

When these land, they import `GOLDEN_RATIO` from `@motebit/render-engine` and compute from it. They do not restate the rule, redefine the constant, or pick a near-φ alternative.

## Escape hatch

If a consumer believes φ is wrong for its case, the burden of proof is on the consumer, not the constant. The consumer documents which physics / platform token / measurable constraint dictates the different number, either in a JSDoc on the dimension or in a doctrine doc of its own. "It looked better at 1.5" is not a constraint; "Apple HIG requires 44pt tap target" is.

## References

- [`packages/render-engine/src/design-ratios.ts`](../../packages/render-engine/src/design-ratios.ts) — the canonical module
- [`motebit-computer.md`](motebit-computer.md) §"Visual properties (binding)" — the slab's aspect is the first application
- [`DROPLET.md`](../../DROPLET.md) — the physics lineage the family inherits from
