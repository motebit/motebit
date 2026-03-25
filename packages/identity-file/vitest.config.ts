import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "**/dist/**", "**/coverage/**"],
    coverage: {
      include: ["src/**/*.ts"],
      exclude: ["src/schema.ts", "src/__tests__/**"],
      thresholds: { statements: 96, branches: 90, functions: 100, lines: 96 },
    },
  },
});
