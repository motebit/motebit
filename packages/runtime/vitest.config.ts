import { defineMotebitTest } from "../../vitest.shared.js";

export default defineMotebitTest({
  // Ratcheted to measured (83.32/73.26/83.02/85.12) by scripts/measure-coverage-slack.ts.
  // A floor N points below reality only catches a regression bigger than N.
  thresholds: { statements: 82, branches: 72, functions: 82, lines: 84 },
});
