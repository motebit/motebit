import { defineMotebitTest } from "../../vitest.shared.js";

export default defineMotebitTest({
  thresholds: { statements: 80, branches: 85, functions: 73, lines: 80 },
});
