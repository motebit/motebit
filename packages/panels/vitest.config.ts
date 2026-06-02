import { defineMotebitTest } from "../../vitest.shared.js";

// Locked at measured baseline (presence-sweep — surface-agnostic panel
// controllers; not on the money/identity path, so no tier floor applies, only
// the never-regress floor). Raise opportunistically; never lower.
export default defineMotebitTest({
  thresholds: { statements: 85, branches: 70, functions: 88, lines: 89 },
});
