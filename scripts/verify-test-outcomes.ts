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
 *
 * Usage (CI's `check` job, after downloading every `coverage-shard-*`):
 *   tsx scripts/verify-test-outcomes.ts --artifacts /tmp/coverage-shards [--root .]
 * `<artifacts>/<shard-artifact>/<package-dir>/coverage/…` is the layout
 * actions/download-artifact produces for the shard uploads.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";
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
 * Packages whose suite legitimately runs zero tests, with the reason. Empty:
 * every package with a `test:coverage` script has tests. An entry for a
 * package that does run tests is stale and RED, so the list cannot hide one.
 */
export const ZERO_TEST_PACKAGES: Record<string, string> = {};

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
export function packageViolations(root: string, pkg: string, dir: string): string[] {
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
  /** Tests vitest reported across every verified package. */
  tests: number;
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

  const want = new Set(packages);
  for (const [pkg, where] of found)
    if (!want.has(pkg))
      violations.push(
        `results for ${pkg} (in ${where.join(", ")}), which is not a workspace package with a test:coverage script`,
      );
  let tests = 0;
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
      violations.push(...packageViolations(root, pkg, join(artifacts, s, pkg)));
      const r = readJson(join(artifacts, s, pkg, RESULTS_FILE)) as { numTotalTests?: unknown };
      if (typeof r.numTotalTests === "number") tests += r.numTotalTests;
    }
  }
  return { packages, violations, tests };
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
  if (r.violations.length > 0)
    failWithRepair({
      invariant:
        "every workspace package with a test:coverage script ran in exactly one CI shard and vitest itself reported it: tests > 0, none failed, no unhandled error, coverage at or above the package's own thresholds",
      sites: r.violations,
      canonical:
        "vitest's own results (MOTEBIT_TEST_REPORTERS in vitest.shared.ts) judged by scripts/verify-test-outcomes.ts; packages enumerated from pnpm-workspace.yaml",
      fix: "Fix the failing suite or raise its coverage (never lower a threshold). A package missing from every shard means the shard runner skipped it — fix scripts/test-coverage-shards.ts. A missing results file means its vitest config dropped MOTEBIT_TEST_REPORTERS (or a CLI --reporter replaced them).",
      doctrine: "docs/doctrine/composition-preserves-enforcement.md",
    });
  console.log(
    `✓ verify-test-outcomes: examined ${r.packages.length} workspace package(s) with a test:coverage script (enumerated from pnpm-workspace.yaml, not the shard runner) — each reported by exactly one shard, ${r.tests} test(s) passed, 0 failed, every coverage floor met.`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main(process.argv.slice(2));
