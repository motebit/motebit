import { defineMotebitTest } from "../../vitest.shared.js";

// Sovereign rail coverage floor — locked at measured baseline (2026-04-16).
// Policy: never lower thresholds; write tests to meet them. This package had
// no vitest.config.ts before today, so this is the first locked floor.
//
// adapter.ts is excluded (types-only; no runtime emit), matching the
// identity-file/schema.ts and protocol/*.ts exclusion precedent.
//
// Follow-up (tracked outside this file): the runtime coverage gap is
// concentrated in the @solana/web3.js boundary — sendUsdc, sendUsdcBatch,
// getTransaction inside Web3JsRpcAdapter, and the memo-submitter's
// batch/revocation paths. Close by adding integration tests against the
// SolanaRpcAdapter interface with a fake RPC, then raise these thresholds.
export default defineMotebitTest({
  coverageExclude: ["src/adapter.ts"],
  thresholds: { statements: 42, branches: 86, functions: 58, lines: 42 },
});
