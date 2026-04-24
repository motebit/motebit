/**
 * Canonical design ratios for body-adjacent display surfaces in
 * motebit's droplet/material family.
 *
 * The rule (colocated with the code — this module IS the doctrine):
 * aspect-ratio decisions for body-adjacent display surfaces in the
 * droplet/material family default to the golden ratio unless a
 * stronger governing law applies. The slab is the first consumer;
 * artifact cards and constellation clusters, when they gain explicit
 * aspect ratios, are the expected direct descendants. This is
 * proportion discipline, not a protocol-weight doctrine — kept here
 * in a JSDoc rather than elevated to `docs/doctrine/` so the shared
 * constant is discoverable without inflating the signal-to-noise of
 * the hill-to-die-on doctrine list (protocol, security, settlement,
 * self-attesting system).
 *
 * Why a named constant (and not an inline 1.618 per consumer):
 * without it, the first real artifact card either copy-pastes the
 * magic number or hardcodes a near-φ alternative, and the design
 * language drifts silently. One shared constant, imported by every
 * consumer, closes both failure modes. Same shape as the tool-policy
 * registry — when a value has a role across the family, the role
 * gets a name.
 *
 * Explicitly NOT governed by this rule:
 *   - the creature itself (droplet physics — Rayleigh–Plateau)
 *   - physics-derived deformations (pinch, breathing, surface tension)
 *   - typography scale (classical modular scale; may share the
 *     constant but is governed by its own rule if adopted)
 *   - system-native tokens (Apple HIG tap targets, platform grids)
 *   - data / network shapes (no visual dimension)
 *
 * Escape hatch: if a consumer believes φ is wrong for its case, the
 * burden of proof is on the consumer — name the physics / platform
 * token / measurable constraint that dictates the different number.
 * "It looked better at 1.5" is not a constraint; "Apple HIG requires
 * 44pt tap target" is.
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
 * See the module-level JSDoc above for scope and exclusions.
 */
export const GOLDEN_RATIO = (1 + Math.sqrt(5)) / 2;
