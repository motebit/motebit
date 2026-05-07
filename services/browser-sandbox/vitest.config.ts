import { defineMotebitTest } from "../../vitest.shared.js";

// src/index.ts is the boot entrypoint — wires Playwright + Hono + listen(),
// exits the process on signal. Verified live by deployment + the
// dispatcher-parity drift gate. Every unit-testable module
// (action-executor, routes, chromium-pool, auth, env) is covered here.
export default defineMotebitTest({
  coverageExclude: ["src/index.ts"],
  thresholds: { statements: 90, branches: 85, functions: 90, lines: 90 },
});
