import { defineMotebitTest } from "../../vitest.shared.js";

// Floor thresholds anchored to the first measured baseline. protocol
// is Layer 0 (Apache-2.0 permissive floor, zero deps) so coverage
// should stay high. The excluded files are pure type-only wire-format
// declarations (interfaces + type aliases, zero runtime exports);
// v8 reports them as 0% because there is no executable code to
// measure, which drags global metrics below threshold. A future
// type-guard pass will move them out of the exclude list.
export default defineMotebitTest({
  coverageExclude: [
    "src/credential-anchor.ts",
    "src/discovery.ts",
    "src/migration.ts",
    "src/dispute.ts",
    "src/settlement-mode.ts",
    "src/goal-lifecycle.ts",
    "src/memory-events.ts",
    "src/plan-lifecycle.ts",
  ],
  thresholds: { statements: 98, branches: 84, functions: 98, lines: 98 },
});
