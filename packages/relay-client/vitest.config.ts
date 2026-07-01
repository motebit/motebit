import { defineMotebitTest } from "../../vitest.shared.js";

// Typed relay transport — every seam (fetch, clock) is injected, so the
// full request/auth/retry/error matrix is exercisable without I/O.
export default defineMotebitTest({
  thresholds: { statements: 90, branches: 90, functions: 90, lines: 90 },
});
