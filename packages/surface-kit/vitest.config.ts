import { defineMotebitTest } from "../../vitest.shared.js";

// Surface-agnostic MCP manager controller. The two uncovered lines are the
// reconnect per-server warn and the dispose best-effort catch — defensive
// branches around external adapter failures.
export default defineMotebitTest({
  thresholds: { statements: 97, branches: 87, functions: 88, lines: 97 },
});
