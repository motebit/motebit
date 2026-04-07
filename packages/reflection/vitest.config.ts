import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "**/dist/**", "**/coverage/**"],
    coverage: {
      include: ["src/**/*.ts"],
      exclude: ["src/__tests__/**", "src/**/*.d.ts"],
      // Floor thresholds anchored to the first measured baseline
      // (statements 29.53%, branches 100%, functions 25%, lines 29.53%).
      // reflection is the "what should I change?" layer that calls out to
      // an LLM — most uncovered code is the prompt-construction path and
      // the response parser, both of which need mock-LLM tests to exercise.
      // Follow-up: write reflection integration tests with a stub provider
      // to raise statements/functions/lines above 60%.
      thresholds: { statements: 29, branches: 100, functions: 25, lines: 29 },
    },
  },
});
