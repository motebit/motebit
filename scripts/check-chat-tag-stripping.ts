/**
 * Chat tag-stripping primitive boundary.
 *
 * The runtime emits `<thinking>`, `<memory>`, `<state/>` tags and
 * `[EXTERNAL_DATA]` / `[MEMORY_DATA]` prompt-injection boundaries into
 * streaming assistant text. Every surface that renders streaming text
 * (desktop, web, mobile, spatial, cli TUI) must strip them before
 * showing to the user — if the surface renders them raw, the user sees
 * model-internal reasoning and tool-boundary markers as chat content.
 *
 * The canonical primitive lives in `@motebit/ai-core`:
 *
 *   - `stripInternalTags(text)`        — tags + markers, safe for every surface
 *   - `stripPartialActionTag(text)`    — composes `stripInternalTags` + action
 *                                         asterisks + whitespace (desktop-plain-text)
 *
 * Before 2026-04-24, desktop's `stripPartialActionTag` missed `<thinking>`
 * and `[EXTERNAL_DATA]` / `[MEMORY_DATA]` entirely — runtime chunks
 * carrying those markers rendered as visible chat content. Web had its
 * own private copy of the full regex set. The fix was to centralize the
 * primitive; this gate prevents re-drift.
 *
 * Invariant: any file under an apps or services source tree that
 * contains a `.replace(...)` against one of the tag/marker patterns
 * must also import `stripInternalTags` or `stripPartialActionTag` from
 * `@motebit/ai-core`. Inline regex replacements against the pattern set
 * outside the canonical primitive are drift.
 *
 * Doctrine: `docs/doctrine/panels-pattern.md` § "Chat" drift #2.
 * Meta-principle: synchronization invariants — `docs/drift-defenses.md`.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

// ── Scanned trees ────────────────────────────────────────────────────────
// Apps and services — surface-layer code that renders (or forwards)
// streaming assistant text. The `@motebit/ai-core` package itself is
// the canonical home and is excluded.
const SCAN_ROOTS = ["apps", "services"];

// ── Tag / marker patterns to detect ──────────────────────────────────────
// Any `.replace(/pattern/...)` whose pattern contains one of these
// tokens is a tag/marker-stripping inline. The token set is the
// closed list of internal-tag shapes the runtime emits — adding a new
// one to `stripInternalTags` in `@motebit/ai-core` also means adding
// the token here so the gate tracks the primitive.
const STRIP_TOKENS: ReadonlyArray<{ token: string; tag: string }> = [
  { token: "<thinking>", tag: "<thinking>" },
  { token: "<memory", tag: "<memory>" },
  { token: "<state", tag: "<state/>" },
  { token: "[EXTERNAL_DATA", tag: "[EXTERNAL_DATA]" },
  { token: "[MEMORY_DATA", tag: "[MEMORY_DATA]" },
  { token: "[/EXTERNAL_DATA", tag: "[/EXTERNAL_DATA]" },
  { token: "[/MEMORY_DATA", tag: "[/MEMORY_DATA]" },
];

// A file that imports one of the canonical primitives is presumed to be
// using the primitive correctly — inline regex calls in the same file
// are treated as adjacent composition, not drift. This matches the
// pattern used by other primitive-centralization gates in the repo.
const CANONICAL_IMPORTS = [
  /\bstripInternalTags\b[\s\S]{0,200}from\s+["']@motebit\/ai-core["']/,
  /\bstripPartialActionTag\b[\s\S]{0,200}from\s+["']@motebit\/ai-core["']/,
];

// ── Scanner ──────────────────────────────────────────────────────────────

interface Violation {
  tree: string;
  file: string;
  line: number;
  tag: string;
  excerpt: string;
}

function walkTypeScript(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      if (
        entry === "__tests__" ||
        entry === "node_modules" ||
        entry === "dist" ||
        entry === ".next" ||
        entry === "build" ||
        entry === "target" ||
        entry === "src-tauri" ||
        entry === "coverage"
      )
        continue;
      out.push(...walkTypeScript(path));
    } else if (
      (entry.endsWith(".ts") || entry.endsWith(".tsx")) &&
      !entry.endsWith(".test.ts") &&
      !entry.endsWith(".test.tsx") &&
      !entry.endsWith(".d.ts") &&
      !entry.endsWith(".generated.ts")
    ) {
      out.push(path);
    }
  }
  return out;
}

function scanFile(tree: string, file: string): Violation[] {
  const src = readFileSync(file, "utf-8");
  const violations: Violation[] = [];
  const shortPath = relative(ROOT, file);

  // If the file imports the canonical primitive, any co-located regex
  // is composition (e.g. stripInternalTags(text).replace(/extra/...))
  // and not drift. The primitive is the authoritative pass.
  const hasCanonicalImport = CANONICAL_IMPORTS.some((re) => re.test(src));
  if (hasCanonicalImport) return violations;

  // Scan for `.replace(/.../` lines whose regex body contains one of
  // the tag tokens. The regex literal can span a single line in
  // practice; the gate scans line-by-line to keep the report precise.
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Quick filter — only lines that look like a regex replace call
    if (!line.includes(".replace(/")) continue;

    for (const { token, tag } of STRIP_TOKENS) {
      if (line.includes(token)) {
        violations.push({
          tree,
          file: shortPath,
          line: i + 1,
          tag,
          excerpt: line.trim(),
        });
        break; // one violation per line is enough; the file is bad either way
      }
    }
  }

  return violations;
}

function main(): void {
  const all: Violation[] = [];
  for (const tree of SCAN_ROOTS) {
    const treePath = resolve(ROOT, tree);
    let topLevel: string[];
    try {
      topLevel = readdirSync(treePath).filter((entry) => {
        const stat = statSync(join(treePath, entry));
        return stat.isDirectory();
      });
    } catch {
      continue;
    }
    for (const pkgName of topLevel) {
      for (const subdir of ["src", "app"]) {
        const dir = resolve(treePath, pkgName, subdir);
        const files = walkTypeScript(dir);
        for (const file of files) {
          all.push(...scanFile(tree, file));
        }
      }
    }
  }

  if (all.length === 0) {
    console.log(
      `Chat tag-stripping check passed — every inline tag/marker replacement in apps/services either imports the canonical primitive or doesn't exist.`,
    );
    return;
  }

  console.error(`Chat tag-stripping violations (${all.length}):\n`);
  let current = "";
  for (const v of all) {
    const group = `${v.tree}/${v.file.split("/")[1] ?? "?"}`;
    if (group !== current) {
      current = group;
      console.error(`  [${group}]`);
    }
    console.error(`    ${v.file}:${v.line} — inline strip of ${v.tag}`);
    console.error(`      > ${v.excerpt}`);
  }
  console.error(
    `\nDoctrine: tag/marker stripping is a canonical primitive (packages/ai-core/src/core.ts).`,
  );
  console.error(
    `Fix: replace the inline \`.replace(...)\` with \`stripInternalTags(text)\` imported from "@motebit/ai-core".`,
  );
  console.error(
    `If the surface is plain-text and wants the action-asterisk / whitespace pass too, use \`stripPartialActionTag\` instead.`,
  );
  process.exit(1);
}

main();
