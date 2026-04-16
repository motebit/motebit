import { defineMotebitTest } from "../../vitest.shared.js";

// Pure fetch-based JSON-RPC client. Every failure mode (network / non-2xx /
// JSON-RPC error / malformed envelope) has a test. Branches sit at 95.65%
// — the two uncovered arms are environment guards (`typeof AbortController
// !== "undefined"`) that aren't cleanly testable without stubbing globalThis.
// Locked at measured floor; raise if the guards are re-expressed.
export default defineMotebitTest({
  thresholds: { statements: 100, branches: 95, functions: 100, lines: 100 },
});
