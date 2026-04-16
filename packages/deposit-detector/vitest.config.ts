import { defineMotebitTest } from "../../vitest.shared.js";

// Pure state machine with injected store + rpc + onDeposit callback.
// Locked at measured baseline — statements/branches/lines at 99/95/99,
// functions at 90 (v8 counts a callback inside the optional-chain logger
// call that is only reachable on the individual-credit-failure branch
// and in our fake-store scenario never throws from both call sites).
export default defineMotebitTest({
  thresholds: { statements: 99, branches: 95, functions: 90, lines: 99 },
});
