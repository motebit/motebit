#!/usr/bin/env tsx
/**
 * The `check` verdict's proof that every suite RAN and PASSED — read from what
 * vitest itself wrote, never from a shard runner's exit code or a runner's
 * own list of packages.
 *
 * Why this exists. CI's suites run as the `test-coverage` shard matrix
 * (scripts/test-coverage-shards.ts). Two cold reviews of that split found the
 * same class, twice: the proof that the shards run every package's tests and
 * fail on failure trusted the RUNNER — its exit code (B1: a NODE_OPTIONS
 * `--import` that zeroes `process.exitCode` on exit turns turbo's "1 failed"
 * into a green leg) and its enumeration (B2: drop apps/web from the runner's
 * package list and its weight, and every gate that imported that list agreed).
 * Patching each mutant is whack-a-mole; the structural fix
 * (docs/doctrine/composition-preserves-enforcement.md — reduce the seam) is to
 * stop asking the runner at all:
 *
 *   - Every suite writes vitest's own JSON results and run-end state
 *     (`MOTEBIT_TEST_REPORTERS` in vitest.shared.ts, set after any per-package
 *     override) next to its coverage-summary.json. The shards upload them.
 *   - This script enumerates the packages INDEPENDENTLY — pnpm-workspace.yaml
 *     globs → each package.json declaring `test:coverage` — and imports
 *     NOTHING from the runner (scripts/__tests__/verify-test-outcomes.test.ts
 *     and check-prepush-subset both refuse such an import).
 *   - For each package it requires, in exactly one shard's artifact: the
 *     results file with tests > 0 (or a reasoned ZERO_TEST_PACKAGES entry),
 *     0 failed tests, 0 failed suites, `success: true`, every test file inside
 *     that package; the run-end file `passed` with 0 unhandled errors; and the
 *     coverage summary meeting the package's own declared thresholds (package
 *     axes and per-glob floors, read from its vitest config by the same reader
 *     coverage-graduation uses, computed the way vitest computes them).
 *   - A results file for a package the workspace does not declare is RED too.
 *   - Each package passed AT LEAST its committed floor of tests
 *     (FLOORS_FILE, below). Everything above judges the suite the package
 *     DECLARES; a declaration can be narrowed (a test:coverage script naming
 *     one file, `--shard=k/N`, `--changed`, a narrowed include/exclude,
 *     deleted test files) and every rule above still holds — measured on
 *     apps/cli, which has no coverage thresholds: `vitest run
 *     src/__tests__/approval-render.test.ts --coverage` ran 11 of 1017 tests,
 *     exit 0, success true, nothing skipped, verifier GREEN. The floor is the
 *     suite's size held OUTSIDE the suite's own declaration.
 *
 * Usage (CI's `check` job, after downloading every `coverage-shard-*`):
 *   tsx scripts/verify-test-outcomes.ts --artifacts /tmp/coverage-shards [--root .]
 * Writing the floors (after a REAL full run of every shard, laid out the same way):
 *   tsx scripts/verify-test-outcomes.ts --artifacts <dir> --write-floors
 *     raises floors, adds a new package's, drops a removed package's; never lowers;
 *   … --write-floors --allow-lower "<reason>"
 *     also lowers (legitimate test deletion), recording each in allowedDecreases.
 * `<artifacts>/<shard-artifact>/<package-dir>/coverage/…` is the layout
 * actions/download-artifact produces for the shard uploads.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";
import { cleanEnv } from "./lib/differential-tree.js";
import { failWithRepair } from "./lib/gate-report.js";
import {
  COVERAGE_AXES,
  readGlobThresholds,
  readPackageThresholds,
  type CoverageThresholds,
} from "./lib/vitest-thresholds.js";

/** Written by every suite (vitest.shared.ts TEST_RESULTS_FILE / TEST_RUN_END_FILE). */
export const RESULTS_FILE = "coverage/vitest-results.json";
export const RUN_END_FILE = "coverage/vitest-run-end.json";
export const SUMMARY_FILE = "coverage/coverage-summary.json";
/**
 * Written by each test-coverage shard job's FIRST step after checkout (ci.yml),
 * before install, build or any suite: `{"startedAt": <ms since epoch>}`. Not
 * the shard runner's — a step of the job itself. Every results file in that
 * shard must carry a vitest `startTime` at or after it.
 */
