/**
 * Read a package's declared coverage thresholds out of its `vitest.config.ts`.
 *
 * Two tools need this and both had their own copy of the same regex:
 *
 *     const block = src.match(/thresholds:\s*\{([^}]+)\}/);
 *
 * `[^}]+` stops at the FIRST closing brace, which was fine until per-glob floors
 * arrived (#568 — `"**​/adapters.ts": { statements: 100, … }` alongside the bare
 * axes). After that the capture is order-dependent: if the bare axes come first
 * the parse is right BY LUCK, and if a per-glob entry comes first the tool
 * silently reads the GLOB's numbers as the package's.
 *
 * That is not hypothetical. Adding per-file money floors to the relay (#619)
 * put a glob entry first, and both tools began reading the relay's package
 * thresholds as `42/30/35/44` — the key-rotation file's floor — instead of
 * `77/66/80/78`. Latent, because the relay is not a registry member and only
 * the presence check ran, but a tool that reports the wrong number confidently
 * is worse than one that fails.
 *
 * So the extraction is brace-balanced (find the real end of the block) and then
 * strips nested objects before matching the bare axes. Ordering stops mattering,
 * which is the actual invariant — the previous behaviour depended on a
 * convention nobody had written down.
 */
import { existsSync, readFileSync } from "node:fs";

export const COVERAGE_AXES = ["statements", "branches", "functions", "lines"] as const;
export type CoverageAxis = (typeof COVERAGE_AXES)[number];
export type CoverageThresholds = Record<CoverageAxis, number>;

/**
 * Extract the balanced `thresholds: { … }` body, or `null` if absent.
 * Exported for tests — the brace walk is the part worth pinning.
 */
export function extractThresholdBlock(src: string): string | null {
  const key = src.match(/thresholds:\s*\{/);
  if (key?.index == null) return null;

  const open = src.indexOf("{", key.index);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  return null; // unbalanced — treat as unparseable rather than guess
}

/**
 * Remove nested `{ … }` groups so only the package-level axes remain.
 *
 * Repeatedly drops the innermost braces (a group containing no braces), which
 * handles the one-level-deep per-glob entries the config shape allows and would
 * survive deeper nesting too.
 */
export function stripNestedObjects(body: string): string {
  let out = body;
  let previous: string;
  do {
    previous = out;
    out = out.replace(/\{[^{}]*\}/g, "");
  } while (out !== previous);
  return out;
}

/**
 * The package-level thresholds declared in `configPath`, or `null` when the file
 * is absent or declares no parseable `thresholds` block.
 *
 * Per-glob floors are deliberately excluded: they are a floor for one file, not
 * the package's floor, and conflating them is the bug this module exists for.
 */
export function readPackageThresholds(configPath: string): CoverageThresholds | null {
  if (!existsSync(configPath)) return null;
  const block = extractThresholdBlock(readFileSync(configPath, "utf-8"));
  if (block === null) return null;

  const bare = stripNestedObjects(block);
  const out = {} as CoverageThresholds;
  for (const axis of COVERAGE_AXES) {
    const m = bare.match(new RegExp(`(?:^|[,{\\s])${axis}:\\s*(\\d+(?:\\.\\d+)?)`));
    if (!m) return null;
    out[axis] = Number(m[1]);
  }
  return out;
}

/** The per-glob floors declared alongside the package axes, keyed by glob. */
export function readGlobThresholds(configPath: string): Record<string, CoverageThresholds> {
  if (!existsSync(configPath)) return {};
  const block = extractThresholdBlock(readFileSync(configPath, "utf-8"));
  if (block === null) return {};

  const out: Record<string, CoverageThresholds> = {};
  for (const m of block.matchAll(/["'`]([^"'`]+)["'`]\s*:\s*\{([^{}]*)\}/g)) {
    const glob = m[1]!;
    const body = m[2]!;
    const floors = {} as CoverageThresholds;
    let complete = true;
    for (const axis of COVERAGE_AXES) {
      const a = body.match(new RegExp(`${axis}:\\s*(\\d+(?:\\.\\d+)?)`));
      if (!a) {
        complete = false;
        break;
      }
      floors[axis] = Number(a[1]);
    }
    if (complete) out[glob] = floors;
  }
  return out;
}
