import { defineConfig } from "tsup";

export default defineConfig([
  // Main bundle — full verify/sign surface. Node-targeted (also works in
  // browsers; the subpath below is for runtimes that can't afford the
  // full bundle).
  {
    entry: ["src/index.ts"],
    format: ["esm"],
    target: "node18",
    platform: "node",
    splitting: false,
    // DTS generated separately via tsc (tsup DTS doesn't handle multi-file well)
    dts: false,
    // Bundle all dependencies into the output — zero runtime deps
    noExternal: [/.*/],
  },
  // Edge-compatible suite-dispatch subpath. Exposes `verifyBySuite`,
  // `signBySuite`, and the Ed25519 primitive entry points without
  // dragging in YAML parsing, did:key, base58, or credential-anchor
  // code — so services running on Vercel Edge / Workers can route
  // through the dispatcher without blowing the bundle budget. Platform
  // "neutral" so nothing Node-only creeps in.
  {
    entry: ["src/suite-dispatch.ts"],
    outDir: "dist",
    format: ["esm"],
    target: "es2022",
    platform: "neutral",
    splitting: false,
    dts: false,
    noExternal: [/.*/],
  },
]);
