import { defineMotebitTest } from "../../vitest.shared.js";

export default defineMotebitTest({
  // index.ts is a pure re-export barrel — zero logic. CLI moved to
  // `@motebit/verify` in v1.0; this package is library-only.
  coverageExclude: ["src/index.ts"],
  thresholds: { statements: 95, branches: 85, functions: 100, lines: 95 },
});
