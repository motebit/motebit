import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "**/dist/**", "**/coverage/**"],
    coverage: {
      include: ["src/**/*.ts"],
      exclude: ["src/__tests__/**", "src/index.ts"],
      thresholds: { statements: 85, branches: 15, functions: 95, lines: 85 },
    },
  },
});
