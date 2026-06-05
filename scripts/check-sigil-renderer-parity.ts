#!/usr/bin/env tsx
/**
 * `check-sigil-renderer-parity` — sibling-boundary lock for the agent-sigil
 * Ring-3 renderer across DOM surfaces.
 *
 * The agent identity mark ("the face is the key", `docs/doctrine/agents-as-first-person-trust-graph.md`
 * §4) is rendered per-surface, never from shared `@motebit/sdk` (params-not-pixels:
 * the SDK emits sigil PARAMS via `deriveAgentSigil`; each surface emits its own
 * pixels). All three flat surfaces render the SAME SVG-string form — web + desktop
 * paint it in the DOM, mobile paints it via react-native-svg's `SvgXml` — so each
 * carries a physical copy of the renderer:
 *
 *   - `apps/web/src/identity-sigil-svg.ts`
 *   - `apps/desktop/src/ui/agent-sigil.ts`
 *   - `apps/mobile/src/components/agent-sigil.tsx` (header wraps the region in `SvgXml`)
 *
 * Three copies is a drift hazard (the textbook synchronization-invariant shape:
 * one canonical render, a sibling drifts, the same agent shows a DIFFERENT mark
 * across surfaces — recognition breaks). This gate forecloses that: the code
 * region of every file (from `export interface SigilSvgOptions` to EOF) MUST be
 * byte-identical. Only the leading header (which names the surface and, on mobile,
 * carries the `SvgXml` wrapper) may differ. Spatial (3D) is a genuinely different
 * medium — it renders the droplet from the same PARAMS, not the SVG string — and
 * is NOT a sibling here.
 *
 * If the duplication becomes painful, the resolution is to promote a shared
 * render module — at which point this gate is deleted. Until then,
 * duplicate-and-lock is the doctrine-literal choice.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

/**
 * The surfaces that share the SVG-string sigil renderer. Web + desktop are
 * DOM/Chromium; mobile is react-native-svg's `SvgXml`, which paints the SAME
 * SVG string (so the same agent shows the same mark on every flat surface).
 * All three carry a byte-identical code region; only the leading header (the
 * per-surface wrapper / imports) may differ.
 */
const SURFACES = [
  "apps/web/src/identity-sigil-svg.ts",
  "apps/desktop/src/ui/agent-sigil.ts",
  "apps/mobile/src/components/agent-sigil.tsx",
] as const;

/** The shared marker — everything from this line to EOF is the locked code region. */
const REGION_START = "export interface SigilSvgOptions";

function readFile(path: string): string | null {
  try {
    return readFileSync(resolve(ROOT, path), "utf8");
  } catch {
    return null;
  }
}

/** The code region from the first `REGION_START` line to EOF (drops the surface-specific header). */
function codeRegion(src: string): string | null {
  const idx = src.indexOf(REGION_START);
  if (idx === -1) return null;
  // Normalize trailing whitespace so an editor's final-newline difference
  // doesn't read as drift; the meaningful bytes are the code itself.
  return src.slice(idx).replace(/\s+$/, "");
}

function main(): void {
  // Read + extract the locked region from every surface.
  const regions: Array<{ file: string; region: string }> = [];
  for (const file of SURFACES) {
    const src = readFile(file);
    if (src === null) {
      console.error(`check-sigil-renderer-parity: could not read sigil renderer file ${file}.`);
      process.exit(1);
    }
    const region = codeRegion(src);
    if (region === null) {
      console.error(
        `check-sigil-renderer-parity: could not locate the code region marker \`${REGION_START}\` in ${file}.`,
      );
      process.exit(1);
    }
    regions.push({ file, region });
  }

  // Compare every surface to the first (web, the canonical copy).
  const canonical = regions[0]!;
  for (const other of regions.slice(1)) {
    if (other.region === canonical.region) continue;
    console.error(
      `check-sigil-renderer-parity: the agent-sigil renderer has drifted between surfaces.`,
    );
    console.error("");
    console.error(`  canonical: ${canonical.file}`);
    console.error(`  drifted:   ${other.file}`);
    console.error("");
    console.error(
      `Every surface's code region (from \`${REGION_START}\` to EOF) MUST be byte-identical — the`,
    );
    console.error(
      "same agent must render the SAME mark on web, desktop, and mobile. Update all copies in the",
    );
    console.error("same commit, or promote a shared render module and delete this gate.");
    const aLines = canonical.region.split("\n");
    const bLines = other.region.split("\n");
    const max = Math.max(aLines.length, bLines.length);
    for (let i = 0; i < max; i++) {
      if (aLines[i] !== bLines[i]) {
        console.error("");
        console.error(`  first divergence at code-region line ${i + 1}:`);
        console.error(`    ${canonical.file}: ${JSON.stringify(aLines[i] ?? "<EOF>")}`);
        console.error(`    ${other.file}: ${JSON.stringify(bLines[i] ?? "<EOF>")}`);
        break;
      }
    }
    process.exit(1);
  }

  console.log(
    `✓ check-sigil-renderer-parity: ${SURFACES.length} agent-sigil renderers (web + desktop + mobile) are byte-identical (code region).`,
  );
}

main();
