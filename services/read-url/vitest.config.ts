import { defineMotebitTest } from "../../vitest.shared.js";

export default defineMotebitTest({
  coverageExclude: ["src/index.ts"],
  // Ratcheted to measured (100 on all four axes) by scripts/measure-coverage-slack.ts.
  // A floor N points below reality only catches a regression bigger than N.
  thresholds: { statements: 100, branches: 100, functions: 100, lines: 100 },
});