export const SHARD_STAMP_FILE = "coverage/shard-started-at.json";

/**
 * The committed per-package floor of tests that must PASS, workspace-relative:
 * `{ "floors": { "<pkg dir>": <int> }, "allowedDecreases": { "<pkg dir>":
 * { "from": <int>, "to": <int>, "reason": "…" } } }`. Generated from a real
 * full run by `--write-floors` and a RATCHET: the writer only raises unless
 * `--allow-lower`, and scripts/check-test-outcome-floors.ts refuses any floor
 * below its merge-base value without a matching allowedDecreases entry added
 * in the same change. Every workspace package with a test:coverage script
 * needs an entry — a new package fails closed until it has one.
 */
export const FLOORS_FILE = "scripts/test-outcome-floors.json";

export interface FloorsFile {
  floors: Record<string, number>;
  allowedDecreases: Record<string, { from: number; to: number; reason: string }>;
}

/** The floors file at `root`, validated; a string when it cannot be trusted. */
export function readFloors(root: string): FloorsFile | string {
  const p = join(root, FLOORS_FILE);
  if (!existsSync(p)) return `${FLOORS_FILE} does not exist`;
  return parseFloors(readFileSync(p, "utf8"));
}

/** Parses and validates a floors file's text (also used on git-show'd copies). */
export function parseFloors(text: string): FloorsFile | string {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return `${FLOORS_FILE} is not JSON (${err instanceof Error ? err.message : String(err)})`;
  }
  const o = raw as { floors?: unknown; allowedDecreases?: unknown };
  if (typeof o !== "object" || o === null || typeof o.floors !== "object" || o.floors === null)
    return `${FLOORS_FILE} carries no "floors" object`;
  const floors: Record<string, number> = {};
  for (const [k, v] of Object.entries(o.floors as Record<string, unknown>)) {
    if (typeof v !== "number" || !Number.isInteger(v) || v < 1)
      return `${FLOORS_FILE} floors[${JSON.stringify(k)}] is ${JSON.stringify(v)}, not a positive integer`;
    floors[k] = v;
  }
  const allowedDecreases: FloorsFile["allowedDecreases"] = {};
  const ad = o.allowedDecreases ?? {};
  if (typeof ad !== "object" || ad === null)
    return `${FLOORS_FILE} "allowedDecreases" is not an object`;
  for (const [k, v] of Object.entries(ad as Record<string, unknown>)) {
    const e = v as { from?: unknown; to?: unknown; reason?: unknown };
    if (
      typeof e !== "object" ||
      e === null ||
      !Number.isInteger(e.from) ||
      !Number.isInteger(e.to) ||
      typeof e.reason !== "string" ||
      e.reason.trim().length === 0
    )
      return `${FLOORS_FILE} allowedDecreases[${JSON.stringify(k)}] is not { from: int, to: int, reason: non-empty string }`;
    allowedDecreases[k] = { from: e.from as number, to: e.to as number, reason: e.reason };
  }
  return { floors, allowedDecreases };
}

/** Clock skew tolerated between a shard runner and the verdict runner. */
export const CLOCK_SKEW_MS = 5 * 60_000;

/**
 * Packages whose suite legitimately runs zero tests, with the reason. Empty:
 * every package with a `test:coverage` script has tests. An entry for a
 * package that does run tests is stale and RED, so the list cannot hide one.
 */
export const ZERO_TEST_PACKAGES: Record<string, string> = {};

/**
 * The share of the tests a suite DECLARES and did not fail (vitest's
 * numTotalTests counts skipped/pending and todo too) that it must actually
 * RUN and pass. A name filter (`-- -t nomatch`: apps/cli exits 0 with
 * numTotalTests 1016, numPassedTests 0, numPendingTests 1016, success true)
 * or a blanket `.skip` leaves numTotalTests and `success` untouched while
 * running nothing — this is what catches it.
 *
 * Measured over a real 3-shard run of every suite (2026-10-05, 72 packages,
 * 20310 declared tests, 20301 passed, 9 skipped, 0 todo): 68 packages skip
 * nothing; the four that skip are env-gated integrations —
 * crypto-appattest 39/42 = 0.929 (real-device ceremony), mcp-client 176/179
 * = 0.983 (live GitHub MCP), runtime 1817/1818 and relay 3598/3600 = 0.999
 * (an eval doc-marked not CI-testable; devnet federation). 0.8 leaves the
 * lowest ~8 more skips of headroom before RED and refuses any filter that
 * runs under four fifths of a suite; a package that genuinely skips more
 * takes a reasoned SKIP_HEAVY_PACKAGES entry, never a lower default.
 */
