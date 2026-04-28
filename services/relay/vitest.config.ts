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
export default defineMotebitTest({
  thresholds: { statements: 72, branches: 70, functions: 80, lines: 72 },
  extra: { pool: "forks" },
});
