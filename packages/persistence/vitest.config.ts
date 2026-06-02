import { defineMotebitTest } from "../../vitest.shared.js";

export default defineMotebitTest({
  thresholds: { statements: 78, branches: 69, functions: 70, lines: 80 },
});
