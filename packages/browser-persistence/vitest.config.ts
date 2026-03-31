import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "**/dist/**", "**/coverage/**"],
    setupFiles: ["./src/__tests__/setup.ts"],
    coverage: {
      include: ["src/**/*.ts"],
      exclude: ["src/__tests__/**"],
      thresholds: { statements: 70, branches: 60, functions: 65, lines: 70 },
    },
  },
});
