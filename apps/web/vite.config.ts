import { defineConfig } from "vite";

export default defineConfig({
  build: {
    target: "esnext",
    outDir: "dist",
    rollupOptions: {
      // Only externalize Node-specific MCP SDK transports (stdio uses node:stream/child_process).
      // The HTTP transport and Client class are browser-safe.
      external: ["@modelcontextprotocol/sdk/client/stdio.js", "cross-spawn", /^node:/],
    },
  },
  worker: {
    format: "es",
  },
  server: {
    port: 3000,
  },
});
