import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "**/dist/**", "**/coverage/**"],
    coverage: {
      include: ["src/**/*.ts"],
      exclude: ["src/__tests__/**"],
      // 95% not 100%: settlement.ts has 3 unreachable defensive guards
      // (completed > total from Array.filter, overflow on validated-safe integers,
      // negative net from gross * feeRate where feeRate ∈ [0,1]).
      // Contorting tests to hit unreachable code is worse than a realistic threshold.
      thresholds: { statements: 95, branches: 85, functions: 100, lines: 95 },
    },
  },
});
