import { defineMotebitTest } from "../../vitest.shared.js";

export default defineMotebitTest({
  thresholds: { statements: 89, branches: 85, functions: 91, lines: 89 },
});
