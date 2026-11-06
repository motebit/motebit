/**
 * check-coverage-config-present tamper checks — each guard of the app scope
 * rule in scripts/check-coverage-config-present.ts, removed alone, must turn
 * its case in scripts/__tests__/check-coverage-config-present.test.ts red; and
 * removing the CLI's declared floor from apps/cli/vitest.config.ts must turn
 * the gate itself red over the real tree.
 *
 *   node scripts/tampers/coverage-config-present.ts
 *
 * Every entry is (file, text to revert, test expected red); the shared runner
 * applies each in an isolated copy of the tree. A guard is switched off with
 * `(false as boolean) && …` so the edit still type-checks.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runTampers, type TamperEntry } from "../lib/tamper-runner.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const GATE = "scripts/check-coverage-config-present.ts";
const TEST = "scripts/__tests__/check-coverage-config-present.test.ts";
const FAIL = "check-coverage-config-present failure cases";
const REAL =
  "check-coverage-config-present over the real repo passes, and holds the published, money-signing CLI to a floor";
const CLI_CONFIG = "apps/cli/vitest.config.ts";
const CLI_THRESHOLDS =
  "      thresholds: { statements: 47, branches: 43, functions: 59, lines: 46 },\n";

function entry(name: string, red: string, from: string, to: string): TamperEntry {
  return { name, edits: [{ file: GATE, from, to }], test: TEST, red };
}

const TAMPERS: TamperEntry[] = [
  entry(
    "apps/ is not scanned (the pre-fix premise: surfaces execute no money)",
    `${FAIL} a published test-bearing app with no thresholds fails`,
    "  if (existsSync(appsBase)) {",
    "  if ((false as boolean) && existsSync(appsBase)) {",
  ),
  entry(
    "a published app is not in scope by being published",
    `${FAIL} a published test-bearing app with no vitest.config.ts fails`,
    '  if (pkg.private !== true) reasons.push("published");',
    '  if ((false as boolean) && pkg.private !== true) reasons.push("published");',
  ),
  entry(
    "a trigger dependency does not put an app in scope",
    `${FAIL} a private app with a trigger in dependencies and no thresholds fails`,
    "  if (hits.length > 0) reasons.push(",
    "  if ((false as boolean) && hits.length > 0) reasons.push(",
  ),
  entry(
    "devDependencies are ignored (a bundled app's shipped deps)",
    `${FAIL} a private app with a trigger only in devDependencies and no thresholds fails`,
    "    ...Object.keys(pkg.devDependencies ?? {}),\n",
    "",
  ),
  entry(
    "peerDependencies are ignored",
    `${FAIL} a private app with a trigger in peerDependencies and no thresholds fails`,
    "    ...Object.keys(pkg.peerDependencies ?? {}),\n",
    "",
  ),
  entry(
    "an in-scope app is never checked for presence",
    `${FAIL} a private app with a trigger only in devDependencies and no thresholds fails`,
    "      if (scope.reasons.length === 0 || !scope.hasTests) continue;",
    "      if ((true as boolean) || scope.reasons.length === 0 || !scope.hasTests) continue;",
  ),
  {
    name: "the CLI's coverage floor is removed (the gate over the real tree)",
    edits: [{ file: CLI_CONFIG, from: CLI_THRESHOLDS, to: "" }],
    command: ["pnpm", "exec", "tsx", GATE],
    redMarker: "✗ motebit [missing-config]",
  },
  {
    name: "the CLI's coverage floor is removed (the real-repo case)",
    edits: [{ file: CLI_CONFIG, from: CLI_THRESHOLDS, to: "" }],
    test: TEST,
    red: REAL,
  },
];

await runTampers(TAMPERS, { root: ROOT });
