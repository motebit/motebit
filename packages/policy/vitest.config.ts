import { defineMotebitTest } from "../../vitest.shared.js";

export default defineMotebitTest({
  thresholds: { statements: 94, branches: 91, functions: 88, lines: 95 },
});
