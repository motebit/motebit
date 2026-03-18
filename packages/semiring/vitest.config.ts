import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      include: ["src/**/*.ts"],
      exclude: ["src/__tests__/**"],
      thresholds: { statements: 88, branches: 83, functions: 86, lines: 88 },
    },
  },
});
