import { defineMotebitTest } from "../../vitest.shared.js";

// Typed relay transport — every seam (fetch, clock) is injected, so the
// full request/auth/retry/error matrix is exercisable without I/O.
export default defineMotebitTest({
  // Ratcheted to measured (98.91/96.42/100/98.83) by scripts/measure-coverage-slack.ts.
  // A floor N points below reality only catches a regression bigger than N.
  thresholds: { statements: 98, branches: 95, functions: 100, lines: 98 },
});
