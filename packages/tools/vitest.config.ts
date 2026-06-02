import { defineMotebitTest } from "../../vitest.shared.js";

export default defineMotebitTest({
  thresholds: { statements: 85, branches: 74, functions: 79, lines: 85 },
});
