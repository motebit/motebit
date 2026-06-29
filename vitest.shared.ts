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

import { defineConfig, type ViteUserConfig } from "vitest/config";
import type { InlineConfig } from "vitest/node";

export interface MotebitVitestOptions {
  /** Per-package coverage thresholds. Required. */
  thresholds: {
    statements: number;
    branches: number;
    functions: number;
    lines: number;
  };
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

export function defineMotebitTest(opts: MotebitVitestOptions): ViteUserConfig {
  const { thresholds, testExclude = [], coverageInclude, coverageExclude = [], extra, vite } = opts;

  return defineConfig({
    ...(vite ?? {}),
    test: {
      testTimeout: DEFAULT_TEST_TIMEOUT_MS,
      // `extra` spreads after, so a package can still override the default.
      ...(extra ?? {}),
      exclude: [...BASE_TEST_EXCLUDE, ...testExclude],
      coverage: {
        include: coverageInclude ?? BASE_COVERAGE_INCLUDE,
        exclude: [...BASE_COVERAGE_EXCLUDE, ...coverageExclude],
        thresholds,
      },
    },
  });
}
