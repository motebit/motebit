import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "**/dist/**", "**/coverage/**"],
    coverage: {
      include: ["src/**/*.ts"],
      // index.ts, prompts.ts, rotate.ts are CLI entry points tested via subprocess
      // spawning (execa) — v8 coverage can't instrument child processes.
      // These files have full integration test coverage but are excluded from
      // v8 thresholds. generate.ts is unit-tested via direct import.
      exclude: ["src/__tests__/**", "src/index.ts", "src/prompts.ts", "src/rotate.ts"],
      thresholds: { statements: 95, branches: 80, functions: 90, lines: 95 },
    },
    // Tests spawn child processes that run PBKDF2. With production iterations
    // (600k), these are slow under turbo parallelism. MOTEBIT_PBKDF2_ITERATIONS
    // reduces to 1000 for tests — same code path, 600x faster.
    testTimeout: 15_000,
    env: {
      MOTEBIT_PBKDF2_ITERATIONS: "1000",
    },
  },
});
