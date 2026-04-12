import { defineMotebitTest } from "../../vitest.shared.js";

export default defineMotebitTest({
  thresholds: { statements: 97, branches: 95, functions: 100, lines: 97 },
});
