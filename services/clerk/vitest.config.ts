import { defineMotebitTest } from "../../vitest.shared.js";

// The Clerk is the money-EXECUTION pole of the archetype slate — it spends under
// a self-issued grant. Until #546 it carried no config at all, so it had no
// coverage floor of ANY kind, and without a config vitest measured only the
// files the tests happened to import: `helpers.ts` was outside the denominator,
// which reported 100% branches for a service whose real figure was 34%.
//
// These floors are MEASURED, not aspirational, and they clear the money-tier
// floor (90/85/90/90) that `scripts/money-identity-path.ts` applies to
// money-path members under `packages/`. `src/index.ts` is boot wiring, excluded
// by the same convention every other service here uses.
export default defineMotebitTest({
  coverageExclude: ["src/index.ts"],
  thresholds: { statements: 100, branches: 93, functions: 100, lines: 100 },
});
