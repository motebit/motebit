import { defineMotebitTest } from "../../vitest.shared.js";

// Floor thresholds anchored to the first measured baseline. protocol
// is Layer 0 (MIT, zero deps) so coverage should stay high — the one
// gap is a handful of unexercised discriminant branches in the
// credential/settlement type guards. Raise as those get tested.
export default defineMotebitTest({
  coverageExclude: [
    "src/credential-anchor.ts",
    "src/discovery.ts",
    "src/migration.ts",
    "src/dispute.ts",
    "src/settlement-mode.ts",
  ],
  thresholds: { statements: 98, branches: 96, functions: 98, lines: 98 },
});
