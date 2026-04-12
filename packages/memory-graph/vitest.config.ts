import { defineMotebitTest } from "../../vitest.shared.js";

export default defineMotebitTest({
  thresholds: { statements: 96, branches: 89, functions: 100, lines: 96 },
});
