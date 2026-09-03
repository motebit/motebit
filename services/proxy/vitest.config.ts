import { defineMotebitTest } from "../../vitest.shared.js";

// proxy unit-tests the pure modules; the Next.js edge handler (route.ts) is
// glue exercised via E2E deploy smoke tests, but its failure-classification
// and one-event-per-failure surface are pure and tested here.
export default defineMotebitTest({
  coverageInclude: [
    "src/validation.ts",
    "src/app/v1/messages/provider-request.ts",
    "src/app/v1/messages/usage.ts",
    "src/inference/classify.ts",
    "src/inference/failure-response.ts",
  ],
  // Ratcheted to measured (88.48/83.98/89.13/89.77) by scripts/measure-coverage-slack.ts.
  // A floor N points below reality only catches a regression bigger than N.
  thresholds: { statements: 87, branches: 82, functions: 88, lines: 88 },
});
