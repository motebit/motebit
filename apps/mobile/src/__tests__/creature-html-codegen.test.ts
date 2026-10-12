/**
 * The plain-`xcodebuild` Release failure of 2026-10-11: "Unable to resolve
 * module ./creature-webview-bundle.generated". The file was produced only
 * by the npm `pre*` hooks, which a native build never runs. `metro.config.js`
 * now runs the codegen on load, so every bundling path produces it.
 *
 * Pins both halves: the Metro config calls the codegen at load, and the
 * codegen (writing to a temp path, so the live generated file other tests
 * import is never touched) emits the render-engine bundle as a TS constant.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, "../..");
const monorepoRoot = resolve(projectRoot, "../..");
const require = createRequire(import.meta.url);

describe("creature WebView bundle codegen runs with every Metro bundle", () => {
  it("metro.config.js invokes ensureCreatureHtml at load", () => {
    const src = readFileSync(join(projectRoot, "metro.config.js"), "utf8");
    expect(src).toMatch(
      /require\("\.\/scripts\/ensure-creature-html\.cjs"\)\.ensureCreatureHtml\(\{\s*projectRoot,\s*monorepoRoot\s*\}\)/,
    );
  });

  it("ensureCreatureHtml writes the bundle constant", () => {
    const { ensureCreatureHtml } = require("../../scripts/ensure-creature-html.cjs") as {
      ensureCreatureHtml: (o: {
        projectRoot: string;
        monorepoRoot: string;
        outPath?: string;
      }) => void;
    };
    const dir = mkdtempSync(join(tmpdir(), "creature-html-"));
    try {
      const outPath = join(dir, "bundle.generated.ts");
      ensureCreatureHtml({ projectRoot, monorepoRoot, outPath });
      const out = readFileSync(outPath, "utf8");
      expect(out).toContain("export const MOTEBIT_RE_BUNDLE = `");
      expect(out).toContain("MotebitRE");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
