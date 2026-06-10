#!/usr/bin/env tsx
/**
 * `check-memory-source-canonical` — registry-coverage gate for the
 * `MemorySource` closed registry, plus the two load-bearing
 * provenance-authorship scans.
 *
 * Closed-registry / structural-lock pattern — same shape as
 * `check-suite-declared` (#10), `check-audience-canonical` (#46),
 * `check-artifact-type-canonical` (#85),
 * `check-sensitivity-canonical` (#97),
 * `check-event-type-canonical` (#99),
 * `check-settlement-mode-canonical` (#100).
 *
 *   1. `MemorySource` (the union in
 *      `packages/protocol/src/memory-source.ts`) is the closed
 *      vocabulary of memory provenance — who contributed a remembered
 *      fact. Every `MemoryFormedPayload` MAY carry `source`; render
 *      surfaces show `[from:X]`; policy weighs it. Cross-implementation
 *      drift silently demotes (or worse, promotes) the epistemic
 *      standing of synced memories.
 *
 *   2. Three-way lock: union × `ALL_MEMORY_SOURCES` × this gate's
 *      `MEMORY_SOURCES_REFERENCE` must agree exactly.
 *
 *   3. Wire-format compliance: lowercase snake_case identifiers
 *      (`^[a-z][a-z0-9_]*$`), same convention as `EventType`.
 *
 *   4. **Authorship scan (the load-bearing assertion)**: `source` is
 *      assigned by the FORMING CODE PATH — never authored by the model,
 *      never accepted from a peer.
 *        (a) No file in `packages/ai-core/src` may parse or instruct a
 *            `source` attribute on `<memory>` tags — the model cannot
 *            self-classify provenance (self-escalation channel).
 *        (b) The MCP server's memory write path may only ever pass the
 *            literal `"peer_agent"` source — a remote caller cannot
 *            self-declare a trusted provenance tier.
 *
 * Doctrine: `docs/doctrine/memory-provenance.md` (tenth registered
 * registry, `docs/doctrine/registry-pattern-canonical.md`).
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

/**
 * The canonical set, mirrored from
 * `packages/protocol/src/memory-source.ts:ALL_MEMORY_SOURCES`.
 */
const MEMORY_SOURCES_REFERENCE = [
  "user_stated",
  "agent_inferred",
  "tool_derived",
  "peer_agent",
  "consolidation_derived",
] as const;

const SNAKE_CASE_IDENT_PATTERN = /^[a-z][a-z0-9_]*$/;

function readFile(path: string): string | null {
  try {
    return readFileSync(resolve(ROOT, path), "utf8");
  } catch {
    return null;
  }
}

function walkTsFiles(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(resolve(ROOT, dir));
  } catch {
    return out;
  }
  for (const entry of entries) {
    const rel = join(dir, entry);
    const full = resolve(ROOT, rel);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...walkTsFiles(rel));
    } else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) {
      out.push(rel);
    }
  }
  return out;
}

function readUnionValues(source: string): string[] {
  const unionMatch = source.match(/export type MemorySource\s*=([^;]+);/);
  if (unionMatch === null) return [];
  const body = unionMatch[1] ?? "";
  const values: string[] = [];
  const valuePattern = /"([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = valuePattern.exec(body)) !== null) {
    values.push(m[1] as string);
  }
  return values;
}

function readArrayValues(source: string): string[] {
  const arrayMatch = source.match(/ALL_MEMORY_SOURCES[^=]*=\s*Object\.freeze\(\[([\s\S]*?)\]/);
  if (arrayMatch === null) return [];
  const body = arrayMatch[1] ?? "";
  const values: string[] = [];
  const valuePattern = /"([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = valuePattern.exec(body)) !== null) {
    values.push(m[1] as string);
  }
  return values;
}