export const MIN_RUN_SHARE = 0.8;

/**
 * Packages that legitimately skip more than 1 − MIN_RUN_SHARE of their tests,
 * each with its own floor and the reason. An entry for a package that skips
 * nothing is stale and RED.
 */
export const SKIP_HEAVY_PACKAGES: Record<string, { minRunShare: number; reason: string }> = {};

/**
 * Packages whose vitest config declares no coverage thresholds, with the
 * reason. The summary must still exist (coverage ran); only the floor
 * comparison is skipped. An entry for a package that declares thresholds is
 * stale and RED.
 */
export const NO_THRESHOLD_PACKAGES: Record<string, string> = {
  "apps/cli":
    "bare vitest config, no shared factory — collects coverage without per-package thresholds (apps/cli/vitest.config.ts)",
};

/** vitest's own lookup order: a vitest config, else the vite config's `test` block. */
export const CONFIG_NAMES = [
  "vitest.config.ts",
  "vitest.config.mts",
  "vitest.config.js",
  "vitest.config.mjs",
  "vite.config.ts",
  "vite.config.mts",
  "vite.config.js",
  "vite.config.mjs",
];

/**
 * Every workspace package dir whose package.json declares `test:coverage`,
 * sorted — read straight from pnpm-workspace.yaml and the package.json files.
 * Deliberately its own code (not the shard runner's `coveragePackages`): a
 * runner edit must not be able to shrink the set it is judged against.
 */
export function workspaceCoveragePackages(root: string): string[] {
  const ws = parseYaml(readFileSync(join(root, "pnpm-workspace.yaml"), "utf8")) as {
    packages?: unknown;
  };
  if (!Array.isArray(ws.packages) || ws.packages.length === 0)
    throw new Error("pnpm-workspace.yaml declares no `packages` globs");
  const out: string[] = [];
  for (const g of ws.packages) {
    if (typeof g !== "string" || !/^[\w.-]+\/\*$/.test(g))
      throw new Error(
        `pnpm-workspace.yaml glob ${JSON.stringify(g)} is not of the form "<dir>/*" — teach verify-test-outcomes to enumerate it rather than skip it`,
      );
    const base = g.slice(0, -2);
    if (!existsSync(join(root, base))) continue;
    for (const d of readdirSync(join(root, base), { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const pj = join(root, base, d.name, "package.json");
      if (!existsSync(pj)) continue;
      const scripts = (
        JSON.parse(readFileSync(pj, "utf8")) as { scripts?: Record<string, unknown> }
      ).scripts;
      if (scripts && typeof scripts["test:coverage"] === "string") out.push(`${base}/${d.name}`);
    }
  }
  return out.sort();
}

/** istanbul's percentage (what vitest compares thresholds against): 100 when nothing to cover. */
export function pct(covered: number, total: number): number {
  return total > 0 ? Math.floor((1000 * 100 * covered) / total / 10) / 100 : 100;
}

type Axis = { total: number; covered: number };
type FileSummary = Record<(typeof COVERAGE_AXES)[number], Axis>;

/** `**` / `*` / `?` glob → anchored regex over a package-relative path (picomatch's subset in use). */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*" && glob[i + 1] === "*") {
      if (glob[i + 2] === "/") {
        re += "(?:.*/)?";
        i += 2;
      } else {
        re += ".*";
        i += 1;
      }
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as unknown;
  } catch (err) {
    return { __unreadable: err instanceof Error ? err.message : String(err) };
  }
}

function floorsViolations(
  pkg: string,
  label: string,
  sums: Record<string, Axis>,
  floors: CoverageThresholds,
): string[] {
  const v: string[] = [];
  for (const axis of COVERAGE_AXES) {
    const s = sums[axis];
    if (!s || typeof s.total !== "number" || typeof s.covered !== "number") {
      v.push(`${pkg}: coverage summary has no ${axis} totals`);
      continue;
    }
    const got = pct(s.covered, s.total);
    if (got < floors[axis])
      v.push(`${pkg}: ${axis} coverage ${got}% is below its ${label} threshold ${floors[axis]}%`);
  }
  return v;
}

