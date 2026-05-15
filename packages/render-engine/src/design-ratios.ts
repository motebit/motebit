/**
 * Canonical design constants for body-adjacent display surfaces in
 * motebit's droplet/material family.
 *
 * The rule (colocated with the code — this module IS the doctrine):
 * non-arbitrary dimensions for body-adjacent display surfaces in the
 * droplet/material family default to the constants exported here
 * unless a stronger governing law applies. Two sibling constants
 * today, each with its own scope:
 *
 *   - `GOLDEN_RATIO` (φ) — governs **aspect-ratio** decisions for
 *     body-adjacent display surfaces. Slab uses it (width × φ
 *     proportions); artifact cards and constellation clusters are
 *     the expected direct descendants when they gain explicit
 *     aspect ratios.
 *   - `COHESIVE_RADIUS` — governs **outer-corner-radius** decisions
 *     for body-adjacent display surfaces. The 2D analog of
 *     Liquescentia's cohesive-permeability property ("the meniscus
 *     a droplet has instead of a hard outline"). Side-rail panels,
 *     bottom-sheet modals, and future card primitives derive their
 *     outer-corner radius from this constant so the surface reads
 *     as "has surface tension," not as "window-manager chrome."
 *
 * This is proportion + meniscus discipline, not a protocol-weight
 * doctrine — kept here in a JSDoc rather than elevated to
 * `docs/doctrine/` so the shared constants are discoverable without
 * inflating the signal-to-noise of the hill-to-die-on doctrine list
 * (protocol, security, settlement, self-attesting system).
 *
 * Why named constants (and not an inline 1.618 or 10 per consumer):
 * without them, the first real artifact card either copy-pastes the
 * magic number or hardcodes a near-φ alternative, and the design
 * language drifts silently. One shared constant per role, imported
 * by every consumer, closes both failure modes. Same shape as the
 * tool-policy registry — when a value has a role across the family,
 * the role gets a name.
 *
 * Explicitly NOT governed by these constants:
 *   - the creature itself (droplet physics — Rayleigh–Plateau; the
 *     body is a continuous meniscus curve, not a discrete radius)
 *   - physics-derived deformations (pinch, breathing, surface tension)
 *   - typography scale (classical modular scale; may share φ but is
 *     governed by its own rule if adopted)
 *   - system-native tokens (Apple HIG tap targets, platform grids,
 *     platform-default corner radii for native chrome that
 *     deliberately *isn't* motebit-family)
 *   - inner corners (button radii, chip radii, input pill radii —
 *     those are component-scoped, not surface-scoped; they may use
 *     their own rhythm)
 *   - data / network shapes (no visual dimension)
 *
 * Escape hatch: if a consumer believes one of these is wrong for
 * its case, the burden of proof is on the consumer — name the
 * physics / platform token / measurable constraint that dictates
 * the different number. "It looked better at 1.5 / 14px" is not a
 * constraint; "Apple HIG requires 44pt tap target" is.
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

/**
 * Cohesive radius — 10px, the 2D analog of Liquescentia's
 * cohesive-permeability property (`docs/doctrine/liquescentia-as-substrate.md`).
 *
 * Use as the default outer-corner radius for body-adjacent display
 * surfaces in the droplet/material family. The creature has a
 * continuous meniscus rendered as a physics curve (Rayleigh–Plateau);
 * 2D surfaces (panels, slabs, sheets, cards) echo that meniscus
 * with a small constant radius. Larger reads as iOS-card register
 * ("this is a content card"); zero reads as window-manager chrome
 * ("this is OS chrome that doesn't know about the body"). 10px
 * sits in the middle band — register-correct for "this surface has
 * surface tension."
 *
 * Why 10 specifically (not 8, not 12): 10 is the value at which the
 * outer corner is unambiguously not-90° at typical viewing distance
 * (1m+ on desktop, arm's-length on mobile) while still reading as a
 * gesture toward physics, not as a card chamfer. Apple's macOS
 * sidebar / iPad sheet register sits in the 11-14px band; motebit's
 * calm-software register sits slightly tighter to stay on the
 * meniscus side of the spectrum, not the card side. This is a
 * register pick, not a derivation — there's no closed-form physics
 * answer for "what radius does a 280px-wide panel echo from the
 * creature's meniscus." The value is chosen to put the surface in
 * the right register; the rule is to share it.
 *
 * Use in pixels: `border-radius: ${COHESIVE_RADIUS}px` (CSS) or
 * `borderRadius: COHESIVE_RADIUS` (React Native).
 *
 * Apply to OUTER corners only — the edges that face the
 * scene / body / void. Edges flush against a hard boundary
 * (viewport edge, parent container edge) stay 0 because their
 * "outer" is clipped. A right-sliding side-rail panel rounds
 * top-left + bottom-left, not top-right + bottom-right.
 *
 * Inner corners (button radii, chip pill radii, input radii,
 * card-internal section radii) are NOT governed by this constant —
 * those are component-scoped and may use their own rhythm.
 *
 * See the module-level JSDoc above for full scope and exclusions.
 */
export const COHESIVE_RADIUS = 10;
