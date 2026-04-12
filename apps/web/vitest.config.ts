import { defineMotebitTest } from "../../vitest.shared.js";

// web-app.ts (1229 lines) and providers.ts (272 lines) are application
// orchestrators with DOM/WebSocket/Three.js dependencies — integration-level,
// not unit-testable. Testable logic (bootstrap, storage, rendering) is at 89%+.
export default defineMotebitTest({
  testExclude: ["**/e2e/**"],
  coverageExclude: [
    "src/main.ts",
    // src/ui/ is DOM rendering (innerHTML templates, event wiring).
    // Covered by Playwright E2E, not unit tests.
    "src/ui/**",
  ],
  extra: { setupFiles: ["./src/__tests__/setup.ts"] },
  thresholds: { statements: 50, branches: 60, functions: 50, lines: 50 },
});
