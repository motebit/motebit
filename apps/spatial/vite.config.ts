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
      // Externalize Node-only MCP SDK paths and their transitive Node deps.
      // The MCP SDK ships transports for both client and server roles, and
      // several of them statically pull `node:stream`, `node:http`, or the
      // Hono Node adapter. The HTTP client, the Client class itself, and
      // mcp-server's type-only / dynamic-import surface are browser-safe;
      // these externals just stop rollup from tracing the dynamic import
      // strings that gate the Node-only code paths at runtime.
      // Mirrors apps/web and apps/desktop — the established pattern for
      // browser-target Vite apps in this monorepo.
      external: [
        // mcp-client's stdio transport (Node-only, gated dynamically)
        "@modelcontextprotocol/sdk/client/stdio.js",
        // mcp-server's stdio + HTTP transports (Node-only, gated dynamically)
        "@modelcontextprotocol/sdk/server/stdio.js",
        "@modelcontextprotocol/sdk/server/streamableHttp.js",
        // Hono Node adapter — statically pulled by the SDK's HTTP server
        // transport; never reachable when the dynamic import is gated out.
        "@hono/node-server",
        // cross-spawn — pulled transitively by the stdio paths above
        "cross-spawn",
        // Anything from the `node:` namespace
        /^node:/,
      ],
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
