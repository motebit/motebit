import { defineMotebitTest } from "../../vitest.shared.js";

// src/index.ts is the service entrypoint — it wires main(), spins up
// the MCP server, and exits the process. Its correctness is verified
// by deployment + the live code-review MCP service, not unit tests.
// Every unit-testable module (github.ts, review.ts, helpers.ts) is
// held to 100% across the board.
export default defineMotebitTest({
  coverageExclude: ["src/index.ts"],
  thresholds: { statements: 100, branches: 100, functions: 100, lines: 100 },
});
