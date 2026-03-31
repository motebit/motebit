import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "**/dist/**", "**/coverage/**"],
    coverage: {
      include: ["src/**/*.ts"],
      exclude: ["src/__tests__/**"],
      // functions at 80% not 86%: uncovered functions are standalone boot
      // (index.ts), Map interface iterators (task-queue.ts), and admin-only
      // key-rotation endpoints — integration-level, not unit-testable.
      thresholds: { statements: 72, branches: 70, functions: 80, lines: 72 },
    },
  },
});
