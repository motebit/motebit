import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "**/dist/**", "**/coverage/**"],
    coverage: {
      include: ["src/**/*.ts"],
      exclude: ["src/__tests__/**", "src/main.ts"],
    },
  },
});
