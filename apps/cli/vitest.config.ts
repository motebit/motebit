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
    // 30s, not vitest's default 5s. These are integration-shaped tests — real
    // in-memory SQLite + a full GoalScheduler `tickOnce()` — that finish in
    // milliseconds in isolation but get CPU-starved when the Release job runs
    // every package's tests under load. A normally-fast `scheduler-approvals`
    // tick intermittently blew the 5s default and failed the publish run
    // (2026-06-18 → raised 5s→15s), then blew 15s the same way (2026-06-29,
    // release run on #230 — by then the workspace had grown to 52 ignore-listed
    // packages and the contention with it). The work is genuinely fast (~ms; a
    // 6s spike shows even in isolation = runtime/GC/scheduler variance, not a
    // hang), so this is a CONTENTION BUDGET, not a bug being masked: raising it
    // costs nothing on normal runs (a timeout only fires when exceeded) and only
    // delays how long a genuinely hung test takes to surface. 30s gives ~2x
    // headroom over the last failure and ~5x over the worst isolation spike.
    //
    // ESCALATION (if even 30s recurs): the durable cure is structural, not a
    // bigger number — contention grows as packages are added, so the next step
    // is reducing the publish path's concurrency (release.yml's "Test published
    // packages" step re-runs full suites that already passed in PR CI). Cap
    // vitest workers there, or thin that step to a build/smoke check. Do NOT
    // just bump this past 30s — that IS the treadmill.
    testTimeout: 30_000,
  },
});
