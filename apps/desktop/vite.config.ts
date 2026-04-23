import { defineConfig } from "vite";
import { resolve } from "node:path";
import { viteStaticCopy } from "vite-plugin-static-copy";

/**
 * Manual chunk strategy — see apps/web/vite.config.ts for the full
 * rationale. Desktop uses a FLATTER split than web/spatial because
 * desktop's `index.ts` reaches more entry points in the dependency
 * graph (Tauri-specific code paths, identity-file integration, the
 * full keyring + sync surface). Splitting motebit/* into runtime /
 * core / network on desktop produces circular chunk errors:
 *   `motebit-runtime → motebit-core → motebit-runtime`
 *   `motebit-runtime → motebit-network → motebit-runtime`
 * The cycles exist because runtime, mcp-client, sdk/protocol, and
 * crypto all reference each other across what would otherwise be
 * three separate chunks. Merging them into a single `motebit-platform`
 * chunk eliminates the cycles. The combined size (~318 kB) is well
 * under the 900 kB threshold and roughly equals the sum of web's
 * three motebit-* chunks, so the cache + parallel-fetch story is
 * comparable on desktop's typical install path.
 *
 * Desktop-specific notes:
 *   - Tauri webview is Chromium, so the same browser-target split applies.
 *   - VAD model + ONNX runtime files are copied as static assets via
 *     viteStaticCopy (see plugins below) — they're not bundled, they're
 *     fetched at runtime from `/`.
 */
function manualChunks(id: string): string | undefined {
  if (id.includes("node_modules")) {
    if (id.includes("/three/") || id.includes("\\three\\")) return "vendor-three";
    if (id.includes("@modelcontextprotocol/sdk")) return "vendor-mcp";
    if (id.includes("@noble/") || id.includes("@scure/")) return "vendor-crypto";
    return undefined;
  }
  // Render-engine stays separate because nothing else imports from it
  // and it's the largest single domain that can be cleanly isolated.
  if (id.includes("/packages/render-engine/")) return "motebit-render";
  // Everything else from packages/ goes into one platform chunk to
  // avoid circular chunks under desktop's wider entry-point graph.
  if (id.includes("/packages/")) return "motebit-platform";
  return undefined;
}

export default defineConfig({
  // @solana/web3.js and @solana/spl-token (pulled in via
  // @motebit/wallet-solana) reference Node's Buffer at module-eval
  // time. Vite externalizes Node built-ins for browser compat, so
  // without this block the spl-token import throws
  // `ReferenceError: Can't find variable: Buffer` at load, kills the
  // module graph, and desktop boots to a blank canvas. Mirrors
  // apps/web/vite.config.ts — sibling-boundary rule: same fix, same
  // shape, both surfaces.
  define: {
    global: "globalThis",
  },
  resolve: {
    alias: {
      // Point the Node "buffer" import at the npm buffer polyfill.
      // Must resolve to the actual file path — a bare "buffer" string
      // makes Rollup treat it as a Node built-in and externalize it.
      buffer: resolve("node_modules/buffer/"),
    },
  },
  optimizeDeps: {
    esbuildOptions: {
      // Make Buffer available globally during dev-time dependency
      // pre-bundling (esbuild pass). Without this, @solana/spl-token
      // crashes with "Buffer is not defined" during Vite's dev
      // pre-bundle step.
      define: {
        global: "globalThis",
      },
    },
  },
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
    // See apps/web/vite.config.ts for the calibration rationale.
    chunkSizeWarningLimit: 900,
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
      output: {
        manualChunks,
      },
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
