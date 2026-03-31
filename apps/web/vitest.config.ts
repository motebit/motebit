import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "**/dist/**", "**/coverage/**", "**/e2e/**"],
    setupFiles: ["./src/__tests__/setup.ts"],
    coverage: {
      include: ["src/**/*.ts"],
      exclude: [
        "src/__tests__/**",
        "src/main.ts",
        // src/ui/ is DOM rendering (innerHTML templates, event wiring).
        // Covered by Playwright E2E, not unit tests.
        "src/ui/**",
      ],
      // web-app.ts (1229 lines) and providers.ts (272 lines) are application
      // orchestrators with DOM/WebSocket/Three.js dependencies — integration-level,
      // not unit-testable. Testable logic (bootstrap, storage, rendering) is at 89%+.
      thresholds: { statements: 50, branches: 60, functions: 50, lines: 50 },
    },
  },
});
