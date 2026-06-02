import { defineMotebitTest } from "../../vitest.shared.js";

export default defineMotebitTest({
  coverageExclude: ["src/schema.ts"],
  thresholds: { statements: 96, branches: 87, functions: 100, lines: 96 },
});
