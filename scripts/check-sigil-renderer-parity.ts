#!/usr/bin/env tsx
/**
 * `check-sigil-renderer-parity` — sibling-boundary lock for the agent-sigil
 * Ring-3 renderer across DOM surfaces.
 *
 * The agent identity mark ("the face is the key", `docs/doctrine/agents-as-first-person-trust-graph.md`
 * §4) is rendered per-surface, never from shared `@motebit/sdk` (params-not-pixels:
 * the SDK emits sigil PARAMS via `deriveAgentSigil`; each surface emits its own
 * pixels). Web and desktop are both DOM/Chromium surfaces, so their renderers are
 * the SAME SVG-string form — two physical copies:
 *
 *   - `apps/web/src/identity-sigil-svg.ts`
 *   - `apps/desktop/src/ui/agent-sigil.ts`
 *
 * Two copies is a drift hazard (the textbook synchronization-invariant shape:
 * one canonical render, a sibling drifts, the same agent shows a DIFFERENT mark
 * on web vs desktop — recognition breaks). This gate forecloses that: the code
 * region of both files (from `export interface SigilSvgOptions` to EOF) MUST be
 * byte-identical. Only the leading doc-comment (which names the surface) may
 * differ. Mobile (`react-native-svg`) and spatial (3D) are genuinely different
 * media and are NOT siblings here.
 *
 * If a third DOM consumer appears or the duplication becomes painful, the
 * resolution is to promote a shared DOM-render module — at which point this gate
 * is deleted. Until then, duplicate-and-lock is the doctrine-literal choice.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const WEB = "apps/web/src/identity-sigil-svg.ts";
const DESKTOP = "apps/desktop/src/ui/agent-sigil.ts";

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
  const webSrc = readFile(WEB);
  const desktopSrc = readFile(DESKTOP);

  if (webSrc === null || desktopSrc === null) {
    console.error("check-sigil-renderer-parity: could not read both sigil renderer files.");
    if (webSrc === null) console.error(`  missing: ${WEB}`);
    if (desktopSrc === null) console.error(`  missing: ${DESKTOP}`);
    process.exit(1);
  }

  const web = codeRegion(webSrc);
  const desktop = codeRegion(desktopSrc);

  if (web === null || desktop === null) {
    console.error(
      `check-sigil-renderer-parity: could not locate the code region marker \`${REGION_START}\`.`,
    );
    if (web === null) console.error(`  not found in: ${WEB}`);
    if (desktop === null) console.error(`  not found in: ${DESKTOP}`);
    process.exit(1);
  }

  if (web !== desktop) {
    console.error(
      "check-sigil-renderer-parity: the web and desktop agent-sigil renderers have drifted.",
    );
    console.error("");
    console.error(`  ${WEB}`);
    console.error(`  ${DESKTOP}`);
    console.error("");
    console.error(
      `Both files' code region (from \`${REGION_START}\` to EOF) MUST be byte-identical — the`,
    );
    console.error(
      "same agent must render the SAME mark on web and desktop. Update both copies in the same",
    );
    console.error("commit, or promote a shared DOM-render module and delete this gate.");
    // Show the first differing line to speed the fix.
    const webLines = web.split("\n");
    const deskLines = desktop.split("\n");
    const max = Math.max(webLines.length, deskLines.length);
    for (let i = 0; i < max; i++) {
      if (webLines[i] !== deskLines[i]) {
        console.error("");
        console.error(`  first divergence at code-region line ${i + 1}:`);
        console.error(`    web:     ${JSON.stringify(webLines[i] ?? "<EOF>")}`);
        console.error(`    desktop: ${JSON.stringify(deskLines[i] ?? "<EOF>")}`);
        break;
      }
    }
    process.exit(1);
  }

  console.log(
    "✓ check-sigil-renderer-parity: web + desktop agent-sigil renderers are byte-identical (code region).",
  );
}

main();
