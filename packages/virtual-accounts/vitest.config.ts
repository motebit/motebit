import { defineMotebitTest } from "../../vitest.shared.js";

// Core ledger + withdrawal lifecycle + signing. The InMemoryAccountStore
// covers every store method; package functions are covered through it.
// Lock high — regressions here move money.
export default defineMotebitTest({
  thresholds: { statements: 93, branches: 90, functions: 91, lines: 95 },
});
