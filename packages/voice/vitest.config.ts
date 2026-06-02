import { defineMotebitTest } from "../../vitest.shared.js";

export default defineMotebitTest({
  thresholds: { statements: 85, branches: 79, functions: 86, lines: 87 },
});
