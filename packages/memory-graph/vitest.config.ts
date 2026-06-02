import { defineMotebitTest } from "../../vitest.shared.js";

export default defineMotebitTest({
  thresholds: { statements: 94, branches: 86, functions: 96, lines: 96 },
});
