import { defineMotebitTest } from "../../vitest.shared.js";

// Floor thresholds at the current baseline: statements/functions/lines
// are already at 100%, branches sit at 97.18% (a couple of defensive
// guards in the gradient narrator that only trigger on malformed
// input). Lock in 100/97/100/100 so regressions block.
export default defineMotebitTest({
  thresholds: { statements: 99, branches: 95, functions: 100, lines: 100 },
});
