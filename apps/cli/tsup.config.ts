import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node20",
  platform: "node",
  splitting: false,
  shims: true,
  banner: { js: "#!/usr/bin/env node" },
  noExternal: [/^@motebit\//],
  external: ["better-sqlite3", "sql.js", "@xenova/transformers", "@modelcontextprotocol/sdk"],
});
