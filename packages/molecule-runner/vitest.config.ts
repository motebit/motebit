import { defineMotebitTest } from "../../vitest.shared.js";

export default defineMotebitTest({
  // Money/identity-path member (constructs sovereign wallets + sweeps worker
  // funds) → must meet the money tier floor 90/85/90/90 (check-coverage-config-present).
  thresholds: { statements: 90, branches: 85, functions: 90, lines: 90 },
});
