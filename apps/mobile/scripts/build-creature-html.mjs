/**
 * Codegen for apps/mobile/src/creature-webview-bundle.generated.ts.
 *
 * Why: the WebView's `CREATURE_HTML` runs Three.js inside a string HTML
 * template, so `@motebit/render-engine` code cannot be reached by normal
 * imports. Instead we consume the IIFE bundle produced by
 * `packages/render-engine/scripts/build-browser.mjs` — the bundle exposes
 * `window.MotebitRE.{CredentialSatelliteRenderer, createCreature, ...}`
 * — and this script inlines it into a TypeScript string constant that
 * `creature-webview.ts` pastes into its HTML between two `<script>` tags.
 *
 * Run automatically by `metro.config.js` (via `scripts/ensure-creature-html.cjs`)
 * whenever Metro bundles — Xcode's "Bundle React Native code and images"
 * phase, Gradle, `expo export:embed`, `expo start`, EAS — and by the
 * `prestart` / `preios` / `preandroid` / `pretest` / `pretypecheck` scripts.
 * Also runnable standalone: `pnpm run build:creature-html`.
 * `--out <path>` writes elsewhere (used by the codegen test).
 *
 * Invariant #27 (soft): the generated file is the ONLY path by which
 * render-engine code reaches mobile's WebView. Any inline duplication
 * of render-engine code in creature-webview.ts that could instead call
 * `window.MotebitRE.*` is legacy — see stage-2 follow-up in
 * docs/drift-defenses.md.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const MONOREPO = resolve(ROOT, "../..");

const bundlePath = resolve(MONOREPO, "packages/render-engine/dist/browser.iife.js");
const outFlag = process.argv.indexOf("--out");
const outPath =
  outFlag !== -1 && process.argv[outFlag + 1]
    ? resolve(process.argv[outFlag + 1])
    : resolve(ROOT, "src/creature-webview-bundle.generated.ts");

let bundle;
try {
  bundle = readFileSync(bundlePath, "utf8");
} catch (err) {
  console.error(
    `✗ ${bundlePath} not found. Run 'pnpm --filter @motebit/render-engine run build:browser' first.`,
  );
  process.exit(1);
}

// Emit a TS string constant — template-literal safe (backtick + ${ escaped).
// A raw copy of the bundle is fine because the consumer will wrap it in
// <script>…</script> tags, not in another template literal.
const escaped = bundle.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");

const output = `/**
 * AUTO-GENERATED. Do not edit by hand.
 *
 * Source: packages/render-engine/dist/browser.iife.js
 * Regenerate: pnpm --filter @motebit/mobile run build:creature-html
 *   (runs automatically whenever Metro loads metro.config.js)
 *
 * This is the @motebit/render-engine browser bundle, exposed as
 * window.MotebitRE when the WebView evaluates it. Kept gitignored —
 * the build pipeline regenerates it from the package source.
 */

export const MOTEBIT_RE_BUNDLE = \`${escaped}\`;
`;

writeFileSync(outPath, output, "utf8");
console.log(`✓ creature-webview-bundle.generated.ts (${(bundle.length / 1024).toFixed(1)}KB)`);
