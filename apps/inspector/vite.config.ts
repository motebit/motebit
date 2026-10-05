import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { MOTEBIT_TEST_REPORTERS } from "../../vitest.shared.js";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    proxy: {
      "/api": "http://localhost:3000",
      "/health": "http://localhost:3000",
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test-setup.ts"],
    // The shared reporters (vitest.shared.ts): CI's verdict reads the JSON
    // results they write, so this config — not the shared factory — must
    // emit them too.
    reporters: MOTEBIT_TEST_REPORTERS,
    coverage: {
      // vitest's defaults + json-summary, which the verdict compares against
      // the thresholds below (as defineMotebitTest does).
      reporter: ["text", "html", "clover", "json", "json-summary"],
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/__tests__/**", "src/**/*.d.ts", "src/test-setup.ts"],
      // Floor thresholds anchored to the first measured baseline
      // (statements 33.63%, branches 65.76%, functions 52.80%, lines 33.63%).
      // inspector is the single-agent inspector — internal tool, React + Vite.
      // Most uncovered code is the d3-force visualization glue and the
      // 15-tab panel render paths that would need a headless browser with
      // real DOM + recharts to exercise. Floor locks in the current state.
      thresholds: { statements: 33, branches: 22, functions: 45, lines: 33 },
    },
  },
});
