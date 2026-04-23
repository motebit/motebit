import { defineMotebitTest } from "../../vitest.shared.js";

export default defineMotebitTest({
  // cli.ts is the 15-line `#!/usr/bin/env node` bin shim; every branch is
  // exercised via the factored-out `runCli(parseArgs(argv))` in cli-core.
  // index.ts is a pure re-export barrel — zero logic.
  coverageExclude: ["src/cli.ts", "src/index.ts"],
  thresholds: { statements: 95, branches: 85, functions: 100, lines: 95 },
});
