/**
 * check-liquescent-ontology tamper checks — each guard in
 * scripts/check-liquescent-ontology.ts, removed alone, must turn its case in
 * scripts/__tests__/check-liquescent-ontology.test.ts red.
 *
 *   node scripts/tampers/liquescent-ontology.ts
 *
 * Every entry is (file, text to revert, test expected red); the shared runner
 * applies each in an isolated copy of the tree.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runTampers, type TamperEntry } from "../lib/tamper-runner.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const GATE = "scripts/check-liquescent-ontology.ts";
const TEST = "scripts/__tests__/check-liquescent-ontology.test.ts";
const SUITE = "check-liquescent-ontology";

function entry(
  name: string,
  red: string,
  from: string,
  to: string,
  also: TamperEntry["edits"] = [],
): TamperEntry {
  return {
    name,
    edits: [{ file: GATE, from, to }, ...also],
    test: TEST,
    red: `${SUITE} ${red}`,
  };
}

/**
 * Exact-text matching lives in two places that must agree: the allowlist
 * lookup and the per-entry line count. Loosening only one leaves the other
 * catching the change, so "matching is not exact" is both, together.
 */
const LOOSE_COUNT = {
  file: GATE,
  from: "lines.filter((l) => l === entry.text).length",
  to: "lines.filter((l) => l.startsWith(entry.text.slice(0, 20))).length",
};

const TAMPERS: TamperEntry[] = [
  entry(
    "forbidden phrases are never matched",
    "a forbidden phrase in an ordinary file fails",
    "        if (pattern.test(cleaned)) {",
    "        if ((false as boolean) && pattern.test(cleaned)) {",
  ),
  entry(
    "allowlist matching is by prefix, not exact text (lookup and count)",
    "an allowlisted sentence with a changed constant fails",
    "relPath === entry.file && line === entry.text",
    "relPath === entry.file && line.startsWith(entry.text.slice(0, 20))",
    [LOOSE_COUNT],
  ),
  entry(
    "allowlist matching is by prefix, not exact text (same guard, second case)",
    "an allowlisted sentence with a changed comma fails",
    "relPath === entry.file && line === entry.text",
    "relPath === entry.file && line.startsWith(entry.text.slice(0, 20))",
    [LOOSE_COUNT],
  ),
  entry(
    "an allowlist entry applies in any file",
    "the allowlisted text copied into another file fails there",
    "relPath === entry.file && line === entry.text",
    "relPath.length > 0 && line === entry.text",
  ),
  entry(
    "an allowed line stays allowed when its entry matches more than one line",
    "a verbatim copy of an allowlisted sentence fails with count 2",
    "if (allowed && matchCount.get(allowed) === 1) continue;",
    "if (allowed) continue;",
  ),
  entry(
    "entries that do not match exactly one line are not reported",
    "a removed allowlisted sentence is reported stale",
    "    .filter((entry) => matchCount.get(entry) !== 1)",
    "    .filter((entry) => matchCount.get(entry) === -1)",
  ),
  entry(
    "the per-entry line count is not measured (every entry counts as 1)",
    "a removed allowlisted sentence is reported stale",
    "      matchCount.set(entry, lines.filter((l) => l === entry.text).length);",
    "      matchCount.set(entry, 1);",
  ),
  entry(
    "backtick citations are not stripped before matching",
    "a forbidden phrase inside a backtick citation passes",
    '  return line.replace(/`[^`]+`/g, "");',
    "  return line;",
  ),
];

await runTampers(TAMPERS, { root: ROOT });
