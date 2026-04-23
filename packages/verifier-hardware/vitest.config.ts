import { defineMotebitTest } from "../../vitest.shared.js";

export default defineMotebitTest({
  coverageInclude: ["src/**/*.ts"],
  coverageExclude: ["src/cli.ts"],
  thresholds: { statements: 90, branches: 75, functions: 100, lines: 90 },
});
