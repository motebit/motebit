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
  external: ["better-sqlite3", "sql.js", "@xenova/transformers", "@modelcontextprotocol/sdk", "ws"],
  define: {
    __PKG_VERSION__: JSON.stringify(pkg.version),
  },
});
