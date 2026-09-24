import { defineMotebitTest } from "../../vitest.shared.js";

// Measured floors. Before #546 this service had no config, so no floor of any
// kind and `helpers.ts` was never in the denominator.
//
// Branches sit at 74 — below the 80 an identity-tier registry member would owe.
// The gap is real and named rather than papered over: `checks.ts` (58) and
// `evidence.ts` (70) carry it. Ratchet upward as those are covered; never lower.
export default defineMotebitTest({
  coverageExclude: ["src/index.ts"],
  thresholds: { statements: 87, branches: 74, functions: 90, lines: 87 },
});
