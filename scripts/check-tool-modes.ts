/**
 * Tool-mode drift gate (invariant #36).
 *
 * Enforces: every ToolDefinition literal in scanned source declares a
 * "mode" field. The field drives the registry sort (api → ax → pixels
 * → undeclared) that structurally biases the AI toward cheaper,
 * more-structured tools. An unannotated tool sorts to the bottom —
 * functionally safe, but a silent leak in the "hybrid engine" doctrine:
 * the author of the new tool didn't have to think about its cost tier.
 * This gate forces the thinking.
 *
 * ## Why this gate exists
 *
 * The motebit can satisfy many intents three ways: API (MCP, tools),
 * AX tree (Reader, virtual-browser), or pixels (computer). Pixels
 * cost ~30k tokens per frame even downscaled; APIs cost KBs. Without
 * a structural preference, the AI picks by prompt reasoning alone and
 * reaches for screenshots when an MCP tool would've answered. The
 * registry sort is the structural lever: list cheapest-first, the
 * model defaults correct. But the sort is only as good as the
 * annotations. If a new builtin ships without a mode tag it sorts
 * to the bottom silently. This gate prevents that drift.
 *
 * ## What this scans
 *
 * Every export const <name>Definition: ToolDefinition = { ... } in:
 *   - packages/tools/src/builtins/ (all .ts files)
 *   - apps/desktop/src/tauri-tools.ts
 *
 * Each must contain "mode" inside its object literal. The regex is
 * name-anchored to the Definition declaration so an inline "mode"
 * further down in the file (e.g. a redaction.mode) doesn't count.
 *
 * MCP-imported tools default to mode: "api" in mcp-client/src/index.ts
 * and don't appear in the scan (they're constructed, not literal).
 *
 * ## Usage
 *
 *   tsx scripts/check-tool-modes.ts       # exit 1 on any missing tag
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

interface Violation {
  file: string;
  definition: string;
}

/**
 * Files that are allowed to define a ToolDefinition without a mode tag.
 * Each entry needs a reason — the gate is only useful if the allowlist
 * is rare. Empty today; add with justification when a legitimate
 * exception appears (e.g. a test fixture that deliberately omits
 * the field to exercise the untagged-sort path).
 */
const ALLOWLIST: ReadonlyArray<{ file: string; definition: string; reason: string }> = [];

function walkTypeScript(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (
      entry === "node_modules" ||
      entry === "dist" ||
      entry === "__tests__" ||
      entry === ".turbo"
    ) {
      continue;
    }
    const full = join(dir, entry);
    let s;
    try {
      s = statSync(full);
    } catch {
      continue;
    }
    if (s.isDirectory()) {
      out.push(...walkTypeScript(full));
    } else if (
      (entry.endsWith(".ts") || entry.endsWith(".tsx")) &&
      !entry.endsWith(".d.ts") &&
      !entry.endsWith(".test.ts")
    ) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Extract every ToolDefinition object literal from a source file.
 * Returns the matched range (definition name + literal body) so the
 * caller can check for "mode" inside.
 *
 * Regex matches either:
 *   export const fooDefinition: ToolDefinition = { ... };
 *   export const fooDefinition: ToolDefinition = { ... }
 *
 * Brace matching is greedy-balanced: we walk forward from the opening
 * brace counting { and } so nested object literals (inputSchema,
 * riskHint, etc.) are covered.
 */
function extractToolDefinitions(source: string): Array<{ name: string; body: string }> {
  const out: Array<{ name: string; body: string }> = [];
  const decl = /export\s+const\s+(\w+Definition)\s*:\s*ToolDefinition\s*=\s*\{/g;
  let match: RegExpExecArray | null;
  while ((match = decl.exec(source)) !== null) {
    const name = match[1]!;
    const openIdx = source.indexOf("{", match.index);
    if (openIdx === -1) continue;
    let depth = 1;
    let i = openIdx + 1;
    while (i < source.length && depth > 0) {
      const ch = source[i];
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
      i++;
    }
    if (depth === 0) {
      out.push({ name, body: source.slice(openIdx, i) });
    }
  }
  return out;
}

function scan(): Violation[] {
  const violations: Violation[] = [];
  const allowed = new Set(ALLOWLIST.map((e) => `${e.file}:${e.definition}`));

  const roots = [join(ROOT, "packages/tools/src/builtins"), join(ROOT, "apps/desktop/src")];

  for (const root of roots) {
    const files = walkTypeScript(root);
    for (const file of files) {
      const rel = relative(ROOT, file);
      const source = readFileSync(file, "utf8");
      const defs = extractToolDefinitions(source);
      for (const def of defs) {
        if (allowed.has(`${rel}:${def.name}`)) continue;
        // A "mode" field at the top level of the literal body. The
        // regex is deliberately loose — any occurrence of "mode"
        // inside the literal is enough; it's highly unlikely a nested
        // field is called "mode" coincidentally.
        if (!/\bmode\s*:/.test(def.body)) {
          violations.push({ file: rel, definition: def.name });
        }
      }
    }
  }
  return violations;
}

function main(): void {
  console.log(
    '▸ check-tool-modes — every `ToolDefinition` literal declares a `mode: "api" | "ax" | "pixels"` field so the registry\'s cost-tier sort (api → ax → pixels → undeclared) lands the AI\'s default choice on the cheapest structured tool that can answer (invariant #36, added 2026-04-22 as the hybrid-engine enforcement — structural bias, not prompt reasoning, keeps the AI from reaching for pixel screenshots when an MCP tool would\'ve answered in 500 tokens)',
  );
  const violations = scan();
  if (violations.length === 0) {
    console.log(
      `✓ check-tool-modes: every scanned ToolDefinition declares a mode (allowlist: ${ALLOWLIST.length}).`,
    );
    process.exit(0);
  }

  console.error(`✗ check-tool-modes: ${violations.length} violation(s):\n`);
  for (const v of violations) {
    console.error(`  ${v.file} — ${v.definition}`);
  }
  console.error(
    '\nFix: add `mode: "api" | "ax" | "pixels"` to each ToolDefinition literal. See `packages/protocol/src/tool-mode.ts` for the taxonomy. Most new tools are `api`; `pixels` is only for screen-capture / synthetic-input tools like `computer`.',
  );
  console.error(
    "If a file legitimately needs the untagged shape (test fixture, etc.), add it to ALLOWLIST in scripts/check-tool-modes.ts with a reason.",
  );
  process.exit(1);
}

main();
