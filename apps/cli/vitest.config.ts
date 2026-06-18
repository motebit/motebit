import { defineConfig } from "vitest/config";

// vitest 4's default `exclude` only covers node_modules/.git (vitest 2 also
// excluded dist/coverage). This package runs a bare `vitest run` with no
// shared config, and the turbo `test` task builds first (`dependsOn: build`),
// so without an explicit exclude vitest would discover compiled `*.test.js`
// under dist/ alongside the real src tests — running stale artifacts. Restore
// the standard excludes. (Coverage config is intentionally omitted: this
// package's `test:coverage` collects without per-package thresholds.)
export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "**/dist/**", "**/coverage/**"],
    // 15s, not vitest's default 5s. These are integration-shaped tests — real
    // in-memory SQLite + a full GoalScheduler `tickOnce()` — that finish in
    // milliseconds in isolation but get CPU-starved when the Release job runs
    // every package's `test:coverage` concurrently under turbo. A normally-fast
    // `scheduler-approvals` tick intermittently blew the 5s default and failed
    // the publish run (2026-06-18). The work is fast; the budget was too tight
    // for the contention. A correct test still completes well under this ceiling
    // — it only delays how long a genuinely hung test takes to surface.
    testTimeout: 15_000,
  },
});
