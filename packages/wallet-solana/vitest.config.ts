import { defineMotebitTest } from "../../vitest.shared.js";

// Sovereign rail coverage floor. Policy: never lower thresholds; write
// tests to meet them. Raised 2026-04-20 from the original
// 2026-04-16 baseline (42/86/58/42 → 61/86/71/61) as part of the
// coverage-graduation commitment — the moat path through
// `memo-submitter.ts` is now 100% covered (consolidation receipts
// anchor through it; it had to be robust). Remaining gap is
// concentrated in `web3js-adapter.ts` (USDC transfer path) and
// `rail.ts` — both pending Connection-mock tests in a follow-up pass.
//
// adapter.ts is excluded (types-only; no runtime emit), matching the
// identity-file/schema.ts and protocol/*.ts exclusion precedent.
//
// Graduation target: 80/80/80/80 by 2026-06-01 (see
// `coverage-graduation.json`). Each raise MUST update both this file
// and the manifest in the same PR per the graduation doctrine's
// drift rule.
export default defineMotebitTest({
  coverageExclude: ["src/adapter.ts"],
  thresholds: { statements: 61, branches: 86, functions: 71, lines: 61 },
});
