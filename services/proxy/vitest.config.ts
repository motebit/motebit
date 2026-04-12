import { defineMotebitTest } from "../../vitest.shared.js";

// proxy only unit-tests the validation module; everything else is the
// Next.js edge proxy handlers exercised via E2E deploy smoke tests.
export default defineMotebitTest({
  coverageInclude: ["src/validation.ts"],
  thresholds: { statements: 70, branches: 60, functions: 65, lines: 70 },
});
