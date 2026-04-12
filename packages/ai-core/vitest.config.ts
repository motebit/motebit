import { defineMotebitTest } from "../../vitest.shared.js";

export default defineMotebitTest({
  thresholds: { statements: 76, branches: 76, functions: 72, lines: 76 },
});
