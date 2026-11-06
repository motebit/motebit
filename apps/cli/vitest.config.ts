import { defineConfig } from "vitest/config";
import { MOTEBIT_TEST_REPORTERS, REAL_MODEL_GUARD_ALIAS } from "../../vitest.shared.js";

// vitest 4's default `exclude` only covers node_modules/.git (vitest 2 also
// excluded dist/coverage). This package runs a bare `vitest run` with no
// shared config, and the turbo `test` task builds first (`dependsOn: build`),
// so without an explicit exclude vitest would discover compiled `*.test.js`
// under dist/ alongside the real src tests — running stale artifacts. Restore
// the standard excludes.
export default defineConfig({
  // No unit test loads the real embedding model — the same guard every
  // defineMotebitTest package gets (vitest.real-model-guard.ts).
  resolve: { alias: REAL_MODEL_GUARD_ALIAS },
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
    // Same contention budget for HOOKS. `relay.test.ts`'s beforeAll (an
    // in-process relay boot) blew vitest's 10s hook default when the pre-push
    // gauntlet ran the whole repo after a @motebit/protocol change (#696 item
    // 4); it passes standalone 22/22. A hook and a test starve the same way.
    hookTimeout: 30_000,
    // The shared reporters (vitest.shared.ts): CI's verdict reads the JSON
    // results file they write, so this bare config must emit it too.
    reporters: MOTEBIT_TEST_REPORTERS,
    // Coverage: the same shape `defineMotebitTest` gives every other package
    // (vitest.shared.ts), spelled out here because this package resolves its
    // own vitest copy and keeps a bare config.
    //
    // `include` is load-bearing. Without it vitest counts only the modules the
    // tests happen to import, so an untested module is absent from the
    // denominator instead of counted as 0% — a missing include reads as a good
    // number, not a low one (#546).
    //
    // `thresholds` are the floor, never lowered (docs/doctrine/coverage-graduation.md).
    // This package signs money transactions (`wallet swap`, `withdraw`,
    // `delegate --sovereign`, `grant create`, the daemon's R4 path) and had no
    // floor until 2026-11-06. check-coverage-config-present now holds every
    // published app, and every app with a money/identity trigger dependency,
    // to one, and, because this config is bare (no defineMotebitTest), also
    // requires the `include` below. Set at the measured level, rounded down (2026-11-06, full src/ denominator of 107 files: 47.03
    // statements / 43.16 branches / 59.21 functions / 46.84 lines). Raise them
    // as tests land; never lower them.
    coverage: {
      include: ["src/**/*.ts"],
      exclude: ["src/__tests__/**", "src/**/*.d.ts"],
      thresholds: { statements: 47, branches: 43, functions: 59, lines: 46 },
      reporter: ["text", "html", "clover", "json", "json-summary"],
    },
  },
});
