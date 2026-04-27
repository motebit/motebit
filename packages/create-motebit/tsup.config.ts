import { defineConfig } from "tsup";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const pkg = JSON.parse(readFileSync("package.json", "utf-8"));

// Per-package version pins for the scaffold. Each scaffold-emitted
// `package.json` carries a `^MAJOR.MINOR.PATCH` range for these three
// motebit packages; the range must match what's actually published. A
// single shared constant is wrong because the three packages bump on
// different cadences (e.g. this release: crypto+verify minor, sdk+motebit
// patch — the smoke test caught that conflation when ^1.1.0 was emitted
// for sdk@1.0.1 and resolution failed).
function readPkgVersion(name: string): string {
  const entry = require.resolve(name);
  const pkgJson = JSON.parse(readFileSync(join(dirname(entry), "..", "package.json"), "utf-8"));
  return String(pkgJson.version);
}

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
    __CRYPTO_VERSION__: JSON.stringify(readPkgVersion("@motebit/crypto")),
    __SDK_VERSION__: JSON.stringify(readPkgVersion("@motebit/sdk")),
    __MOTEBIT_VERSION__: JSON.stringify(readPkgVersion("motebit")),
  },
});
