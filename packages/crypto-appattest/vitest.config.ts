import { defineMotebitTest } from "../../vitest.shared.js";

export default defineMotebitTest({
  thresholds: { statements: 86, branches: 75, functions: 100, lines: 90 },
});
