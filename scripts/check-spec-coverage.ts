#!/usr/bin/env tsx
/**
 * check-spec-coverage — hard drift defense for spec ↔ protocol type alignment.
 *
 * Each `spec/*.md` file may declare one or more "Wire format (foundation law)"
 * subsections. Anything named in such a subsection is binding vocabulary that
 * every conforming implementation must emit or accept, so the MIT type package
 * `@motebit/protocol` must export a matching name. If it does not, the spec is
 * describing a type no implementation can reference — a drift the existing
 * `check-spec-references` probe cannot catch.
 *
 * What this probe enforces:
 *   1. For every `### X.Y — TypeName` heading that appears inside (or is the
 *      parent of) a `#### Wire format (foundation law)` block, assert
 *      `TypeName` is exported from `@motebit/protocol`.
 *   2. If a spec has no Wire format blocks yet, the probe reports it as
 *      "unstructured" — a soft signal that the foundation-law/convention split
 *      hasn't been applied. This is not an error yet; it becomes one when the
 *      `--strict` flag is passed.
 *
 * This is the ninth synchronization invariant defense: specs ↔ protocol types.
 * The other eight are enumerated in CLAUDE.md under "Synchronization invariants".
 *
 * Usage:
 *   tsx scripts/check-spec-coverage.ts           # exit 1 on missing types
 *   tsx scripts/check-spec-coverage.ts --strict  # also fail on unstructured specs
 */

import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(new URL(".", import.meta.url).pathname, "..");
const SPEC_DIR = join(REPO_ROOT, "spec");
const PROTOCOL_INDEX = join(REPO_ROOT, "packages", "protocol", "src", "index.ts");
const PROTOCOL_SRC = join(REPO_ROOT, "packages", "protocol", "src");

const WIRE_FORMAT_HEADER = /^####\s+Wire format\s*\(foundation law\)\s*$/i;
const STORAGE_HEADER = /^####\s+Storage\b/i;
const SECTION_HEADER = /^###\s+[\d.]+\s*—\s*([A-Z][A-Za-z0-9_]*)\s*$/;
const ANY_HEADER = /^#{1,6}\s+/;

interface Finding {
  spec: string;
  typeName: string;
  line: number;
}

function collectProtocolExports(): Set<string> {
  const exports = new Set<string>();
  const exportRegex =
    /export\s+(?:type\s+|interface\s+|class\s+|function\s+|const\s+|enum\s+)?(\{[^}]*\}|[A-Za-z_][A-Za-z0-9_]*)/g;
  const renameInBraces = /([A-Za-z_][A-Za-z0-9_]*)\s*(?:as\s+([A-Za-z_][A-Za-z0-9_]*))?/g;

  function scan(file: string): void {
    let src: string;
    try {
      src = readFileSync(file, "utf-8");
    } catch {
      return;
    }
    for (const match of src.matchAll(exportRegex)) {
      const tok = match[1]!;
      if (tok.startsWith("{")) {
        for (const inner of tok.slice(1, -1).matchAll(renameInBraces)) {
          const name = inner[2] ?? inner[1]!;
          if (/^[A-Z]/.test(name)) exports.add(name);
        }
      } else if (/^[A-Z]/.test(tok)) {
        exports.add(tok);
      }
    }
  }

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "__tests__" || entry.name === "dist") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) scan(full);
    }
  };
  walk(PROTOCOL_SRC);
  scan(PROTOCOL_INDEX);
  return exports;
}

interface SpecAnalysis {
  file: string;
  basename: string;
  wireSections: { typeName: string; line: number }[];
  hasWireBlock: boolean;
}

function analyzeSpec(file: string): SpecAnalysis {
  const basename = file.split("/").pop()!;
  const content = readFileSync(file, "utf-8");
  const lines = content.split("\n");

  const wireSections: { typeName: string; line: number }[] = [];
  let hasWireBlock = false;
  let currentType: { typeName: string; line: number } | null = null;
  let insideWireBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    const sectionMatch = line.match(SECTION_HEADER);
    if (sectionMatch) {
      currentType = { typeName: sectionMatch[1]!, line: i + 1 };
      insideWireBlock = false;
      continue;
    }

    if (WIRE_FORMAT_HEADER.test(line)) {
      hasWireBlock = true;
      insideWireBlock = true;
      if (currentType) {
        wireSections.push(currentType);
        currentType = null;
      }
      continue;
    }

    if (STORAGE_HEADER.test(line)) {
      insideWireBlock = false;
      continue;
    }

    // Another top-level section header ends the current wire block context.
    if (ANY_HEADER.test(line) && !line.startsWith("####")) {
      insideWireBlock = false;
    }
    // Reference insideWireBlock to keep state flow explicit (no-op read).
    void insideWireBlock;
  }

  return { file, basename, wireSections, hasWireBlock };
}

function main(): void {
  const strict = process.argv.includes("--strict");
  const exports = collectProtocolExports();

  const specs = readdirSync(SPEC_DIR)
    .filter((f) => f.endsWith(".md"))
    .map((f) => analyzeSpec(join(SPEC_DIR, f)))
    .sort((a, b) => a.basename.localeCompare(b.basename));

  const missing: Finding[] = [];
  const unstructured: string[] = [];
  let checked = 0;

  for (const spec of specs) {
    if (!spec.hasWireBlock) {
      unstructured.push(spec.basename);
      continue;
    }
    for (const { typeName, line } of spec.wireSections) {
      checked++;
      if (!exports.has(typeName)) {
        missing.push({ spec: spec.basename, typeName, line });
      }
    }
  }

  console.log(
    `check-spec-coverage — ${specs.length} specs, ${checked} wire-format types checked\n`,
  );

  if (missing.length > 0) {
    console.log(
      "✗ Types named in Wire format (foundation law) but not exported from @motebit/protocol:\n",
    );
    for (const m of missing) {
      console.log(`  ${m.spec}:${m.line}  ${m.typeName}`);
    }
    console.log(
      "\n  Fix: either export the type from @motebit/protocol, or rename the spec heading",
    );
    console.log(
      "  to match an existing exported type. Specs must stay aligned with the MIT vocabulary.",
    );
    process.exit(1);
  }

  if (unstructured.length > 0) {
    const marker = strict ? "✗" : "⚠";
    console.log(
      `${marker} Specs with no "Wire format (foundation law)" section (${unstructured.length}):\n`,
    );
    for (const name of unstructured) console.log(`  ${name}`);
    console.log(
      "\n  These specs have not applied the wire-vs-convention split. Add a\n" +
        '  "#### Wire format (foundation law)" subsection to each section that\n' +
        '  defines a binding artifact, and a "#### Storage" (or similar)\n' +
        "  subsection for reference-implementation conventions. See\n" +
        "  spec/discovery-v1.md §5.1 for the exemplar.",
    );
    if (strict) process.exit(1);
  }

  if (missing.length === 0 && (unstructured.length === 0 || !strict)) {
    console.log(`✓ All wire-format types in spec/ have matching exports in @motebit/protocol.`);
  }
}

main();
