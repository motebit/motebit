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
      // Floor anchored to first measured baseline; a fresh surface mirrors
      // the inspector's coverage profile (panel render paths require a
      // headless browser to fully exercise). Lift after first real probe.
      thresholds: { statements: 33, branches: 65, functions: 52, lines: 33 },
    },
  },
});
