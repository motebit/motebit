import { defineMotebitTest } from "../../vitest.shared.js";

// Converted from a raw defineConfig that declared NO coverage thresholds — a
// pre-existing fail-open the coverage-config-present gate caught on its first
// run. Locked at measured baseline (presence-sweep — committed BM25 corpus over
// self-description docs; not on the money/identity path, so only the
// never-regress floor applies).
export default defineMotebitTest({
  thresholds: { statements: 97, branches: 88, functions: 100, lines: 100 },
});
