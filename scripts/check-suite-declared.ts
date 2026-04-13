#!/usr/bin/env tsx
/**
 * check-suite-declared — synchronization invariant #11 (spec-side).
 *
 * Every `#### Wire format (foundation law)` subsection that declares an
 * artifact carrying a `signature` field MUST also declare a `suite` field
 * in the same Wire-format block, and the declared value MUST be a
 * `SuiteId` registered in `@motebit/protocol`.
 *
 * Why: adding new signature primitives (ML-DSA, SLH-DSA) is a registry
 * update, not a wire-format break — but only if every signed artifact
 * already carries an explicit `suite` discriminator. Drift here means
 * a signed artifact's verification recipe is implicit, and the PQ
 * migration for that artifact silently becomes a breaking change.
 *
 * Complement: `check-suite-dispatch` (synchronization invariant #12)
 * enforces the code-side version of the same invariant — every
 * verifier in `@motebit/crypto` must dispatch via `verifyBySuite`, no
 * hidden Ed25519 defaults.
 *
 * Usage:
 *   tsx scripts/check-suite-declared.ts           # exit 1 on violation
 */

import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(new URL(".", import.meta.url).pathname, "..");
const SPEC_DIR = join(REPO_ROOT, "spec");
const PROTOCOL_SUITE_FILE = join(REPO_ROOT, "packages", "protocol", "src", "crypto-suite.ts");

const WIRE_HEADER = /^####\s+Wire format\s*\(foundation law\)\s*$/i;
const H3 = /^###\s/;
const H2 = /^##\s/;
const H4 = /^####\s/;
// Matches a table row whose first column is a field name wrapped in backticks:
//   | `suite` | string | yes | ... |
const FIELD_ROW = /^\|\s*`([a-zA-Z_][a-zA-Z0-9_]*)`\s*\|/;

interface Finding {
  spec: string;
  line: number;
  kind: "signature-without-suite" | "unknown-suite-value";
  detail: string;
}

function collectRegisteredSuiteIds(): Set<string> {
  const src = readFileSync(PROTOCOL_SUITE_FILE, "utf-8");
  // The SuiteId type is a string-literal union; pull the literals out.
  const unionMatch = src.match(/export type SuiteId\s*=([\s\S]*?);/);
  if (!unionMatch) {
    throw new Error(
      "check-suite-declared: could not locate `export type SuiteId` in crypto-suite.ts",
    );
  }
  const ids = new Set<string>();
  for (const m of unionMatch[1]!.matchAll(/"([^"]+)"/g)) {
    ids.add(m[1]!);
  }
  if (ids.size === 0) {
    throw new Error("check-suite-declared: SuiteId union parsed to zero IDs");
  }
  return ids;
}

interface WireBlock {
  /** 1-indexed line where the `####` header lives. */
  headerLine: number;
  /** Field name → { line, value? }. Value is present only for rows that inline a literal. */
  fields: Map<string, { line: number; value?: string }>;
  /** Raw text of the block (from header through to the next ####/###/##/## boundary). */
  rawLines: string[];
}

/**
 * Extract every Wire format block in a spec file. A block starts at a
 * `#### Wire format (foundation law)` header and ends at the next H2,
 * H3, or H4 (whichever comes first).
 */
function extractWireBlocks(lines: string[]): WireBlock[] {
  const blocks: WireBlock[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!WIRE_HEADER.test(lines[i]!)) continue;
    const headerLine = i + 1;
    const rawLines: string[] = [];
    const fields = new Map<string, { line: number; value?: string }>();
    for (let j = i + 1; j < lines.length; j++) {
      const ln = lines[j]!;
      if (H2.test(ln) || H3.test(ln) || H4.test(ln)) break;
      rawLines.push(ln);
      const fm = ln.match(FIELD_ROW);
      if (fm) {
        const name = fm[1]!;
        // Try to extract a literal value in the row — useful for `suite`
        // declarations that embed the value right in the description:
        //   | `suite` | string | yes | `"motebit-jcs-ed25519-b64-v1"` — ... |
        const valMatch = ln.match(/`"([^"]+)"`/);
        fields.set(name, { line: j + 1, value: valMatch?.[1] });
        continue;
      }
      // Also detect fields declared inside code blocks (e.g. migration/
      // dispute specs describe shapes as pseudo-TypeScript):
      //   `  signature:        string      // Ed25519 ...`
      //   `  suite:            string      // motebit-jcs-ed25519-b64-v1`
      const codeField = ln.match(/^\s{2,}([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*/);
      if (codeField) {
        const name = codeField[1]!;
        // Look for a quoted literal in the same line comment.
        const valMatch = ln.match(/"([^"]+)"/);
        // Only record the first occurrence per block — a field may
        // appear in both a code block and a table; the table form wins
        // if present (more detailed, normative).
        if (!fields.has(name)) {
          fields.set(name, { line: j + 1, value: valMatch?.[1] });
        }
      }
    }
    blocks.push({ headerLine, fields, rawLines });
  }
  return blocks;
}

function main(): void {
  const registeredSuites = collectRegisteredSuiteIds();
  const specFiles = readdirSync(SPEC_DIR)
    .filter((f) => f.endsWith(".md"))
    .sort();

  const findings: Finding[] = [];
  let blocksScanned = 0;
  let blocksWithSignature = 0;

  for (const name of specFiles) {
    const full = join(SPEC_DIR, name);
    const lines = readFileSync(full, "utf-8").split("\n");
    const blocks = extractWireBlocks(lines);
    blocksScanned += blocks.length;

    for (const block of blocks) {
      const hasSignature = block.fields.has("signature");
      if (!hasSignature) continue;
      blocksWithSignature++;

      const suiteField = block.fields.get("suite");
      if (!suiteField) {
        findings.push({
          spec: name,
          line: block.fields.get("signature")!.line,
          kind: "signature-without-suite",
          detail:
            "Wire format declares `signature` but no `suite` field. " +
            "Every signed artifact MUST carry an explicit cryptosuite " +
            "discriminator so verifiers can dispatch primitive verification " +
            "without assuming Ed25519.",
        });
        continue;
      }

      if (suiteField.value && !registeredSuites.has(suiteField.value)) {
        findings.push({
          spec: name,
          line: suiteField.line,
          kind: "unknown-suite-value",
          detail: `\`suite\` value "${suiteField.value}" is not a registered \`SuiteId\`. Add it to \`packages/protocol/src/crypto-suite.ts\` or correct the spec.`,
        });
      }
    }
  }

  console.log(
    `check-suite-declared — ${specFiles.length} specs, ${blocksScanned} wire-format blocks (${blocksWithSignature} signed)\n`,
  );

  if (findings.length === 0) {
    console.log("✓ Every signed wire-format artifact declares a registered `suite` field.");
    return;
  }

  for (const f of findings) {
    console.log(`✗ ${f.spec}:${f.line}  [${f.kind}]`);
    console.log(`    ${f.detail}\n`);
  }
  process.exit(1);
}

main();
