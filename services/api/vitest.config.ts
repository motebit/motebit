import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      include: ["src/**/*.ts"],
      exclude: ["src/__tests__/**"],
      thresholds: { statements: 74, branches: 70, functions: 86, lines: 74 },
    },
  },
});