function main(): void {
  // === Sibling-alignment: three-way lock =========================
  const source = readFile("packages/protocol/src/memory-source.ts");
  if (source === null) {
    console.error(
      "check-memory-source-canonical: could not read packages/protocol/src/memory-source.ts.",
    );
    console.error("The MemorySource registry surface is missing; this gate cannot validate.");
    process.exit(1);
  }

  const unionValues = readUnionValues(source);
  const arrayValues = readArrayValues(source);
  const gateValues = [...MEMORY_SOURCES_REFERENCE];

  if (unionValues.length === 0) {
    console.error("check-memory-source-canonical: could not parse MemorySource union values.");
    process.exit(1);
  }
  if (arrayValues.length === 0) {
    console.error(
      "check-memory-source-canonical: could not parse ALL_MEMORY_SOURCES array values.",
    );
    process.exit(1);
  }

  const unionSet = new Set(unionValues);
  const arraySet = new Set(arrayValues);
  const gateSet = new Set(gateValues);

  const unionOnly = [...unionSet].filter((v) => !arraySet.has(v) || !gateSet.has(v));
  const arrayOnly = [...arraySet].filter((v) => !unionSet.has(v) || !gateSet.has(v));
  const gateOnly = [...gateSet].filter((v) => !unionSet.has(v) || !arraySet.has(v));

  if (unionOnly.length > 0 || arrayOnly.length > 0 || gateOnly.length > 0) {
    console.error(
      "check-memory-source-canonical: sibling-alignment failure across MemorySource × ALL_MEMORY_SOURCES × gate reference.",
    );
    if (unionOnly.length > 0) {
      console.error(`  In union but not all three: ${unionOnly.map((v) => `"${v}"`).join(", ")}`);
    }
    if (arrayOnly.length > 0) {
      console.error(
        `  In ALL_MEMORY_SOURCES but not all three: ${arrayOnly.map((v) => `"${v}"`).join(", ")}`,
      );
    }
    if (gateOnly.length > 0) {
      console.error(`  In gate but not all three: ${gateOnly.map((v) => `"${v}"`).join(", ")}`);
    }
    console.error("");
    console.error(
      "The three-way lock requires `MemorySource` (union) × `ALL_MEMORY_SOURCES` (array) × `MEMORY_SOURCES_REFERENCE` (gate) to agree exactly.",
    );
    console.error(
      "Adding a memory source is intentional protocol-level work — update all three (plus MEMORY_SOURCE_MARKERS, compile-locked) in the same commit.",
    );
    console.error("Doctrine: docs/doctrine/memory-provenance.md.");
    process.exit(1);
  }

  // === Wire-format compliance ====================================
  const malformed = MEMORY_SOURCES_REFERENCE.filter((v) => !SNAKE_CASE_IDENT_PATTERN.test(v));
  if (malformed.length > 0) {
    console.error(
      `check-memory-source-canonical: ${malformed.length} value(s) violate wire-format convention:`,
    );
    for (const v of malformed) {
      console.error(`  - "${v}" — expected lowercase snake_case ([a-z][a-z0-9_]*)`);
    }
    process.exit(1);
  }

  // === Authorship scan (a): the model cannot author source =======
  //
  // No file in packages/ai-core/src may (i) include a `source` attribute
  // group in a `<memory` tag pattern (parsing) or (ii) instruct the model
  // to emit one (prompting). A line that mentions `<memory` and `source=`
  // together is the drift signature for both.
  const aiCoreViolations: string[] = [];
  for (const rel of walkTsFiles("packages/ai-core/src")) {
    // Test files are excluded: the negative fixture proving a
    // model-authored source attribute is NOT honored necessarily
    // contains the forbidden pattern.
    if (rel.includes("__tests__")) continue;
    const content = readFile(rel);
    if (content === null) continue;
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] as string;
      if (line.includes("<memory") && /source\s*=/.test(line)) {
        aiCoreViolations.push(`${rel}:${i + 1}`);
      }
    }
  }
  if (aiCoreViolations.length > 0) {
    console.error(
      "check-memory-source-canonical: model-authored provenance detected — a `<memory>` tag pattern in ai-core carries a `source` attribute:",
    );
    for (const v of aiCoreViolations) console.error(`  - ${v}`);
    console.error("");
    console.error(
      "`source` is assigned by the forming code path, never parsed from model output. The model self-classifying provenance is the self-escalation channel this registry exists to close.",
    );
    console.error("Doctrine: docs/doctrine/memory-provenance.md § authorship.");
    process.exit(1);
  }

  // === Authorship scan (b): peers cannot self-declare source =====
  //
  // The MCP server's memory write path may pass ONLY the literal
  // "peer_agent". Any other registry value as a `source:` property in
  // mcp-server source is a peer-trust escalation. (Absence is fine —
  // pre-threading code passes no source at all.)
  const mcpViolations: string[] = [];
  const forbiddenInMcp = MEMORY_SOURCES_REFERENCE.filter((v) => v !== "peer_agent");
  for (const rel of walkTsFiles("packages/mcp-server/src")) {
    if (rel.includes("__tests__")) continue;
    const content = readFile(rel);
    if (content === null) continue;
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] as string;
      for (const v of forbiddenInMcp) {
        if (new RegExp(`source\\s*:\\s*["']${v}["']`).test(line)) {
          mcpViolations.push(`${rel}:${i + 1} (source: "${v}")`);
        }
      }
      // A source derived from caller input is the same escalation.
      if (/source\s*:\s*(args|params|input|request)\b/.test(line)) {
        mcpViolations.push(`${rel}:${i + 1} (caller-derived source)`);
      }
    }
  }
  if (mcpViolations.length > 0) {
    console.error(
      "check-memory-source-canonical: peer-declared provenance detected in mcp-server — remote writes must be `peer_agent` only:",
    );
    for (const v of mcpViolations) console.error(`  - ${v}`);
    console.error("Doctrine: docs/doctrine/memory-provenance.md § authorship.");
    process.exit(1);
  }

  console.log(
    `✓ check-memory-source-canonical: ${MEMORY_SOURCES_REFERENCE.length} memory source(s) locked across union + ALL_MEMORY_SOURCES + gate reference; wire-format-compliant; model/peer authorship scans clean.`,
  );
}

main();
