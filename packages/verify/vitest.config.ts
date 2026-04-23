import { defineMotebitTest } from "../../vitest.shared.js";

export default defineMotebitTest({
  coverageInclude: ["src/**/*.ts"],
  // cli.ts is the #!/usr/bin/env node bin shim (exercised via integration
  // tests / manual invocation); index.ts is a pure re-export barrel.
  coverageExclude: ["src/cli.ts", "src/index.ts"],
  thresholds: { statements: 90, branches: 75, functions: 100, lines: 90 },
});
