import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "**/dist/**", "**/coverage/**"],
    coverage: {
      include: ["src/validation.ts"],
      thresholds: { statements: 70, branches: 60, functions: 65, lines: 70 },
    },
  },
});
