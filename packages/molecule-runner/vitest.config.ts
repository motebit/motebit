import { defineMotebitTest } from "../../vitest.shared.js";

export default defineMotebitTest({
  thresholds: { statements: 90, branches: 80, functions: 90, lines: 90 },
});
