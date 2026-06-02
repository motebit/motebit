import { defineMotebitTest } from "../../vitest.shared.js";

export default defineMotebitTest({
  thresholds: { statements: 80, branches: 71, functions: 72, lines: 80 },
});
