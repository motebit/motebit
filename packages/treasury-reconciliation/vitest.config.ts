import { defineMotebitTest } from "../../vitest.shared.js";

// Money-path package (operator-treasury observability). Meets the money tier
// floor (90/85/90/90) per the money-identity coverage registry. types.ts is
// excluded as pure types (compile-erased — no runtime statements/branches/
// functions to cover); index.ts (the barrel) is exercised via the test's
// import-through-the-public-surface.
export default defineMotebitTest({
  thresholds: { statements: 90, branches: 85, functions: 90, lines: 90 },
  coverageExclude: ["src/types.ts"],
});
