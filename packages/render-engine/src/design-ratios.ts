/**
 * Canonical design ratios for droplet-family visual primitives.
 *
 * Doctrine: `docs/doctrine/design-ratios.md`. The one rule: aspect-
 * ratio decisions for motebit's droplet-family surfaces (slab,
 * artifact cards, constellation clusters, typography scales)
 * default to the golden ratio unless physics dictates otherwise.
 * The creature is physics-driven (oblate droplet under surface
 * tension) and does not follow this rule; everything downstream
 * of the creature that has an aspect decision to make defaults
 * here.
 *
 * Why a named module: without it, φ shows up as a magic number in
 * one file (`slab.ts`) and the next consumer (artifact cards,
 * constellation clusters) either copy-pastes, hardcodes a different
 * ratio, or extracts after the fact. Naming the constant now closes
 * the drift before it starts — same shape as the tool-policy
 * registry, cryptosuite registry, and the permissive-floor role:
 * when a ratio has a role across the family, the role gets a name.
 */

/**
 * Golden ratio (φ) — (1 + √5) / 2 ≈ 1.61803.
 *
 * Use as the default aspect ratio for droplet-family surfaces.
 * `width / GOLDEN_RATIO` gives height; `height * GOLDEN_RATIO`
 * gives width; `1 / GOLDEN_RATIO` gives the conjugate (≈ 0.618)
 * for modular scales (type sizes, nested-panel hierarchy).
 *
 * Physics-driven dimensions (creature radius vs height, droplet
 * breathing eigenmode amplitudes) are NOT governed by this rule —
 * the doctrine is explicit that physics beats aesthetics where
 * they conflict.
 */
export const GOLDEN_RATIO = (1 + Math.sqrt(5)) / 2;
