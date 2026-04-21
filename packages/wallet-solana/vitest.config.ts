import { defineMotebitTest } from "../../vitest.shared.js";

// Sovereign rail coverage floor. Policy: never lower thresholds; write
// tests to meet them. Raised 2026-04-20 in two passes:
//   1. 42/86/58/42 → 61/86/71/61 (memo-submitter.ts to 100% — the
//      consolidation-anchor moat path).
//   2. 61/86/71/61 → 95/95/100/95 (rail.ts to 100% + web3js-adapter.ts
//      to ~96% via Connection-mock + spl-token-mock pattern, mirroring
//      the memo-submitter approach for sendUsdc / sendUsdcBatch /
//      ensureGas / Jupiter auto-swap branches).
//   3. 95/95/100/95 → 97/96/100/97 (jupiter.ts to 100% via a fake
//      VersionedTransaction so the post-swap confirm + return path
//      runs without a real serialized swap tx).
//
// 80/80/80/80 graduation target met ahead of the 2026-06-01 deadline;
// `wallet-solana` is removed from `coverage-graduation.json` per the
// doctrine ("When all targets are met, remove the entry").
//
// adapter.ts is excluded (types-only; no runtime emit), matching the
// identity-file/schema.ts and protocol/*.ts exclusion precedent.
//
// Each raise MUST update both this file and any matching manifest
// entry in the same PR per the graduation doctrine's drift rule.
export default defineMotebitTest({
  coverageExclude: ["src/adapter.ts"],
  thresholds: { statements: 97, branches: 96, functions: 100, lines: 97 },
});
