import { defineConfig } from "vite";

export default defineConfig({
  build: {
    target: "esnext",
    outDir: "dist",
    rollupOptions: {
      // Externalize Node-only MCP SDK paths and their transitive Node deps.
      // The MCP SDK ships transports for both client and server roles, and
      // several of them statically pull `node:stream`, `node:http`, or the
      // Hono Node adapter. The HTTP client, the Client class itself, and
      // mcp-server's type-only / dynamic-import surface are browser-safe;
      // these externals stop rollup from tracing the dynamic-import strings
      // that gate the Node-only code paths at runtime. Mirrors apps/spatial
      // and apps/desktop.
      external: [
        "@modelcontextprotocol/sdk/client/stdio.js",
        "@modelcontextprotocol/sdk/server/stdio.js",
        "@modelcontextprotocol/sdk/server/streamableHttp.js",
        "@hono/node-server",
        "cross-spawn",
        /^node:/,
      ],
    },
  },
  worker: {
    format: "es",
  },
  server: {
    port: 3000,
  },
});
