/**
 * Fixture workspaces + shard artifact trees for scripts/verify-test-outcomes.ts.
 *
 * One GREEN fixture (what a correct sharded CI run uploads) and the named RED
 * variants — each the artifact shape a known bypass of the shard runner
 * leaves behind. Shared by the verifier's unit test and check-prepush-subset,
 * which executes the verifier against every variant on each `pnpm check`, so a
 * weakened verifier goes RED there and not only in `pnpm test:gates`.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { cleanEnv } from "./differential-tree.js";
import type { CoverageThresholds } from "./vitest-thresholds.js";

export interface FixturePackage {
  /** Package-level floors written into its vitest.config.ts; null = no thresholds block. */
  thresholds: CoverageThresholds | null;
  globs?: Record<string, CoverageThresholds>;
  /** false = a workspace package with no test:coverage script. */
  coverage?: boolean;
}
export interface FixtureReport {
  results?: Record<string, unknown> | null;
  runEnd?: Record<string, unknown> | null;
  summary?: Record<string, unknown> | null;
}
export interface OutcomeFixture {
  workspace: Record<string, FixturePackage>;
  /** shard artifact name → package dir → what that shard uploaded for it. */
  shards: Record<string, Record<string, FixtureReport>>;
  /**
   * shard artifact name → the `coverage/shard-started-at.json` its CI job
   * wrote before running anything (null = none). Absent key = SHARD_STARTED_AT.
   */
  stamps?: Record<string, Record<string, unknown> | null>;
  /** Workspace-relative files committed to the fixture's git repo (path → contents). */
  tracked?: Record<string, string>;
  /**
   * The committed scripts/test-outcome-floors.json `floors` (null = no file).
   * Absent = FIXTURE_FLOOR for every package with test:coverage.
   */
  floors?: Record<string, number> | null;
}

/** Each fixture suite passes 7 tests (passingReport); its committed floor. */
export const FIXTURE_FLOOR = 7;

const F80: CoverageThresholds = { statements: 80, branches: 70, functions: 80, lines: 80 };
const F100: CoverageThresholds = { statements: 100, branches: 100, functions: 100, lines: 100 };
const CI_ROOT = "/home/runner/work/motebit/motebit";
/** When every fixture shard job started (ms since epoch); each suite starts after it. */
export const SHARD_STARTED_AT = 1_790_000_000_000;

const axes = (total: number, covered: number) => ({
  statements: { total, covered, skipped: 0, pct: 0 },
  branches: { total, covered, skipped: 0, pct: 0 },
  functions: { total, covered, skipped: 0, pct: 0 },
  lines: { total, covered, skipped: 0, pct: 0 },
});

/** What a passing suite with coverage uploads for `pkg`. */
export function passingReport(pkg: string): FixtureReport {
  return {
    results: {
      numTotalTestSuites: 2,
      numPassedTestSuites: 2,
      numFailedTestSuites: 0,
      numTotalTests: 7,
      numPassedTests: 7,
      numFailedTests: 0,
      numPendingTests: 0,
      numTodoTests: 0,
      startTime: SHARD_STARTED_AT + 60_000,
      success: true,
      testResults: [
        { name: `${CI_ROOT}/${pkg}/src/__tests__/a.test.ts`, status: "passed" },
        { name: `${CI_ROOT}/${pkg}/src/__tests__/b.test.ts`, status: "passed" },
      ],
    },
    runEnd: { state: "passed", unhandledErrors: 0 },
    summary: {
      total: axes(100, 95),
      [`${CI_ROOT}/${pkg}/src/adapters.ts`]: axes(10, 10),
      [`${CI_ROOT}/${pkg}/src/index.ts`]: axes(90, 85),
    },
  };
}

export function greenFixture(): OutcomeFixture {
  return {
    workspace: {
      "services/relay": { thresholds: F80 },
      "packages/circuit-breaker": { thresholds: F80 },
      "apps/web": { thresholds: F80, globs: { "**/adapters.ts": F100 } },
      "apps/cli": { thresholds: null },
      "packages/types-only": { thresholds: null, coverage: false },
    },
    shards: {
      "coverage-shard-0": { "services/relay": passingReport("services/relay") },
      "coverage-shard-1": {
        "packages/circuit-breaker": passingReport("packages/circuit-breaker"),
        "apps/cli": passingReport("apps/cli"),
      },
      "coverage-shard-2": { "apps/web": passingReport("apps/web") },
    },
  };
}

