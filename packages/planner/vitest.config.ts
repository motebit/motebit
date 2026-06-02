import { defineMotebitTest } from "../../vitest.shared.js";

export default defineMotebitTest({
  thresholds: { statements: 85, branches: 75, functions: 83, lines: 87 },
});
