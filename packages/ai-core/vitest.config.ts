import { defineMotebitTest } from "../../vitest.shared.js";

export default defineMotebitTest({
  thresholds: { statements: 98, branches: 90, functions: 97, lines: 99 },
});
