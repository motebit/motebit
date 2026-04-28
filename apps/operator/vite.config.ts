import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5175,
    proxy: {
      "/api": "http://localhost:3000",
      "/federation": "http://localhost:3000",
      "/.well-known": "http://localhost:3000",
      "/health": "http://localhost:3000",
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test-setup.ts"],
    coverage: {
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/__tests__/**", "src/**/*.d.ts", "src/test-setup.ts"],
      // Floor anchored to operator's first measured baseline (2026-04-28):
      // statements 44.87%, branches 58.53%, functions 67.64%, lines 44.87%.
      // The inspector's pre-borrowed defaults (33/65/52/33) didn't fit
      // operator's panel structure — branch coverage is below inspector's
      // because operator panels each carry loading/error/data states that
      // the current shallow render-only tests don't exercise. Floor locks
      // the current state; lift via coverage-graduation when panel tests
      // exercise the per-state branches.
      thresholds: { statements: 44, branches: 58, functions: 67, lines: 44 },
    },
  },
});
