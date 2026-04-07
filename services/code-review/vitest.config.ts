import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "**/dist/**", "**/coverage/**"],
    coverage: {
      include: ["src/**/*.ts"],
      exclude: ["src/__tests__/**", "src/**/*.d.ts"],
      // Floor thresholds anchored to the first measured baseline
      // (statements 5.06%, branches 80%, functions 40%, lines 5.06%).
      // code-review is a Claude-powered PR review service marketed as a
      // flagship paid capability ($0.50/review). The current coverage is
      // way below parity with the other MCP reference services
      // (web-search, read-url, embed all at 95-100%). The floor here
      // prevents further regression — the follow-up work is to write
      // end-to-end tests against a mocked Anthropic client and GitHub
      // API to raise this to parity.
      thresholds: { statements: 5, branches: 80, functions: 40, lines: 5 },
    },
  },
});
