import { defineMotebitTest } from "../../vitest.shared.js";

export default defineMotebitTest({
  coverageExclude: ["src/index.ts"],
  thresholds: { statements: 85, branches: 15, functions: 95, lines: 85 },
});
