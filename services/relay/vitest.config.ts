import { defineMotebitTest } from "../../vitest.shared.js";

// functions at 80% not 86%: uncovered functions are standalone boot
// (index.ts), Map interface iterators (task-queue.ts), and admin-only
// key-rotation endpoints — integration-level, not unit-testable.
//
// pool: 'forks' — the relay tests share the module's global runtime
// (event subscribers, deposit-detector interval, sqlite pools). The
// default 'threads' pool runs every file in the same V8 isolate, so
// one file's teardown races against another's interval ticks and
// surfaces as "The database connection is not open" warnings plus
// sporadic CI failures under oversubscribed runners. Forks give each
// file its own process — cross-file state can't leak — while keeping
// files running in parallel. Small wall-time cost for a large
// reliability gain.
// maxForks bounds relay's footprint so it's a good citizen under `turbo run
// test:coverage --concurrency=4` on 4-core CI runners: relay is the heaviest
// suite (101 files), and unbounded forks (~CPU count) co-scheduled with three
// other turbo tasks oversubscribes the runner — coverage instrumentation adds
// per-fork overhead, contention-slowed tests cross their timeout, and the suite
// false-fails. Capping at 2 leaves headroom for the co-scheduled tasks; the
// drain-grace fix (drainGraceMs in test-helpers) already removed the 5s/test
// wall-clock, so 2 forks stays fast enough without the contention risk.
//
// testTimeout/hookTimeout raised 5s/10s → 20s: the residual flake under
// `test:coverage --concurrency=4` is contention-timeout — a relay test slowed by
// CPU starvation + coverage instrumentation crosses the default deadline and
// false-fails (the suite passes standalone). A harness-scoped global timeout bump
// (one knob, reversible) absorbs the slowdown without per-test timeout literals
// embedded in test files — the same reasoning the maxForks/concurrency comment
// endorses. relay tests finish in ms–low-seconds (drain-grace fix), so 20s is pure
// headroom, never masking a genuinely slow test.
export default defineMotebitTest({
  thresholds: { statements: 72, branches: 61, functions: 77, lines: 72 },
  extra: {
    pool: "forks",
    poolOptions: { forks: { maxForks: 2, minForks: 1 } },
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
