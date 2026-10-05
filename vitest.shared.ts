/**
 * Shared vitest config factory for the Motebit monorepo.
 *
 * Every package's `vitest.config.ts` calls `defineMotebitTest(...)` with its
 * per-package thresholds and any specific overrides. The factory supplies the
 * canonical defaults so the monorepo stays consistent without 41 copies of the
 * same boilerplate.
 *
 * Canonical defaults baked in:
 *   - test.exclude:     ["**​/node_modules/**", "**​/dist/**", "**​/coverage/**"]
 *   - coverage.include: ["src/**​/*.ts"]
 *   - coverage.exclude: ["src/__tests__/**", "src/**​/*.d.ts"]
 *
 * Per-package overrides (all optional except `thresholds`):
 *   - testExclude      — extra globs for test discovery
 *   - coverageInclude  — override coverage.include (e.g., ["src/**​/*.{ts,tsx}"])
 *   - coverageExclude  — additional coverage.exclude entries
 *   - extra            — any other vitest `test.*` options (setupFiles, env,
 *                        testTimeout, server.deps.inline, plugins inside test, …)
 *   - vite             — top-level Vite config extras (plugins at the root)
 *
 * Thresholds are required because the project policy (see feedback memory) is
 * "never lower coverage thresholds; write tests to meet them." Forcing the
 * declaration prevents accidental omission.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { defineConfig, type ViteUserConfig } from "vitest/config";
import type { InlineConfig } from "vitest/node";

/** The four coverage axes, as a package floor or a per-glob floor. */
export interface CoverageFloors {
  statements: number;
  branches: number;
  functions: number;
  lines: number;
}

export interface MotebitVitestOptions {
  /**
   * Per-package coverage thresholds. Required.
   *
   * Optionally carries per-glob floors alongside the package-wide ones, e.g.
   * `{ statements: 58, …, "**​/adapters.ts": { statements: 100, … } }`.
   * Vitest applies a glob entry to the files it matches and the bare axes to
   * everything else.
   *
   * The reason this exists (#568): widening `coverage.include` to cover a file
   * that was previously excluded necessarily drags the PACKAGE aggregate down
   * toward the newly-measured file, which reads as "someone lowered the
   * thresholds" even when strictly more code became guarded. A per-glob floor
   * lets the already-well-covered file keep its own high bar, so widening
   * scope never costs enforcement anywhere — which is what the project's
   * "never lower coverage thresholds" policy is actually protecting.
   */
  thresholds: CoverageFloors & Record<string, CoverageFloors | number>;
  /** Extra test-file exclude globs (e.g., "**​/e2e/**", "**​/src-tauri/**"). */
  testExclude?: string[];
  /** Override `coverage.include` (default: `["src/**​/*.ts"]`). */
  coverageInclude?: string[];
  /** Additional coverage.exclude paths (merged with `src/__tests__/**`, `*.d.ts`). */
  coverageExclude?: string[];
  /** Extra `test.*` options. Use sparingly — prefer the typed fields above. */
  extra?: Omit<InlineConfig, "exclude" | "coverage">;
  /** Top-level Vite config extras (plugins, resolve, etc.). */
  vite?: Omit<ViteUserConfig, "test">;
}

const BASE_TEST_EXCLUDE = ["**/node_modules/**", "**/dist/**", "**/coverage/**"];
const BASE_COVERAGE_INCLUDE = ["src/**/*.ts"];
const BASE_COVERAGE_EXCLUDE = ["src/__tests__/**", "src/**/*.d.ts"];

// 30s, not vitest's default 5s. The monorepo's `test:coverage` runs every
// package concurrently under turbo (CI `check` + the Release job), so an
// integration-shaped test that finishes in milliseconds in isolation can get
// CPU-starved enough to blow a tight timeout and fail the whole run — a pure
// contention flake, not a slow test. Seen on apps/cli `scheduler-approvals`
// (fixed inline, bare config) and `@motebit/ai-core` terrarium; this default
// went 5s→15s for it, then 15s blew the same way on `@motebit/verify`
// published-contents (2026-06-29, CI `check` job) as the workspace grew to 52
// ignore-listed packages and the contention with it. Raising the shared default
// fixes the class in ONE place instead of per-package; a correct test still
// completes well under this ceiling (raising costs nothing on normal runs — a
// timeout only fires when exceeded), so the only effect is how long a genuinely
// hung test takes to surface. Override per-package via `extra.testTimeout`.
//
// ESCALATION (if 30s recurs): the cure is structural, not a bigger number —
// contention grows with every package added, so cap the test concurrency
// (turbo `--concurrency`, or vitest workers) rather than bumping this again.
const DEFAULT_TEST_TIMEOUT_MS = 30_000;

