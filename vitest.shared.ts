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

import { defineConfig, type UserConfig } from "vitest/config";
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
  vite?: Omit<UserConfig, "test">;
}

const BASE_TEST_EXCLUDE = ["**/node_modules/**", "**/dist/**", "**/coverage/**"];
const BASE_COVERAGE_INCLUDE = ["src/**/*.ts"];
const BASE_COVERAGE_EXCLUDE = ["src/__tests__/**", "src/**/*.d.ts"];

export function defineMotebitTest(opts: MotebitVitestOptions): UserConfig {
  const { thresholds, testExclude = [], coverageInclude, coverageExclude = [], extra, vite } = opts;

  return defineConfig({
    ...(vite ?? {}),
    test: {
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
