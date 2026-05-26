import { defineMotebitTest } from "../../vitest.shared.js";

// Locked at measured baseline (presence-sweep — browser-safe content-manifest
// verifier; not on the money/identity path, so no tier floor, only the
// never-regress floor). Raise opportunistically; never lower.
export default defineMotebitTest({
  thresholds: { statements: 92, branches: 82, functions: 90, lines: 92 },
});
