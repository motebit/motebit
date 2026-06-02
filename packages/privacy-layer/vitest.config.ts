import { defineMotebitTest } from "../../vitest.shared.js";

export default defineMotebitTest({
  thresholds: { statements: 85, branches: 86, functions: 88, lines: 85 },
});
