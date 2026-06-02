import { defineMotebitTest } from "../../vitest.shared.js";

// Locked at measured baseline (presence-sweep — browser-safe content-manifest
// verifier; not on the money/identity path, so no tier floor, only the
// never-regress floor). Raise opportunistically; never lower.
export default defineMotebitTest({
  thresholds: { statements: 88, branches: 75, functions: 83, lines: 92 },
});
