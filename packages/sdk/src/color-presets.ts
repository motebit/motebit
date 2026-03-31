/**
 * Shared color presets for the creature's interior.
 *
 * Canonical source — imported by all surfaces (web, desktop, mobile, spatial).
 * The InteriorColor shape matches @motebit/render-engine but is defined inline
 * here so the SDK stays Layer 0 with zero non-protocol deps.
 */

/** Interior color of the droplet creature — tint (glass absorption) + glow (emissive). */
export interface InteriorColor {
  tint: [number, number, number];
  glow: [number, number, number];
}

export const COLOR_PRESETS: Record<string, InteriorColor> = {
  moonlight: { tint: [0.95, 0.95, 1.0], glow: [0.8, 0.85, 1.0] },
  amber: { tint: [1.0, 0.85, 0.6], glow: [0.9, 0.7, 0.3] },
  rose: { tint: [1.0, 0.82, 0.88], glow: [0.9, 0.5, 0.6] },
  violet: { tint: [0.88, 0.8, 1.0], glow: [0.6, 0.4, 0.9] },
  cyan: { tint: [0.8, 0.95, 1.0], glow: [0.3, 0.8, 0.9] },
  ember: { tint: [1.0, 0.75, 0.65], glow: [0.9, 0.35, 0.2] },
  sage: { tint: [0.82, 0.95, 0.85], glow: [0.4, 0.75, 0.5] },
};
