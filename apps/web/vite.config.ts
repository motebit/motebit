import { defineConfig } from "vite";

/**
 * Manual chunk strategy for the web bundle.
 *
 * Several @motebit/* packages and their transitive deps are imported BOTH
 * statically and dynamically across the dependency graph (the rollup
 * `(!) is dynamically imported by ... but also statically imported by ...`
 * warnings flag every instance). When that happens rollup gives up and dumps
 * the module into the entry chunk, which is how `index-*.js` ballooned past
 * 1.2 MB. Manual chunks force-pin those modules into named chunks regardless
 * of import-style ambiguity.
 *
 * Selective by design: this function only CLAIMS the modules it wants to
 * group. Returning `undefined` lets vite's default chunking handle the
 * module — important for dynamic-import-only deps (Xenova transformers,
 * onnxruntime-web, the @mlc-ai/web-llm CDN import) that vite already
 * splits into their own chunks via dynamic-import detection. A blanket
 * `node_modules → vendor` rule would defeat that and produce a 1 MB+
 * vendor chunk.
 *
 * Boundaries chosen for cache stability and parallel fetch:
 *
 *   vendor-three          Three.js — heavy, slow to update, used every paint
 *   vendor-mcp            MCP SDK HTTP transport (Node-only paths externalized)
 *   vendor-crypto         @noble/* + @scure/* — crypto primitives, stable
 *   motebit-render        render-engine (Three.js wrapper) — separate from
 *                         runtime so render updates don't cascade
 *   motebit-runtime       runtime + policy + memory-graph + state-vector +
 *                         behavior-engine + event-log + planner + gradient +
 *                         reflection + ai-core — the orchestration core.
 *                         ai-core sits here because runtime↔ai-core have a
 *                         tight cycle (ai-core needs runtime types, runtime
 *                         needs provider classes); splitting them into
 *                         separate chunks produces a circular-chunk error.
 *   motebit-network       mcp-client + tools + sync-engine + browser-persistence
 *                         + core-identity + identity-file — I/O boundary code
 *   motebit-core          sdk + protocol + crypto + semiring + policy-invariants
 *                         + privacy-layer — foundation types + algebra
 *   (vite auto-split)     transformers, onnxruntime-web, and any other
 *                         dynamic-import-only deps fall through to vite's
 *                         default chunking, which gives them their own files.
 *   (default)             apps/web/src/* + un-claimed small node_modules deps
 *                         — the entry chunk
 *
 * Rationale: caches turn over from outermost (vendor-three, almost never
 * changes) to innermost (app code, changes per commit). A user updating to
 * a new release re-downloads only the chunks whose contents actually
 * changed.
 */
function manualChunks(id: string): string | undefined {
  // Third-party deps — only the heavy / strategic ones get explicit chunks.
  // Everything else falls through to vite's default chunking, which keeps
  // dynamic-import-only deps in their own files (transformers, onnxruntime).
  if (id.includes("node_modules")) {
    if (id.includes("/three/") || id.includes("\\three\\")) return "vendor-three";
    if (id.includes("@modelcontextprotocol/sdk")) return "vendor-mcp";
    if (id.includes("@noble/") || id.includes("@scure/")) return "vendor-crypto";
    return undefined;
  }
  // Motebit packages — group by domain for cache + parallel fetch
  if (id.includes("/packages/render-engine/")) return "motebit-render";
  if (
    id.includes("/packages/runtime/") ||
    id.includes("/packages/policy/") ||
    id.includes("/packages/memory-graph/") ||
    id.includes("/packages/state-vector/") ||
    id.includes("/packages/behavior-engine/") ||
    id.includes("/packages/event-log/") ||
    id.includes("/packages/planner/") ||
    id.includes("/packages/gradient/") ||
    id.includes("/packages/reflection/") ||
    id.includes("/packages/ai-core/")
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
    id.includes("/packages/policy-invariants/") ||
    id.includes("/packages/privacy-layer/")
  ) {
    return "motebit-core";
  }
  // App code — falls through to the default entry chunk
  return undefined;
}

export default defineConfig({
  build: {
    target: "esnext",
    outDir: "dist",
    // Calibrated for an app that ships ML inference (@xenova/transformers,
    // ~824 kB, dynamic-imported on demand by memory-graph/embeddings) and
    // 3D rendering (three.js, ~505 kB, in the initial render path because
    // the droplet IS the primary UI). The default 500 kB threshold assumes
    // a typical webapp; for this surface anything under ~900 kB is the
    // floor of "as small as it can reasonably be". The app entry chunk is
    // ~129 kB after manualChunks; transformers is lazy; three is the only
    // unavoidable cost on first paint.
    chunkSizeWarningLimit: 900,
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
      output: {
        manualChunks,
      },
    },
  },
  worker: {
    format: "es",
  },
  server: {
    port: 3000,
  },
});