type Mutate = (f: OutcomeFixture) => void;
const report = (f: OutcomeFixture, shard: string, pkg: string) => f.shards[shard]![pkg]!;
const results = (f: OutcomeFixture, shard: string, pkg: string) =>
  report(f, shard, pkg).results as Record<string, unknown>;
const fixtureFloors = (f: OutcomeFixture): Record<string, number> =>
  f.floors ??
  Object.fromEntries(
    Object.entries(f.workspace)
      .filter(([, p]) => p.coverage !== false)
      .map(([k]) => [k, FIXTURE_FLOOR]),
  );

/**
 * Each RED variant: the artifacts a known bypass leaves, which the verifier
 * must refuse. Keyed by a stable id the tests and the gate name.
 */
export const RED_VARIANTS: Record<string, { what: string; mutate: Mutate }> = {
  "B1-exitcode-zeroed": {
    what: "B1: NODE_OPTIONS --import zeroes the exit code — turbo says '1 failed', the leg exits 0, but vitest's own results say a test failed",
    mutate: (f) => {
      const r = results(f, "coverage-shard-1", "packages/circuit-breaker");
      r.numFailedTests = 1;
      r.numPassedTests = 6;
      r.numFailedTestSuites = 1;
      r.success = false;
      (r.testResults as { status: string }[])[0]!.status = "failed";
      report(f, "coverage-shard-1", "packages/circuit-breaker").runEnd = {
        state: "failed",
        unhandledErrors: 0,
      };
    },
  },
  "B1-github-job-return-0": {
    what: "a runner that returns 0 under GITHUB_JOB==='test-coverage' without running: its shard uploads no results",
    mutate: (f) => {
      f.shards["coverage-shard-1"] = {};
    },
  },
  "B2-enumeration-skips-web": {
    what: "B2: the runner's package list (and its weight) drops apps/web — no shard ever runs it",
    mutate: (f) => {
      delete f.shards["coverage-shard-2"]!["apps/web"];
    },
  },
  "results-file-deleted": {
    what: "one package's results file is missing (coverage summary still present)",
    mutate: (f) => {
      report(f, "coverage-shard-0", "services/relay").results = null;
    },
  },
  "num-failed-tests-flipped": {
    what: "numFailedTests > 0 while the rest of the file still claims success",
    mutate: (f) => {
      results(f, "coverage-shard-1", "apps/cli").numFailedTests = 1;
    },
  },
  "success-false": {
    what: "vitest reports success: false (e.g. a suite that failed to import)",
    mutate: (f) => {
      const r = results(f, "coverage-shard-1", "apps/cli");
      r.success = false;
      r.numFailedTestSuites = 1;
    },
  },
  "zero-tests": {
    what: "the suite ran nothing (a filter or exclude emptied it)",
    mutate: (f) => {
      const r = results(f, "coverage-shard-2", "apps/web");
      r.numTotalTests = 0;
      r.numPassedTests = 0;
      r.testResults = [];
    },
  },
  "unhandled-error": {
    what: "an unhandled error after the tests settled (the JSON results still say success)",
    mutate: (f) => {
      report(f, "coverage-shard-2", "apps/web").runEnd = { state: "failed", unhandledErrors: 1 };
    },
  },
  "run-end-missing": {
    what: "the run-end record is missing",
    mutate: (f) => {
      report(f, "coverage-shard-2", "apps/web").runEnd = null;
    },
  },
  "coverage-below-threshold": {
    what: "package coverage below its own declared floor",
    mutate: (f) => {
      const s = report(f, "coverage-shard-1", "packages/circuit-breaker").summary as {
        total: { statements: { covered: number } };
      };
      s.total.statements.covered = 50;
    },
  },
  "glob-floor-below": {
    what: 'a per-glob floor ("**/adapters.ts": 100) missed while the package total still passes',
    mutate: (f) => {
      const s = report(f, "coverage-shard-2", "apps/web").summary as Record<
        string,
        { lines: { covered: number } }
      >;
      s[`${CI_ROOT}/apps/web/src/adapters.ts`]!.lines.covered = 9;
    },
  },
  "summary-missing": {
    what: "coverage never collected (no coverage-summary.json)",
    mutate: (f) => {
      report(f, "coverage-shard-0", "services/relay").summary = null;
    },
  },
  "reported-twice": {
    what: "a package reported by two shards",
    mutate: (f) => {
      f.shards["coverage-shard-0"]!["packages/circuit-breaker"] = passingReport(
        "packages/circuit-breaker",
      );
    },
  },
  "foreign-package": {
    what: "results for a package the workspace does not declare with test:coverage",
    mutate: (f) => {
      f.shards["coverage-shard-0"]!["packages/types-only"] = passingReport("packages/types-only");
    },
  },
  "results-copied-from-another-package": {
    what: "apps/web's results file is circuit-breaker's, copied",
    mutate: (f) => {
      report(f, "coverage-shard-2", "apps/web").results = passingReport(
        "packages/circuit-breaker",
      ).results!;
    },
  },
  "all-skipped-name-filter": {
    what: "a test-name filter that matches nothing (`-- -t zzzz-nomatch`, measured on apps/cli: exit 0, numTotalTests 1016, numPassedTests 0, numPendingTests 1016, success true, every file 'passed') — apps/cli has no coverage floor to catch it",
    mutate: (f) => {
      const r = results(f, "coverage-shard-1", "apps/cli");
      r.numPassedTests = 0;
      r.numPendingTests = r.numTotalTests;
    },
  },
  "mostly-skipped": {
    what: "a filter that leaves one test running: 1 passed, the rest skipped — passed > 0 but far below what the suite runs",
    mutate: (f) => {
      const r = results(f, "coverage-shard-2", "apps/web");
      r.numPassedTests = 1;
      r.numPendingTests = 6;
    },
  },
  "todo-padded": {
    what: "the suite's tests turned into it.todo — counted in numTotalTests, never run",
    mutate: (f) => {
      const r = results(f, "coverage-shard-0", "services/relay");
      r.numPassedTests = 1;
      r.numTodoTests = 6;
    },
  },
  "tracked-results-file": {
    what: "a vitest-results.json committed under a package's coverage/ — a checkout that ships its own verdict",
    mutate: (f) => {
      f.tracked = {
        "apps/web/coverage/vitest-results.json": JSON.stringify(passingReport("apps/web").results),
      };
    },
  },
  "tracked-summary-file": {
    what: "a coverage-summary.json committed under a package's coverage/",
    mutate: (f) => {
      f.tracked = { "packages/circuit-breaker/coverage/coverage-summary.json": "{}" };
    },
  },
  "stale-start-time": {
    what: "a results file from an earlier run (its startTime precedes the shard job's own start stamp)",
    mutate: (f) => {
      results(f, "coverage-shard-0", "services/relay").startTime = SHARD_STARTED_AT - 86_400_000;
    },
  },
  "no-start-time": {
    what: "a results file carrying no startTime — its age cannot be proven",
    mutate: (f) => {
      delete results(f, "coverage-shard-2", "apps/web").startTime;
    },
  },
  "narrowed-to-one-file": {
    what: "the suite's DECLARATION narrowed (measured on apps/cli: test:coverage = `vitest run src/__tests__/approval-render.test.ts --coverage` ran 11 of 1017 tests — exit 0, success true, nothing skipped, so the run-share rule sees 11/11; apps/cli has no coverage floor) — only the committed test floor catches it",
    mutate: (f) => {
      const r = results(f, "coverage-shard-1", "apps/cli");
      r.numTotalTests = 1;
      r.numPassedTests = 1;
      r.testResults = (r.testResults as unknown[]).slice(0, 1);
    },
  },
  "floor-missing": {
    what: "a package with test:coverage has no entry in the committed floors — its suite size is nobody's to check",
    mutate: (f) => {
      const fl = { ...fixtureFloors(f) };
      delete fl["apps/cli"];
      f.floors = fl;
    },
  },
  "new-package-without-floor": {
    what: "a NEW workspace package that runs and passes, added without a floor entry — fail closed until the floor is written",
    mutate: (f) => {
      f.floors = fixtureFloors(f);
      f.workspace["packages/brand-new"] = { thresholds: F80 };
      f.shards["coverage-shard-2"]!["packages/brand-new"] = passingReport("packages/brand-new");
    },
  },
  "floors-file-missing": {
    what: "no scripts/test-outcome-floors.json at all — fail closed",
    mutate: (f) => {
      f.floors = null;
    },
  },
  "stale-floor": {
    what: "a floor for a package that no longer runs coverage — a floors file that drifted from the workspace",
    mutate: (f) => {
      f.floors = { ...fixtureFloors(f), "packages/types-only": 3 };
    },
  },
  "shard-stamp-missing": {
    what: "a shard artifact without the start stamp its CI job writes first — nothing to date its results against",
    mutate: (f) => {
      f.stamps = { "coverage-shard-1": null };
    },
  },
};

