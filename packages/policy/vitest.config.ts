import { defineMotebitTest } from "../../vitest.shared.js";

export default defineMotebitTest({
  thresholds: { statements: 96, branches: 93, functions: 89, lines: 96 },
});
