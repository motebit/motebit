import { defineMotebitTest } from "../../vitest.shared.js";

export default defineMotebitTest({
  coverageExclude: ["src/index.ts"],
  thresholds: { statements: 95, branches: 94, functions: 95, lines: 95 },
});
