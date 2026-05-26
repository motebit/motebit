import { defineMotebitTest } from "../../vitest.shared.js";

// Locked at measured baseline (presence-sweep — surface-agnostic panel
// controllers; not on the money/identity path, so no tier floor applies, only
// the never-regress floor). Raise opportunistically; never lower.
export default defineMotebitTest({
  thresholds: { statements: 96, branches: 89, functions: 88, lines: 96 },
});
