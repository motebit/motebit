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
  thresholds: { statements: 70, branches: 60, functions: 65, lines: 70 },
});
