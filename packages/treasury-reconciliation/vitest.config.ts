import { defineMotebitTest } from "../../vitest.shared.js";

// Money-path package (operator-treasury observability). Meets the money tier
// floor (90/85/90/90) per the money-identity coverage registry. types.ts is
// excluded as pure types (compile-erased — no runtime statements/branches/
// functions to cover); index.ts (the barrel) is exercised via the test's
// import-through-the-public-surface.
export default defineMotebitTest({
  // Ratcheted to measured (100 on all four axes) by scripts/measure-coverage-slack.ts.
  // A floor N points below reality only catches a regression bigger than N.
  thresholds: { statements: 100, branches: 100, functions: 100, lines: 100 },
  coverageExclude: ["src/types.ts"],
});
