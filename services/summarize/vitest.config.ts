import { defineMotebitTest } from "../../vitest.shared.js";

export default defineMotebitTest({
  coverageExclude: ["src/index.ts"],
  // Ratcheted to measured (#546): `branches: 15` was a no-op — the real figure
  // is 50, so the floor guarded nothing. Free ratchet, no new tests, exactly the
  // "measure before planning the work" habit the graduation post-mortem asks for.
  thresholds: { statements: 88, branches: 50, functions: 100, lines: 92 },
});
