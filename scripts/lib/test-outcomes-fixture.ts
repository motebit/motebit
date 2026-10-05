/**
 * Fixture workspaces + shard artifact trees for scripts/verify-test-outcomes.ts.
 *
 * One GREEN fixture (what a correct sharded CI run uploads) and the named RED
 * variants — each the artifact shape a known bypass of the shard runner
 * leaves behind. Shared by the verifier's unit test and check-prepush-subset,
 * which executes the verifier against every variant on each `pnpm check`, so a
 * weakened verifier goes RED there and not only in `pnpm test:gates`.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
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
}

const F80: CoverageThresholds = { statements: 80, branches: 70, functions: 80, lines: 80 };
const F100: CoverageThresholds = { statements: 100, branches: 100, functions: 100, lines: 100 };
const CI_ROOT = "/home/runner/work/motebit/motebit";

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
  for (const [shard, pkgs] of Object.entries(f.shards)) {
    mkdirSync(join(artifacts, shard, "coverage"), { recursive: true });
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
