import { defineMotebitTest } from "../../vitest.shared.js";

// src/index.ts is the service entrypoint — wires main(), spins up the MCP
// server, exits the process. Verified by deployment + the live research MCP
// service. Every unit-testable module (research.ts, helpers.ts) is at 100%.
export default defineMotebitTest({
  coverageExclude: ["src/index.ts"],
  thresholds: { statements: 100, branches: 100, functions: 100, lines: 100 },
});
