import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      include: ["src/**/*.ts"],
      exclude: ["src/__tests__/**"],
      thresholds: { statements: 95, branches: 95, functions: 95, lines: 95 },
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
