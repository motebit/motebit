import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "**/dist/**", "**/coverage/**"],
    coverage: {
      include: ["src/**/*.ts"],
      exclude: ["src/__tests__/**", "src/**/*.d.ts"],
      // Floor thresholds anchored to the first measured baseline. protocol
      // is Layer 0 (MIT, zero deps) so coverage should stay high — the one
      // gap is a handful of unexercised discriminant branches in the
      // credential/settlement type guards. Raise as those get tested.
      thresholds: { statements: 98, branches: 100, functions: 91, lines: 98 },
    },
  },
});
