/**
 * Canonical design ratios for body-adjacent display surfaces in
 * motebit's droplet/material family.
 *
 * Doctrine: [`docs/doctrine/design-ratios.md`](../../../docs/doctrine/design-ratios.md).
 * The one rule: aspect-ratio decisions for body-adjacent display
 * surfaces in the droplet/material family default to the golden
 * ratio unless a stronger governing law applies.
 *
 * This is the intended design law beginning with the slab and
 * expected to govern its direct descendants (artifact cards,
 * constellation clusters when they gain explicit aspect ratios) —
 * named now so the next consumer has a canonical default rather
 * than a fresh design guess.
 *
 * Explicitly NOT governed by this rule:
 *   - the creature itself (droplet physics — Rayleigh–Plateau)
 *   - physics-derived deformations (pinch, breathing, surface tension)
 *   - typography scale (classical modular scale; may share the
 *     constant but is governed by its own rule if adopted)
 *   - system-native tokens (Apple HIG tap targets, platform grids)
 *   - data / network shapes (no visual dimension)
 *
 * Why a named module: without it, φ shows up as a magic number in
 * one file and the next consumer either copy-pastes, hardcodes a
 * near-φ alternative, or extracts after the fact. Naming it closes
 * the drift before it starts — same shape as the tool-policy
 * registry, cryptosuite registry, and the permissive-floor role.
 */

/**
 * Golden ratio (φ) — (1 + √5) / 2 ≈ 1.61803.
 *
 * Use as the default aspect ratio for body-adjacent display
 * surfaces in the droplet/material family. `width / GOLDEN_RATIO`
 * gives height; `height * GOLDEN_RATIO` gives width; `1 /
 * GOLDEN_RATIO` gives the conjugate (≈ 0.618) for proportional
 * stepping.
 *
 * See the module-level JSDoc above for what the rule does NOT
 * govern; the doctrine file lists the full escape hatch.
 */
export const GOLDEN_RATIO = (1 + Math.sqrt(5)) / 2;
