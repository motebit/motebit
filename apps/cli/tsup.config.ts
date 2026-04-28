import { defineConfig } from "tsup";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync("package.json", "utf-8"));

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node20",
  platform: "node",
  splitting: false,
  shims: true,
  banner: { js: "#!/usr/bin/env node" },
  noExternal: [/^@motebit\//],
  external: [
    "better-sqlite3",
    "sql.js",
    "@xenova/transformers",
    "@modelcontextprotocol/sdk",
    "ws",
    "@noble/ed25519",
    "@noble/hashes",
    // @solana/web3.js pulls in CJS-era deps (bs58 → base-x → safe-buffer)
    // that use dynamic `require("buffer")`, which ESM can't resolve when
    // bundled into the CLI's esm output. Keep them external so Node
    // resolves them at runtime via the CLI's own node_modules.
    "@solana/web3.js",
    "@solana/spl-token",
    "@noble/curves",
    // Relay runtime deps (pulled in via @motebit/relay for `motebit relay up`).
    // @hono/node-server wraps the Node http server + Hono; @hono/node-ws
    // upgrades connections in-place. Both touch Node internals in ways that
    // don't survive being inlined into the esm bundle. Resolve from the
    // CLI's own node_modules instead.
    "@hono/node-server",
    "@hono/node-ws",
    "hono",
    // Stripe's SDK pulls in CJS-era URL encoders (qs → side-channel →
    // object-inspect) that use `require("util")` — fatal in an esm
    // bundle. services/relay imports Stripe at the top level (not lazily),
    // so bundling the deep tree is not optional. Externalize and let
    // node resolve it from the CLI's node_modules at runtime.
    "stripe",
    // @x402/* are loaded via `await import(...)` inside createSyncRelay,
    // only when --pay-to-address is set. Marking them external keeps
    // the dynamic import as a true runtime require rather than letting
    // tsup inline (and risk the same CJS failure as stripe).
    "@x402/core",
    "@x402/evm",
    "@x402/hono",
  ],
  define: {
    __PKG_VERSION__: JSON.stringify(pkg.version),
  },
});
