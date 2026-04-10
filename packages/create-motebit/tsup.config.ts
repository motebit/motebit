import { defineConfig } from "tsup";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const pkg = JSON.parse(readFileSync("package.json", "utf-8"));

// Resolve @motebit/crypto's package.json by finding its main entry and going up
const verifyEntry = require.resolve("@motebit/crypto");
const verifyPkg = JSON.parse(
  readFileSync(join(dirname(verifyEntry), "..", "package.json"), "utf-8"),
);

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node18",
  platform: "node",
  splitting: false,
  shims: true,
  banner: { js: "#!/usr/bin/env node" },
  noExternal: [/.*/],
  define: {
    __PKG_VERSION__: JSON.stringify(pkg.version),
    __VERIFY_VERSION__: JSON.stringify(verifyPkg.version),
  },
});
