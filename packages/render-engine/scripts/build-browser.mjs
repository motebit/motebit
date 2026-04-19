/**
 * Build a browser IIFE bundle of @motebit/render-engine.
 *
 * Why: some consumers — notably mobile's WebView `CREATURE_HTML` — run
 * the engine's code inside a string HTML template, where the normal
 * module import path doesn't exist. The IIFE exposes the browser-safe
 * surface as `window.MotebitRE`, and the consumer inlines the bundle
 * via its own codegen step (see `apps/mobile/scripts/build-creature-html.mjs`).
 *
 * Three.js handling: the consumer (WebView HTML) already imports THREE
 * via an ES-module importmap and stashes it at `window.THREE`. A small
 * esbuild plugin rewrites every `import "three"` inside the bundle to
 * read from that global, so we don't ship a second copy of Three.js and
 * the consumer controls the version via its importmap.
 *
 * Output: dist/browser.iife.js (not committed; .turbo-cached).
 */

import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

// Plugin: rewrite every `import ... from "three"` inside the bundle to read
// from `globalThis.THREE` at runtime. The consumer (WebView HTML) already
// imports THREE via its own ES-module importmap and stashes the namespace
// at `window.THREE` before the IIFE runs. CommonJS `module.exports = THREE`
// makes the whole namespace available; esbuild handles both
// `import * as THREE from "three"` and `import { Mesh } from "three"`
// (any named import becomes `THREE.Mesh`, etc.).
const threeAsGlobal = {
  name: "three-as-global",
  setup(b) {
    b.onResolve({ filter: /^three$/ }, () => ({ path: "three", namespace: "three-global" }));
    b.onLoad({ filter: /.*/, namespace: "three-global" }, () => ({
      contents: "module.exports = globalThis.THREE;",
      loader: "js",
    }));
  },
};

await build({
  entryPoints: [resolve(ROOT, "src/browser-entry.ts")],
  bundle: true,
  format: "iife",
  globalName: "MotebitRE",
  platform: "browser",
  target: ["es2022"],
  minify: true,
  outfile: resolve(ROOT, "dist/browser.iife.js"),
  plugins: [threeAsGlobal],
});

console.log("✓ @motebit/render-engine browser bundle → dist/browser.iife.js");
