import { defineMotebitTest } from "../../vitest.shared.js";

export default defineMotebitTest({
  thresholds: { statements: 82, branches: 85, functions: 89, lines: 82 },
});
