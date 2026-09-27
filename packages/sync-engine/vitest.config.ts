import { defineMotebitTest } from "../../vitest.shared.js";

export default defineMotebitTest({
  thresholds: { statements: 80, branches: 71, functions: 82, lines: 82 },
  // Test support for the apps' #816 interleaving matrices (`./testing`), not
  // runtime code: exercised by those matrices, not by this package's tests.
  coverageExclude: ["src/testing/**"],
});
