import { defineMotebitTest } from "../../vitest.shared.js";

export default defineMotebitTest({
  thresholds: { statements: 98, branches: 92, functions: 100, lines: 100 },
});