/**
 * Where every suite writes vitest's own machine-readable verdict, relative to
 * the package. CI's `check` verdict job (scripts/verify-test-outcomes.ts)
 * reads this file — not any runner's exit code — to prove each package's tests
 * ran (numTotalTests > 0), passed (numFailedTests 0, success true), next to
 * the coverage-summary.json it checks against the package's own thresholds.
 * Inside `coverage/` so the shard upload already carries it.
 */
export const TEST_RESULTS_FILE = "coverage/vitest-results.json";

/**
 * vitest's JSON results count failed tests and suites but not UNHANDLED errors
 * (an error thrown after a test settles fails the run, yet the JSON still says
 * `success: true`). This file records the run's own end state — vitest's
 * `passed | failed | interrupted` and the unhandled-error count, both handed
 * to `onTestRunEnd` by vitest — so the verifier sees those failures too.
 */
export const TEST_RUN_END_FILE = "coverage/vitest-run-end.json";

/** Writes TEST_RUN_END_FILE (relative to the package root vitest runs in). */
// Structurally typed (not `Reporter`): apps/cli resolves a different vitest
// copy, whose nominal Reporter type this would not satisfy.
const runEndReporter = {
  onInit(ctx: { config: { root: string } }): void {
    runEndRoot = ctx.config.root;
  },
  onTestRunEnd(_modules: readonly unknown[], errors: readonly unknown[], state: string): void {
    const file = join(runEndRoot ?? process.cwd(), TEST_RUN_END_FILE);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify({ state, unhandledErrors: errors.length })}\n`);
  },
};
let runEndRoot: string | undefined;

/**
 * The reporters every suite runs: vitest's defaults (`default`, plus
 * `github-actions` annotations under Actions — what an unset `reporters`
 * resolves to) the JSON verdict at TEST_RESULTS_FILE, and the run-end state at TEST_RUN_END_FILE. Set after `extra`
 * so no package can drop the verdict file; a CLI `--reporter` replaces the
 * list, which the verifier then reads as a missing verdict (fail-closed).
 */
export const MOTEBIT_TEST_REPORTERS = [
  "default" as const,
  ...(process.env.GITHUB_ACTIONS === "true" ? ["github-actions" as const] : []),
  ["json" as const, { outputFile: TEST_RESULTS_FILE }] as ["json", { outputFile: string }],
  runEndReporter,
];

export function defineMotebitTest(opts: MotebitVitestOptions): ViteUserConfig {
  const { thresholds, testExclude = [], coverageInclude, coverageExclude = [], extra, vite } = opts;

  return defineConfig({
    ...(vite ?? {}),
    test: {
      testTimeout: DEFAULT_TEST_TIMEOUT_MS,
      // `extra` spreads after, so a package can still override the default.
      ...(extra ?? {}),
      reporters: MOTEBIT_TEST_REPORTERS,
      exclude: [...BASE_TEST_EXCLUDE, ...testExclude],
      coverage: {
        include: coverageInclude ?? BASE_COVERAGE_INCLUDE,
        exclude: [...BASE_COVERAGE_EXCLUDE, ...coverageExclude],
        thresholds,
        // vitest's own defaults plus `json-summary`, which writes
        // `coverage/coverage-summary.json` — the machine-readable totals that
        // `scripts/measure-coverage-slack.ts` compares against the declared
        // floors. Deliberately vitest's numbers rather than arithmetic of our
        // own over `coverage-final.json`: these are the exact figures the
        // thresholds are checked against, so a slack report can never disagree
        // with the gate that enforces them. The four defaults are re-listed
        // because naming `reporter` replaces the list rather than extending it.
        reporter: ["text", "html", "clover", "json", "json-summary"],
      },
    },
  });
}
