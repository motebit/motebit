import { defineMotebitTest } from "../../vitest.shared.js";

// Guest-rail reference implementations — locked at the current baseline
// (stripe + x402 + bridge + registry, all tested with injected SDK mocks).
// Never lower; raise as real integration tests land.
export default defineMotebitTest({
  thresholds: { statements: 90, branches: 85, functions: 90, lines: 90 },
});
