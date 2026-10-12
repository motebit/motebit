/**
 * Make `src/creature-webview-bundle.generated.ts` exist before Metro
 * resolves `./creature-webview-bundle.generated`.
 *
 * Called from `metro.config.js`, so EVERY bundling path produces the file:
 * Xcode's "Bundle React Native code and images" phase and Gradle's bundle
 * task (both run `expo export:embed`, which loads the Metro config),
 * `expo export`, `expo start`, and EAS. The npm `pre*` hooks only cover
 * `pnpm ios` / `pnpm start`; a plain `xcodebuild` Release never runs them
 * and failed with "Unable to resolve module ./creature-webview-bundle.generated".
 *
 * Why the Metro config and not an Expo config plugin on the Xcode phase:
 * the Metro config lives outside the generated `ios/` / `android/`
 * directories, so `expo prebuild --clean` cannot drop it, and it also
 * covers Android and the dev server with no per-platform wiring.
 *
 * Idempotent: the codegen overwrites the file from the render-engine
 * browser bundle each run. If that bundle has not been built yet
 * (`packages/render-engine/dist/browser.iife.js`), it is built first —
 * esbuild over render-engine's sources, no `tsc` needed.
 */
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

/**
 * @param {{ projectRoot: string, monorepoRoot: string, outPath?: string }} opts
 */
function ensureCreatureHtml({ projectRoot, monorepoRoot, outPath }) {
  const renderEngineRoot = path.resolve(monorepoRoot, "packages/render-engine");
  const browserBundle = path.resolve(renderEngineRoot, "dist/browser.iife.js");
  if (!fs.existsSync(browserBundle)) {
    execFileSync(process.execPath, [path.resolve(renderEngineRoot, "scripts/build-browser.mjs")], {
      cwd: renderEngineRoot,
      stdio: "inherit",
    });
  }
  const args = [path.resolve(projectRoot, "scripts/build-creature-html.mjs")];
  if (outPath) args.push("--out", outPath);
  execFileSync(process.execPath, args, { cwd: projectRoot, stdio: "inherit" });
}

module.exports = { ensureCreatureHtml };
