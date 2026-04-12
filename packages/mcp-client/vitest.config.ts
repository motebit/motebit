import { defineMotebitTest } from "../../vitest.shared.js";

export default defineMotebitTest({
  thresholds: { statements: 89, branches: 90, functions: 94, lines: 89 },
});
