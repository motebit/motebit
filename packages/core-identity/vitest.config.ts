import { defineMotebitTest } from "../../vitest.shared.js";

export default defineMotebitTest({
  // Graduated to the identity floor 2026-08-13, ahead of the 08-15 raise-by
  // date (coverage-graduation.json). Measured coverage is 95.4 / 88.4 / 89.4 /
  // 97.1, so the floor was raised to the committed 85 without writing new
  // tests — the named error paths in the rationale were already covered by
  // work that landed since the snapshot.
  //
  // `branches` stays at 86, ABOVE its target of 80: the graduation target is a
  // floor to reach, never a level to fall back to, and lowering a live
  // threshold to match a target would violate the never-lower-thresholds
  // policy in vitest.shared.ts.
  thresholds: { statements: 85, branches: 86, functions: 85, lines: 85 },
});
