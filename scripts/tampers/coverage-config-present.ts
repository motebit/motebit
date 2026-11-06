/**
 * check-coverage-config-present tamper checks — each guard of the app scope
 * rule in scripts/check-coverage-config-present.ts, removed alone, must turn
 * its case in scripts/__tests__/check-coverage-config-present.test.ts red; and
 * removing the CLI's declared floor from apps/cli/vitest.config.ts must turn
 * the gate itself red over the real tree, and so must removing its
 * `coverage.include` (a floor over a partial denominator). The last entries cover the
 * follow-up in scripts/verify-test-outcomes.ts: with the real
 * NO_THRESHOLD_PACKAGES now empty, its fixture's no-floor case runs under an
 * injected allowance, and each seam of that injection, removed alone, must
 * turn a case in scripts/__tests__/verify-test-outcomes.test.ts red.
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
const VERIFIER = "scripts/verify-test-outcomes.ts";
const VERIFIER_TEST = "scripts/__tests__/verify-test-outcomes.test.ts";
const FIXTURE_CASES = "verifyOutcomes over fixture artifacts";
const CLI_INCLUDE = '      include: ["src/**/*.ts"],\n';
const DENOM = "check-coverage-config-present denominator";
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
  {
    name: "the verifier ignores the injected allowance (reads only the real, empty constant)",
    edits: [
      {
        file: VERIFIER,
        from: "  const noFloorOk = pkg in noThresholdPackages;",
        to: "  const noFloorOk = pkg in NO_THRESHOLD_PACKAGES;",
      },
    ],
    test: VERIFIER_TEST,
    red: `${FIXTURE_CASES} is GREEN with a no-floor package the injected allowance carries`,
  },
  {
    name: "verifyOutcomes drops its options before the per-package check",
    edits: [
      {
        file: VERIFIER,
        from: "join(artifacts, s, pkg), notBefore.get(s), opts),",
        to: "join(artifacts, s, pkg), notBefore.get(s)),",
      },
    ],
    test: VERIFIER_TEST,
    red: `${FIXTURE_CASES} is GREEN with a no-floor package the injected allowance carries`,
  },
  {
    name: "the stale-allowance check is gone (an allowance for a floored package passes)",
    edits: [
      {
        file: VERIFIER,
        from: "  if (floors && noFloorOk)",
        to: "  if ((false as boolean) && floors && noFloorOk)",
      },
    ],
    test: VERIFIER_TEST,
    red: `${FIXTURE_CASES} is RED on an allowance entry for a package that declares thresholds (stale)`,
  },
  {
    name: "the CLI's coverage.include is removed (the gate over the real tree)",
    edits: [{ file: CLI_CONFIG, from: CLI_INCLUDE, to: "" }],
    command: ["pnpm", "exec", "tsx", GATE],
    redMarker: "✗ motebit [partial-denominator]",
  },
  {
    name: "the CLI's coverage.include is removed (the real-repo case)",
    edits: [{ file: CLI_CONFIG, from: CLI_INCLUDE, to: "" }],
    test: TEST,
    red: REAL,
  },
  entry(
    "the denominator check never runs for a package or service",
    `${FAIL} a bare floored package or service with no coverage.include fails too`,
    "      const v = presenceViolation(name, config) ?? denominatorViolation(name, config, bareConfigs);",
    "      const v = presenceViolation(name, config);",
  ),
  entry(
    "the denominator check never runs for an app",
    `${FAIL} a bare floored config with no coverage.include fails (the denominator is only what the tests import)`,
    "        presenceViolation(pkg.name, config) ?? denominatorViolation(pkg.name, config, bareConfigs);",
    "        presenceViolation(pkg.name, config);",
  ),
  entry(
    "any include counts, however narrow",
    `${FAIL} a bare floored config whose coverage.include names only some files fails`,
    "  if (includes?.some((g) => FULL_SRC_INCLUDE.test(g))) return null;",
    "  if (includes !== null) return null;",
  ),
  entry(
    "an include anywhere in the config counts (not only the coverage block's)",
    `${FAIL} a test.include outside the coverage block does not count as the coverage include`,
    "  const m = block?.match(",
    "  const m = src.match(",
  ),
  entry(
    "a factory config is held to the bare-config rule",
    `${DENOM} a defineMotebitTest config needs no include of its own (the factory supplies src/)`,
    "  if (/\\bdefineMotebitTest\\(/.test(src)) return null; // the factory's default include is src/**/*.ts",
    "  if ((false as boolean) && /\\bdefineMotebitTest\\(/.test(src)) return null;",
  ),
];

await runTampers(TAMPERS, { root: ROOT });
