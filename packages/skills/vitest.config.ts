import { defineMotebitTest } from "../../vitest.shared.js";

// Locked at measured baseline (presence-sweep — agentskills.io-compatible
// runtime; not on the money/identity path). Statements/lines at 64 — a share of
// the skill execution surface is integration-tested elsewhere or not yet
// unit-covered. The floor's job here is only to make the number EXPLICIT and
// non-regressing; raising it is opportunistic, not blocked by this gate.
export default defineMotebitTest({
  thresholds: { statements: 56, branches: 53, functions: 57, lines: 58 },
});
