import { defineMotebitTest } from "../../vitest.shared.js";

// Pure state machine — no I/O, no defensive branches. Lock at 100% across
// all dimensions; any regression blocks. The one injectable seam is the
// clock, and every transition path has a test.
export default defineMotebitTest({
  thresholds: { statements: 100, branches: 100, functions: 100, lines: 100 },
});
