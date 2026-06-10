#!/usr/bin/env tsx
/**
 * Surface-controller adoption gate.
 *
 * Surface controllers that have been extracted to `@motebit/surface-kit`
 * (state + actions shared across flat surfaces) MUST be consumed from the
 * package by every adopting surface — never re-forked locally. Before the
 * extraction these controllers existed as per-surface copies that drifted
 * (`MobileMcpManager` / `SpatialMcpManager`: identical lifecycle, different
 * storage + naming). This gate is the synchronization-invariant defense that
 * keeps them from re-forking: each adopting surface's controller file must
 * import the canonical class from `@motebit/surface-kit` and stay a THIN
 * adapter (inject platform ports, no re-declared logic).
 *
 * Adding a controller to the package, or a surface to its adopters, is one
 * entry in ADOPTIONS below — the registry update is the discipline trigger.
 *
 * Out of scope (documented forks, not silent ones): the desktop MCP manager
 * is the stdio superset and is reconciled in a follow-up; CLI has no MCP
 * manager. They are absent from ADOPTIONS by intent, not omission.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");

interface Adoption {
  /** The canonical export in @motebit/surface-kit. */
  controller: string;
  /** Surface controller files that must consume it (relative to repo root). */
  files: string[];
  /** Thin-adapter line ceiling — a re-forked implementation blows past this. */
  maxLines: number;
}

const ADOPTIONS: readonly Adoption[] = [
  {
    controller: "McpManager",
    files: ["apps/mobile/src/mcp-manager.ts", "apps/spatial/src/mcp-manager.ts"],
    maxLines: 60,
  },
];

const errors: string[] = [];

for (const adoption of ADOPTIONS) {
  for (const rel of adoption.files) {
    const abs = join(ROOT, rel);
    if (!existsSync(abs)) {
      errors.push(`${rel}: missing — expected a thin ${adoption.controller} adapter here.`);
      continue;
    }
    const src = readFileSync(abs, "utf8");

    // 1. Must import the canonical controller from the package.
    const importsPackage =
      /from\s+["']@motebit\/surface-kit["']/.test(src) &&
      new RegExp(`\\b${adoption.controller}\\b`).test(src);
    if (!importsPackage) {
      errors.push(
        `${rel}: does not import { ${adoption.controller} } from "@motebit/surface-kit" — ` +
          `surface controllers must be consumed from the package, never re-forked locally.`,
      );
    }

    // 2. Must stay a thin adapter — a re-implemented controller grows past the
    //    ceiling (the extracted core is ~250 lines; an adapter is ~40).
    const lineCount = src.split("\n").length;
    if (lineCount > adoption.maxLines) {
      errors.push(
        `${rel}: ${lineCount} lines exceeds the thin-adapter ceiling (${adoption.maxLines}). ` +
          `If logic is creeping back into the surface, push it into @motebit/surface-kit instead.`,
      );
    }
  }
}

if (errors.length > 0) {
  console.error("✗ Surface-controller adoption check failed:\n");
  for (const e of errors) console.error(`  - ${e}`);
  console.error(
    `\n${ADOPTIONS.length} controller(s) checked across ${ADOPTIONS.reduce((n, a) => n + a.files.length, 0)} surface file(s).`,
  );
  process.exit(1);
}

console.log(
  `Surface-controller adoption check passed — ${ADOPTIONS.length} controller(s) consumed from @motebit/surface-kit across ${ADOPTIONS.reduce((n, a) => n + a.files.length, 0)} surface file(s).`,
);
