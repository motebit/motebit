import { defineConfig } from "vite";

/**
 * Manual chunk strategy — see apps/web/vite.config.ts for the full
 * rationale. Spatial uses an identical motebit/* split because the
 * surface graph is the same shape (every motebit package is reachable
 * from spatial-app.ts the same way it is from web-app.ts).
 *
 * Spatial-specific notes:
 *   - Three.js is even more critical here than on web (the entire
 *     surface IS a WebXR scene), so vendor-three stays in the initial
 *     path.
 *   - onnxruntime-web is dynamic-imported by @ricky0123/vad-web for
 *     neural VAD; falls through to vite's auto-chunking and lands in
 *     its own file.
 *   - The WebLLM CDN import (esm.run/@mlc-ai/web-llm) is also dynamic
 *     and gets its own chunk via vite's default behavior.
 */
function manualChunks(id: string): string | undefined {
  if (id.includes("node_modules")) {
    if (id.includes("/three/") || id.includes("\\three\\")) return "vendor-three";
    if (id.includes("@modelcontextprotocol/sdk")) return "vendor-mcp";
    if (id.includes("@noble/") || id.includes("@scure/")) return "vendor-crypto";
    return undefined;
  }
  // See apps/web/vite.config.ts for the layering rationale: motebit-core
  // is the true foundation (used by both runtime and network), so
  // event-log / memory-graph / state-vector / behavior-engine / gradient
  // / policy live there even though they look "runtime-y" by name.
  if (id.includes("/packages/render-engine/")) return "motebit-render";
  if (
    id.includes("/packages/runtime/") ||
    id.includes("/packages/ai-core/") ||
    id.includes("/packages/planner/") ||
    id.includes("/packages/reflection/")
  ) {
    return "motebit-runtime";
  }
  if (
    id.includes("/packages/mcp-client/") ||
    id.includes("/packages/tools/") ||
    id.includes("/packages/sync-engine/") ||
    id.includes("/packages/browser-persistence/") ||
    id.includes("/packages/core-identity/") ||
    id.includes("/packages/identity-file/")
  ) {
    return "motebit-network";
  }
  if (
    id.includes("/packages/sdk/") ||
    id.includes("/packages/protocol/") ||
    id.includes("/packages/crypto/") ||
    id.includes("/packages/semiring/") ||
    id.includes("/packages/policy/") ||
    id.includes("/packages/policy-invariants/") ||
    id.includes("/packages/event-log/") ||
    id.includes("/packages/memory-graph/") ||
    id.includes("/packages/state-vector/") ||
    id.includes("/packages/behavior-engine/") ||
    id.includes("/packages/gradient/") ||
    id.includes("/packages/privacy-layer/")
  ) {
    return "motebit-core";
  }
  return undefined;
}

export default defineConfig({
  server: {
    port: 5175,
    // WebXR requires HTTPS (except localhost)
    https: false,
  },
  build: {
    target: "esnext",
    // See apps/web/vite.config.ts for the calibration rationale. Spatial
    // ships the same ML / 3D dependency floor as web, plus onnxruntime-web
    // for neural VAD (~557 kB, dynamic-imported only when iOS Silero VAD
    // engages).
    chunkSizeWarningLimit: 900,
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
      output: {
        manualChunks,
      },
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
