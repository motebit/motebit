import { defineMotebitTest } from "../../vitest.shared.js";

export default defineMotebitTest({
  thresholds: { statements: 85, branches: 80, functions: 100, lines: 85 },
});
