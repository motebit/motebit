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
  ],
  define: {
    __PKG_VERSION__: JSON.stringify(pkg.version),
  },
});
