import { defineConfig } from "vite";

export default defineConfig({
  server: {
    port: 5175,
    // WebXR requires HTTPS (except localhost)
    https: false,
  },
  build: {
    target: "esnext",
    rollupOptions: {
      // Only externalize Node-specific MCP SDK transports (stdio uses
      // node:stream/child_process). The HTTP transport and Client class
      // are browser-safe. Mirrors apps/web and apps/desktop — the
      // established pattern for browser-target Vite apps in this monorepo
      // that consume @motebit/mcp-client.
      external: ["@modelcontextprotocol/sdk/client/stdio.js", "cross-spawn", /^node:/],
    },
  },
  optimizeDeps: {
    // ONNX Runtime WASM used by @ricky0123/vad-web — let Vite pre-bundle it
    exclude: ["onnxruntime-web"],
  },
  test: {
    environment: "node",
  },
});
