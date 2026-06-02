import { defineMotebitTest } from "../../vitest.shared.js";

export default defineMotebitTest({
  thresholds: { statements: 96, branches: 88, functions: 95, lines: 99 },
});
