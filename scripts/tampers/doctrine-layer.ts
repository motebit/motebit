/**
 * check-doctrine-layer tamper checks — each guard in scripts/check-doctrine-layer.ts,
 * removed alone, must turn its case in
 * scripts/__tests__/check-doctrine-layer.test.ts red.
 *
 *   node scripts/tampers/doctrine-layer.ts
 *
 * Every entry is (file, text to revert, test expected red); the shared runner
 * applies each in an isolated copy of the tree. A guard is switched off with
 * `(false as boolean) && …` (or an early exit before its finding) so the edit
 * still type-checks.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runTampers, type TamperEntry } from "../lib/tamper-runner.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const GATE = "scripts/check-doctrine-layer.ts";
const TEST = "scripts/__tests__/check-doctrine-layer.test.ts";
const FAIL = "check-doctrine-layer failure cases";

/** One edit to the gate; `red` is the failure case's title. */
function entry(name: string, red: string, from: string, to: string): TamperEntry {
  return { name, edits: [{ file: GATE, from, to }], test: TEST, red: `${FAIL} ${red}` };
}

/** Switch a guard's condition off without changing its type. */
function off(name: string, red: string, condition: string): TamperEntry {
  return entry(
    name,
    red,
    condition,
    condition.replace(/^(\s*(?:\} else )?if \()/, "$1(false as boolean) && "),
  );
}

const TAMPERS: TamperEntry[] = [
  off(
    "a missing layer line is not reported",
    "a doc with no layer line fails",
    "  if (!line.startsWith(LAYER_PREFIX)) {",
  ),
  off(
    "a layer line placed after other text is accepted (same guard, second case)",
    "a layer line that is not the first non-blank line after the H1 fails",
    "  if (!line.startsWith(LAYER_PREFIX)) {",
  ),
  entry(
    "a second layer line is allowed",
    "a doc with two layer lines fails",
    "  if (layerLines.length > 1) {",
    "  if (layerLines.length > 99) {",
  ),
  off("a doc without an H1 is not reported", "a doc with no H1 fails", "  if (h1 < 0) {"),
  entry(
    "a malformed layer line is not reported",
    "a malformed layer line fails",
    "  if (!law) {\n",
    '  if (!law) {\n    if (line.length > 0) return "law";\n',
  ),
  entry(
    "an enforcement entry without backticks is skipped silently",
    "an enforcement entry that is not backticked fails",
    "    if (!tok) {\n",
    "    if (!tok) {\n      if (raw.length > 0) continue;\n",
  ),
  off(
    "a soft/advisory gate is not refused",
    "a law line naming a soft or advisory gate fails",
    "      if (gates.advisory.has(tok)) {",
  ),
  entry(
    "EXCLUDED_CHECKS reasons are not classified (every excluded gate counts as hard)",
    "a law line naming a soft or advisory gate fails",
    "(ADVISORY_RE.test(reason) ? advisory : hard)",
    "(false ? advisory : hard)",
  ),
  off(
    "an unregistered gate is accepted",
    "a law line naming an unregistered gate fails",
    "      } else if (!gates.hard.has(tok)) {",
  ),
  off(
    "a registered gate with no runnable source is accepted",
    "a law line naming a registered gate with no runnable source fails",
    "      } else if (gateSource(root, tok) === null) {",
  ),
  off(
    "a missing test file is accepted",
    "a law line naming a missing test file fails",
    "    if (!existsSync(abs)) {",
  ),
  off(
    "a missing source file is accepted (same guard, second case)",
    "a law line naming a missing source file fails",
    "    if (!existsSync(abs)) {",
  ),
  off(
    "a path that is neither a test nor a source file is accepted",
    "a law line naming a path that is neither a test nor a source file fails",
    "    if (!isTest && !SOURCE_FILE_RE.test(tok)) {",
  ),
  off(
    "the repo root directory is accepted as a path (same guard, second case)",
    "a law line naming the repo root directory fails",
    "    if (!isTest && !SOURCE_FILE_RE.test(tok)) {",
  ),
  off(
    "a directory is accepted as a test file",
    "a law line naming a directory under __tests__ fails",
    "    } else if (!statSync(abs).isFile()) {",
  ),
  off(
    "a gate named by its source path is not refused",
    "a law line naming a gate by its source path fails",
    "    if (GATE_PATH_RE.test(tok)) {",
  ),
  entry(
    "GATES is parsed to the end of the file, not to the end of its literal",
    "a script entry outside the GATES array literal does not register",
    '  const gates = literalBlock(src, "const GATES", "];");',
    '  const gates = src.slice(src.indexOf("const GATES"));',
  ),
  entry(
    "commented-out lines are not removed before parsing",
    "a commented-out GATES entry does not register",
    "    .filter((l) => !/^\\s*(?:\\/\\/|\\/\\*|\\*)/.test(l))",
    "    .filter((l) => l.length >= 0)",
  ),
  entry(
    "advisory detection narrowed back to 'soft signal|advisory'",
    "a gate whose EXCLUDED_CHECKS reason says warn-only, non-blocking or informational is refused",
    "  /\\bsoft\\b|advisory|warn(?:ing)?[- ]only|non[- ]blocking|informational|continue-on-error/i;",
    "  /soft signal|advisory/i;",
  ),
  entry(
    "the chain docs DOCTRINE.md lists drop out of scope",
    "a chain doc without a layer line fails",
    "  return [...doctrine, ...chain];",
    "  return [...doctrine];",
  ),
  off(
    "a chain doc that does not exist is not reported",
    "a chain doc DOCTRINE.md lists that does not exist fails",
    "  if (!existsSync(path)) {",
  ),
];

await runTampers(TAMPERS, { root: ROOT });