function vitestConfig(p: FixturePackage): string {
  if (!p.thresholds) return `export default { test: {} };\n`;
  const floors = (t: CoverageThresholds) =>
    `statements: ${t.statements}, branches: ${t.branches}, functions: ${t.functions}, lines: ${t.lines}`;
  const globs = Object.entries(p.globs ?? {})
    .map(([g, t]) => `\n      ${JSON.stringify(g)}: { ${floors(t)} },`)
    .join("");
  return `export default defineMotebitTest({\n  thresholds: {${globs}\n      ${floors(p.thresholds)},\n  },\n});\n`;
}

/** Writes `<dir>/workspace` and `<dir>/artifacts` for `f`; returns both paths. */
export function materialize(f: OutcomeFixture, dir: string): { root: string; artifacts: string } {
  const root = join(dir, "workspace");
  const artifacts = join(dir, "artifacts");
  const bases = [...new Set(Object.keys(f.workspace).map((k) => k.split("/")[0]!))].sort();
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, "pnpm-workspace.yaml"),
    `packages:\n${bases.map((b) => `  - "${b}/*"\n`).join("")}`,
  );
  for (const [pkg, p] of Object.entries(f.workspace)) {
    mkdirSync(join(root, pkg), { recursive: true });
    const scripts: Record<string, string> = { test: "vitest run" };
    if (p.coverage !== false) scripts["test:coverage"] = "vitest run --coverage";
    writeFileSync(join(root, pkg, "package.json"), JSON.stringify({ name: pkg, scripts }));
    writeFileSync(join(root, pkg, "vitest.config.ts"), vitestConfig(p));
  }
  mkdirSync(artifacts, { recursive: true });
  const put = (file: string, body: unknown) => {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(body));
  };
  if (f.floors !== null) {
    mkdirSync(join(root, "scripts"), { recursive: true });
    writeFileSync(
      join(root, "scripts", "test-outcome-floors.json"),
      JSON.stringify({ floors: fixtureFloors(f), allowedDecreases: {} }, null, 2),
    );
  }
  for (const [rel, body] of Object.entries(f.tracked ?? {})) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  // A real checkout: the verifier asks git what is tracked. cleanEnv() so a
  // hook's GIT_DIR / GIT_INDEX_FILE can never point this at the real repo.
  const git = (...args: string[]) => {
    const r = spawnSync("git", args, { cwd: root, encoding: "utf8", env: cleanEnv() });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  };
  git("init", "-q");
  git("add", "-A", "-f");
  git(
    "-c",
    "user.name=fixture",
    "-c",
    "user.email=fixture@invalid",
    "commit",
    "-q",
    "--no-verify",
    "-m",
    "fixture",
  );
  for (const [shard, pkgs] of Object.entries(f.shards)) {
    mkdirSync(join(artifacts, shard, "coverage"), { recursive: true });
    const stamp = f.stamps && shard in f.stamps ? f.stamps[shard] : { startedAt: SHARD_STARTED_AT };
    if (stamp) put(join(artifacts, shard, "coverage", "shard-started-at.json"), stamp);
    for (const [pkg, r] of Object.entries(pkgs)) {
      const cov = join(artifacts, shard, pkg, "coverage");
      mkdirSync(cov, { recursive: true });
      if (r.results) put(join(cov, "vitest-results.json"), r.results);
      if (r.runEnd) put(join(cov, "vitest-run-end.json"), r.runEnd);
      if (r.summary) put(join(cov, "coverage-summary.json"), r.summary);
    }
  }
  return { root, artifacts };
}
