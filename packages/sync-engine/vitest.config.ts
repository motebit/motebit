import { defineMotebitTest } from "../../vitest.shared.js";

export default defineMotebitTest({
  thresholds: { statements: 80, branches: 71, functions: 82, lines: 82 },
});
