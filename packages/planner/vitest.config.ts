import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      include: ["src/**/*.ts"],
      exclude: ["src/__tests__/**"],
      thresholds: { statements: 85, branches: 80, functions: 83, lines: 85 },
    },
  },
});