/** Every violation for one package's artifact dir (`<shard>/<pkg>`). */
export function packageViolations(
  root: string,
  pkg: string,
  dir: string,
  notBefore?: number,
): string[] {
  const v: string[] = [];
  const resultsPath = join(dir, RESULTS_FILE);
  if (!existsSync(resultsPath)) return [`${pkg}: no ${RESULTS_FILE} — its suite never reported`];
  const r = readJson(resultsPath) as Record<string, unknown>;
  const num = (k: string) => (typeof r[k] === "number" ? (r[k] as number) : NaN);
  if ("__unreadable" in r)
    v.push(`${pkg}: ${RESULTS_FILE} is not JSON (${String(r.__unreadable)})`);
  else {
    const total = num("numTotalTests");
    const zeroOk = pkg in ZERO_TEST_PACKAGES;
    if (!(total >= 0)) v.push(`${pkg}: results carry no numTotalTests`);
    else if (total === 0 && !zeroOk)
      v.push(
        `${pkg}: ran 0 tests (no ZERO_TEST_PACKAGES entry) — a suite that runs nothing proves nothing`,
      );
    else if (total > 0 && zeroOk)
      v.push(
        `${pkg}: runs ${total} tests but is listed in ZERO_TEST_PACKAGES — remove the stale entry`,
      );
    const passed = num("numPassedTests");
    const notRun = num("numPendingTests") + num("numTodoTests");
    if (!(passed >= 0)) v.push(`${pkg}: results carry no numPassedTests`);
    else if (passed === 0 && !zeroOk)
      v.push(
        `${pkg}: 0 of ${total} tests passed (${notRun} skipped/pending/todo) — a suite whose tests were all filtered or skipped proves nothing`,
      );
    if (!(notRun >= 0)) v.push(`${pkg}: results carry no numPendingTests / numTodoTests`);
    else if (total > 0 && passed > 0) {
      const heavy = SKIP_HEAVY_PACKAGES[pkg];
      const floor = heavy?.minRunShare ?? MIN_RUN_SHARE;
      // Failed tests are judged below; the share is of the tests that were
      // decided either way or not run at all.
      if (passed + notRun > 0 && passed / (passed + notRun) < floor)
        v.push(
          `${pkg}: only ${passed} of ${passed + notRun} declared, non-failed tests passed (${notRun} skipped/pending/todo) — below its run-share floor ${floor}${heavy ? " (SKIP_HEAVY_PACKAGES)" : " (MIN_RUN_SHARE)"}; a filter or blanket skip ran a fraction of the suite`,
        );
      if (heavy && notRun === 0)
        v.push(
          `${pkg}: skips nothing but is listed in SKIP_HEAVY_PACKAGES — remove the stale entry`,
        );
    }
    if (
      total >= 0 &&
      passed >= 0 &&
      notRun >= 0 &&
      passed + num("numFailedTests") + notRun !== total
    )
      v.push(
        `${pkg}: numTotalTests ${total} ≠ passed ${passed} + failed ${String(r.numFailedTests)} + pending/todo ${notRun} — the counts were not written by one vitest run`,
      );
    const started = num("startTime");
    if (!(started > 0))
      v.push(
        `${pkg}: results carry no startTime — their age cannot be proven against the shard's start`,
      );
    else if (notBefore !== undefined && started < notBefore)
      v.push(
        `${pkg}: results startTime ${new Date(started).toISOString()} precedes its shard job's start ${new Date(notBefore).toISOString()} — a results file from an earlier run`,
      );
    else if (started > Date.now() + CLOCK_SKEW_MS)
      v.push(`${pkg}: results startTime ${new Date(started).toISOString()} is in the future`);
    if (num("numFailedTests") !== 0)
      v.push(`${pkg}: numFailedTests is ${String(r.numFailedTests)}, not 0`);
    if (num("numFailedTestSuites") !== 0)
      v.push(`${pkg}: numFailedTestSuites is ${String(r.numFailedTestSuites)}, not 0`);
    if (r.success !== true) v.push(`${pkg}: vitest reports success ${String(r.success)}`);
    const files = Array.isArray(r.testResults)
      ? (r.testResults as { name?: unknown; status?: unknown }[])
      : null;
    if (files === null) v.push(`${pkg}: results carry no testResults`);
    else {
      if (total > 0 && files.length === 0) v.push(`${pkg}: ${total} tests but no test files`);
      for (const f of files) {
        const name = typeof f.name === "string" ? f.name.replace(/\\/g, "/") : "";
        if (!name.includes(`/${pkg}/`))
          v.push(
            `${pkg}: test file ${JSON.stringify(f.name)} is not inside ${pkg} — another package's results`,
          );
        if (f.status !== "passed")
          v.push(`${pkg}: test file ${name} has status ${String(f.status)}`);
      }
    }
  }

  const endPath = join(dir, RUN_END_FILE);
  if (!existsSync(endPath))
    v.push(`${pkg}: no ${RUN_END_FILE} — the run's end state was never recorded`);
  else {
    const e = readJson(endPath) as { state?: unknown; unhandledErrors?: unknown };
    if (e.state !== "passed")
      v.push(`${pkg}: vitest run ended ${JSON.stringify(e.state)}, not "passed"`);
    if (e.unhandledErrors !== 0)
      v.push(`${pkg}: ${String(e.unhandledErrors)} unhandled error(s) during the run`);
  }

  const summaryPath = join(dir, SUMMARY_FILE);
  const config = CONFIG_NAMES.map((n) => join(root, pkg, n)).find((p) => existsSync(p));
  const floors = config ? readPackageThresholds(config) : null;
  const noFloorOk = pkg in NO_THRESHOLD_PACKAGES;
  if (floors && noFloorOk)
    v.push(
      `${pkg}: declares coverage thresholds but is listed in NO_THRESHOLD_PACKAGES — remove the stale entry`,
    );
  if (!floors && !noFloorOk)
    v.push(
      `${pkg}: its vitest config declares no parseable coverage thresholds (and no NO_THRESHOLD_PACKAGES entry)`,
    );
  if (!existsSync(summaryPath)) {
    v.push(`${pkg}: no ${SUMMARY_FILE} — coverage was never collected`);
    return v;
  }
  const summary = readJson(summaryPath) as Record<string, FileSummary> & { __unreadable?: string };
  if (summary.__unreadable !== undefined || typeof summary.total !== "object") {
    v.push(`${pkg}: ${SUMMARY_FILE} carries no totals`);
    return v;
  }
  if (floors) v.push(...floorsViolations(pkg, "package", summary.total, floors));

  // Per-glob floors, as vitest resolves them: aggregate the files whose
  // package-relative path matches the glob (no match ⇒ 100%, as vitest).
  for (const [glob, gf] of Object.entries(config ? readGlobThresholds(config) : {})) {
    const re = globToRegExp(glob);
    const sums: Record<string, Axis> = {};
    for (const a of COVERAGE_AXES) sums[a] = { total: 0, covered: 0 };
    for (const [file, entry] of Object.entries(summary)) {
      if (file === "total" || typeof entry !== "object" || entry === null) continue;
      const fs = entry as Partial<FileSummary>;
      const norm = file.replace(/\\/g, "/");
      const at = norm.lastIndexOf(`/${pkg}/`);
      const rel = at >= 0 ? norm.slice(at + pkg.length + 2) : norm;
      if (!re.test(rel)) continue;
      for (const a of COVERAGE_AXES) {
        sums[a]!.total += fs[a]?.total ?? 0;
        sums[a]!.covered += fs[a]?.covered ?? 0;
      }
    }
    v.push(...floorsViolations(pkg, `"${glob}"`, sums, gf));
  }
  return v;
}

