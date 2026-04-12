import { defineMotebitTest } from "../../vitest.shared.js";

// functions at 80% not 86%: uncovered functions are standalone boot
// (index.ts), Map interface iterators (task-queue.ts), and admin-only
// key-rotation endpoints — integration-level, not unit-testable.
export default defineMotebitTest({
  thresholds: { statements: 72, branches: 70, functions: 80, lines: 72 },
});
