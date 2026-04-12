import { defineMotebitTest } from "../../vitest.shared.js";

export default defineMotebitTest({
  thresholds: { statements: 99, branches: 91, functions: 100, lines: 99 },
});
