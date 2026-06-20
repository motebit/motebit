// Fixture — correct shape, web-style. Never executed; the gate regex-scans it.
import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  define: { global: "globalThis" },
  resolve: { alias: { buffer: resolve("node_modules/buffer/") } },
});
