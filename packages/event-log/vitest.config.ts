import { defineMotebitTest } from "../../vitest.shared.js";

export default defineMotebitTest({
  thresholds: { statements: 100, branches: 100, functions: 100, lines: 100 },
});
