/**
 * Desktop color presets — the named interior colors that the user can pick
 * from in the appearance settings.
 *
 * Extracted from `index.ts` so that `renderer-commands.ts` can import the
 * preset table without depending on the DesktopApp god class. The constant
 * is re-exported from `index.ts` for backwards compat — every existing
 * `import { COLOR_PRESETS } from "./index.js"` consumer keeps working.
 *
 * Each preset is a `tint` (the base color of the glass droplet) plus a
 * `glow` (the emissive color radiating from the interior). Both are RGB
 * triples in 0-1 space, matching `@motebit/render-engine`'s
 * `InteriorColor` type.
 */

import type { InteriorColor } from "@motebit/runtime";

export const COLOR_PRESETS: Record<string, InteriorColor> = {
  moonlight: { tint: [0.95, 0.95, 1.0], glow: [0.8, 0.85, 1.0] },
  amber: { tint: [1.0, 0.85, 0.6], glow: [0.9, 0.7, 0.3] },
  rose: { tint: [1.0, 0.82, 0.88], glow: [0.9, 0.5, 0.6] },
  violet: { tint: [0.88, 0.8, 1.0], glow: [0.6, 0.4, 0.9] },
  cyan: { tint: [0.8, 0.95, 1.0], glow: [0.3, 0.8, 0.9] },
  ember: { tint: [1.0, 0.75, 0.65], glow: [0.9, 0.35, 0.2] },
  sage: { tint: [0.82, 0.95, 0.85], glow: [0.4, 0.75, 0.5] },
};
