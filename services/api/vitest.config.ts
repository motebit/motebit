import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      include: ["src/**/*.ts"],
      exclude: ["src/__tests__/**"],
      thresholds: { statements: 67, branches: 62, functions: 65, lines: 67 },
    },
  },
});
