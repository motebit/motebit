import { defineMotebitTest } from "../../vitest.shared.js";

export default defineMotebitTest({
  coverageExclude: ["src/main.ts", "src/render.ts"],
  thresholds: { statements: 70, branches: 60, functions: 65, lines: 70 },
});