export interface OutcomeReport {
  packages: string[];
  violations: string[];
  /** Tests vitest reported PASSED across every verified package (never skipped/todo). */
  tests: number;
  /** Per package, the tests vitest reported PASSED (summed over the shards that reported it). */
  passed: Record<string, number>;
  /**
   * The floor violations alone (also in `violations`): what `--write-floors`
   * may resolve. Anything else in `violations` means the run is not one to
   * measure floors from.
   */
  floorViolations: string[];
}

/**
 * Every tracked file under the root `coverage/` or a workspace package's
 * `coverage/` — where the shards' uploads (and so this verdict's inputs) live.
 * A committed results or summary file would be a checkout shipping its own
 * verdict. Fails closed when git cannot answer.
 */
export function trackedCoverageFiles(root: string): string[] | { error: string } {
  const r = spawnSync("git", ["ls-files", "-z"], {
    cwd: root,
    encoding: "utf8",
    env: cleanEnv(),
  });
  if (r.status !== 0 || r.error)
    return { error: (r.stderr || String(r.error ?? `exit ${String(r.status)}`)).trim() };
  return r.stdout
    .split("\0")
    .filter((f) => /^(?:coverage|[^/]+\/[^/]+\/coverage)\//.test(f))
    .sort();
}

/**
 * The whole verdict: every workspace package with a `test:coverage` script
 * reported by exactly one shard artifact, each passing packageViolations, and
 * no results for a package the workspace does not declare.
 */
export function verifyOutcomes(root: string, artifacts: string): OutcomeReport {
  const packages = workspaceCoveragePackages(root);
  const violations: string[] = [];
  if (!existsSync(artifacts))
    return {
      packages,
      violations: [`artifact dir ${artifacts} does not exist — no shard reported`],
      tests: 0,
      passed: {},
      floorViolations: [],
    };
  const shards = readdirSync(artifacts, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  if (shards.length === 0) violations.push(`artifact dir ${artifacts} holds no shard artifact`);

  // Every results file anywhere in every shard → the package dir it belongs to.
  const found = new Map<string, string[]>();
  const walk = (shard: string, rel: string) => {
    const abs = join(artifacts, shard, rel);
    for (const e of readdirSync(abs, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (e.name !== "node_modules") walk(shard, r);
      } else if (r.endsWith(`/${RESULTS_FILE}`)) {
        const pkg = r.slice(0, -(RESULTS_FILE.length + 1));
        found.set(pkg, [...(found.get(pkg) ?? []), shard]);
      }
    }
  };
  for (const s of shards) walk(s, "");

  const tracked = trackedCoverageFiles(root);
  if (!Array.isArray(tracked))
    violations.push(
      `cannot list the checkout's tracked files (git ls-files: ${tracked.error}) — fail closed`,
    );
  else
    for (const f of tracked)
      violations.push(
        `${f} is tracked in git — coverage/ holds the run's own outputs, never committed ones`,
      );

  // Each shard's start, from the stamp its CI job wrote before any suite ran.
  const notBefore = new Map<string, number>();
  for (const s of shards) {
    const p = join(artifacts, s, SHARD_STAMP_FILE);
    if (!existsSync(p)) {
      violations.push(
        `${s}: no ${SHARD_STAMP_FILE} — nothing to date its results against (ci.yml writes it first in every test-coverage shard)`,
      );
      continue;
    }
    const at = (readJson(p) as { startedAt?: unknown }).startedAt;
    if (typeof at !== "number" || !(at > 0))
      violations.push(`${s}: ${SHARD_STAMP_FILE} carries no numeric startedAt`);
    else if (at > Date.now() + CLOCK_SKEW_MS)
      violations.push(
        `${s}: ${SHARD_STAMP_FILE} startedAt ${new Date(at).toISOString()} is in the future`,
      );
    else notBefore.set(s, at);
  }

  const want = new Set(packages);
  for (const [pkg, where] of found)
    if (!want.has(pkg))
      violations.push(
        `results for ${pkg} (in ${where.join(", ")}), which is not a workspace package with a test:coverage script`,
      );
  let tests = 0;
  const passed: Record<string, number> = {};
  for (const pkg of packages) {
    const where = found.get(pkg) ?? [];
    if (where.length === 0) {
      violations.push(
        `${pkg}: no shard artifact carries its ${RESULTS_FILE} — its suite never ran in CI`,
      );
      continue;
    }
    if (where.length > 1)
      violations.push(
        `${pkg}: reported by ${where.length} shards (${where.join(", ")}), not exactly one`,
      );
    for (const s of where) {
      violations.push(...packageViolations(root, pkg, join(artifacts, s, pkg), notBefore.get(s)));
      const r = readJson(join(artifacts, s, pkg, RESULTS_FILE)) as { numPassedTests?: unknown };
      if (typeof r.numPassedTests === "number") {
        tests += r.numPassedTests;
        passed[pkg] = (passed[pkg] ?? 0) + r.numPassedTests;
      }
    }
  }

  // The suite's size, held outside the suite's own declaration.
  const floorViolations: string[] = [];
  const ff = readFloors(root);
  if (typeof ff === "string")
    floorViolations.push(`${ff} — fail closed: no floor to judge against`);
  else {
    for (const pkg of packages) {
      const floor = ff.floors[pkg];
      if (floor === undefined)
        floorViolations.push(
          `${pkg}: no entry in ${FLOORS_FILE} — a package whose suite size nobody committed can be narrowed to one test unseen`,
        );
      else if (pkg in passed && passed[pkg]! < floor)
        floorViolations.push(
          `${pkg}: ${passed[pkg]} test(s) passed, below its committed floor of ${floor} (${FLOORS_FILE}) — the suite ran narrower than it is (a script naming one file, --shard, --changed, a narrowed include/exclude, or deleted tests)`,
        );
    }
    for (const pkg of Object.keys(ff.floors))
      if (!want.has(pkg))
        floorViolations.push(
          `${FLOORS_FILE} has a floor for ${pkg}, which is not a workspace package with a test:coverage script — remove the stale entry (--write-floors drops it)`,
        );
  }
  violations.push(...floorViolations);
  return { packages, violations, tests, passed, floorViolations };
}

export interface FloorsUpdate {
  next: FloorsFile;
  added: string[];
  raised: string[];
  lowered: string[];
  /** Measured below the committed floor, left unlowered (no --allow-lower). */
  refused: string[];
  removed: string[];
}

/**
 * The ratchet: the next floors from the committed ones and a full run's
 * per-package passed counts. Raises and adds always; drops a floor whose
 * package no longer runs coverage; lowers ONLY with `allowLower` (the reason),
 * recording `{from, to, reason}` in allowedDecreases. An allowance whose `to`
 * is no longer the floor is dropped — it describes a decrease that is gone.
 */
export function nextFloors(
  current: FloorsFile | null,
  measured: Record<string, number>,
  allowLower: string | null,
): FloorsUpdate {
  const old = current?.floors ?? {};
  const floors: Record<string, number> = {};
  const allowedDecreases = { ...(current?.allowedDecreases ?? {}) };
  const u: Omit<FloorsUpdate, "next"> = {
    added: [],
    raised: [],
    lowered: [],
    refused: [],
    removed: [],
  };
  for (const pkg of Object.keys(measured).sort()) {
    const m = measured[pkg]!;
    const o = old[pkg];
    if (o === undefined) {
      floors[pkg] = m;
      u.added.push(`${pkg} ${m}`);
    } else if (m > o) {
      floors[pkg] = m;
      u.raised.push(`${pkg} ${o} → ${m}`);
    } else if (m < o && allowLower !== null) {
      floors[pkg] = m;
      allowedDecreases[pkg] = { from: o, to: m, reason: allowLower };
      u.lowered.push(`${pkg} ${o} → ${m}`);
    } else {
      floors[pkg] = o;
      if (m < o) u.refused.push(`${pkg} measured ${m} < floor ${o}`);
    }
  }
  for (const pkg of Object.keys(old)) if (!(pkg in measured)) u.removed.push(pkg);
  for (const [pkg, a] of Object.entries(allowedDecreases))
    if (floors[pkg] !== a.to) delete allowedDecreases[pkg];
  return { next: { floors, allowedDecreases: sortKeys(allowedDecreases) }, ...u };
}

function sortKeys<T>(o: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** The floors file's committed text: stable key order, a trailing newline. */
export function formatFloors(f: FloorsFile): string {
  return `${JSON.stringify({ floors: sortKeys(f.floors), allowedDecreases: sortKeys(f.allowedDecreases) }, null, 2)}\n`;
}

function main(argv: string[]): void {
  const arg = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const artifacts = arg("--artifacts");
  if (artifacts == null) {
    console.error("usage: verify-test-outcomes.ts --artifacts <dir> [--root <workspace>]");
    process.exit(2);
  }
  const root = arg("--root") ?? process.cwd();
  const r = verifyOutcomes(root, artifacts);
  if (argv.includes("--write-floors")) {
    writeFloors(root, artifacts, r, argv.includes("--allow-lower") ? arg("--allow-lower") : null);
    return;
  }
  if (r.violations.length > 0)
    failWithRepair({
      invariant:
        "every workspace package with a test:coverage script ran in exactly one CI shard and vitest itself reported it, in this run: tests passed > 0 and at least its run-share floor of the declared tests, none failed, no unhandled error, results started after the shard job did, nothing under coverage/ tracked in git, coverage at or above the package's own thresholds, and at least its committed floor of tests passed (scripts/test-outcome-floors.json)",
      sites: r.violations,
      canonical:
        "vitest's own results (MOTEBIT_TEST_REPORTERS in vitest.shared.ts) judged by scripts/verify-test-outcomes.ts; packages enumerated from pnpm-workspace.yaml",
      fix: 'Fix the failing suite or raise its coverage (never lower a threshold). A package missing from every shard means the shard runner skipped it — fix scripts/test-coverage-shards.ts. A missing results file means its vitest config dropped MOTEBIT_TEST_REPORTERS (or a CLI --reporter replaced them). A run-share failure means a -t filter or blanket .skip — remove it, or give a package that genuinely skips a reasoned SKIP_HEAVY_PACKAGES entry. A tracked coverage/ file: git rm --cached it. A stale startTime: the results predate the shard job — something restored or committed them. A package below its test floor ran narrower than its suite: restore the suite (script, include/exclude, shard flag, deleted tests); if tests were legitimately deleted, re-measure from a full run with `pnpm test:outcomes:verify --artifacts <dir> --write-floors --allow-lower "<reason>"` and commit scripts/test-outcome-floors.json. A package with no floor: after a full run, `pnpm test:outcomes:verify --artifacts <dir> --write-floors` adds it.',
      doctrine: "docs/doctrine/composition-preserves-enforcement.md",
    });
  console.log(
    `✓ verify-test-outcomes: examined ${r.packages.length} workspace package(s) with a test:coverage script (enumerated from pnpm-workspace.yaml, not the shard runner) — each reported by exactly one shard in this run (results dated after their shard job started; nothing under coverage/ tracked), ${r.tests} test(s) passed (skipped/todo not counted; each package ran ≥ its run-share floor, default ${MIN_RUN_SHARE}), 0 failed, every coverage floor met, every package at or above its committed test floor (${FLOORS_FILE}).`,
  );
}

/**
 * `--write-floors`: measure from a run that is green in every respect but the
 * floors, then apply the ratchet. Refuses a run with any other violation — a
 * failing, partial or stale run is not one to measure a suite's size from.
 */
function writeFloors(
  root: string,
  artifacts: string,
  r: OutcomeReport,
  allowLower: string | null | undefined,
): void {
  if (
    allowLower !== null &&
    (allowLower === undefined || allowLower.startsWith("--") || allowLower.trim() === "")
  ) {
    console.error('--allow-lower needs a reason: --allow-lower "<why these tests were deleted>"');
    process.exit(2);
  }
  const other = r.violations.filter((v) => !r.floorViolations.includes(v));
  if (other.length > 0) {
    console.error(
      `✗ --write-floors refused: the run under ${artifacts} is not a full green run (${other.length} violation(s)) — floors are measured only from one:\n${other.map((v) => `  - ${v}`).join("\n")}`,
    );
    process.exit(1);
  }
  const cur = existsSync(join(root, FLOORS_FILE)) ? readFloors(root) : null;
  if (typeof cur === "string") {
    console.error(`✗ --write-floors refused: ${cur} — repair it by hand first`);
    process.exit(1);
  }
  const u = nextFloors(cur, r.passed, allowLower);
  mkdirSync(dirname(join(root, FLOORS_FILE)), { recursive: true });
  writeFileSync(join(root, FLOORS_FILE), formatFloors(u.next));
  const line = (k: string, xs: string[]) =>
    xs.length > 0 && console.log(`  ${k} (${xs.length}): ${xs.join(", ")}`);
  console.log(`wrote ${FLOORS_FILE}: ${Object.keys(u.next.floors).length} package floor(s)`);
  line("added", u.added);
  line("raised", u.raised);
  line("lowered", u.lowered);
  line("removed (package no longer runs coverage)", u.removed);
  if (u.refused.length > 0) {
    console.error(
      `✗ measured below the committed floor, NOT lowered (the ratchet): ${u.refused.join(", ")}. If tests were legitimately deleted, re-run with --allow-lower "<reason>"; otherwise the suite ran narrower than it is.`,
    );
    process.exit(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main(process.argv.slice(2));
