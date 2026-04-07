import { defineConfig } from "vite";
import { viteStaticCopy } from "vite-plugin-static-copy";

export default defineConfig({
  plugins: [
    viteStaticCopy({
      targets: [
        // Silero VAD model + worklet
        { src: "node_modules/@ricky0123/vad-web/dist/silero_vad_v5.onnx", dest: "." },
        { src: "node_modules/@ricky0123/vad-web/dist/silero_vad_legacy.onnx", dest: "." },
        { src: "node_modules/@ricky0123/vad-web/dist/vad.worklet.bundle.min.js", dest: "." },
        // ONNX Runtime WASM
        { src: "node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm", dest: "." },
        { src: "node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs", dest: "." },
      ],
    }),
  ],
  build: {
    target: "esnext",
    outDir: "dist",
    rollupOptions: {
      // Externalize Node-only MCP SDK paths and their transitive Node deps.
      // The MCP SDK ships transports for both client and server roles, and
      // several of them statically pull `node:stream`, `node:http`, or the
      // Hono Node adapter. The HTTP client, the Client class itself, and
      // mcp-server's type-only / dynamic-import surface are browser-safe
      // (webview-compatible); these externals stop rollup from tracing the
      // dynamic-import strings that gate the Node-only code paths at
      // runtime. Mirrors apps/spatial and apps/web.
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
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api/anthropic": {
        target: "https://api.anthropic.com",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/anthropic/, ""),
      },
      "/api/ollama": {
        target: "http://localhost:11434",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/ollama/, ""),
      },
    },
  },
});
