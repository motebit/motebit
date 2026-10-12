/**
 * The Release white screen of 2026-10-11, by EXECUTION.
 *
 * `@expo/metro-config` 55.0.27's live-bindings import transform wraps every
 * `import * as X from "<cjs>"` in `namespaceWrapHelper`. Upstream, that
 * helper copies EVERY own key of the CommonJS module onto the namespace
 * object as a getter-only accessor — `default` included — and then assigns
 * `n.default = e`. Bundled code is strict, so for any CJS module that has
 * its own `default` (react-native-quick-crypto, readable-stream) Hermes
 * throws "Cannot assign to property 'default' which has only a getter"
 * before the first frame renders.
 *
 * 55.0.27 is the newest SDK-55 release, so the fix is the pnpm patch at
 * `patches/@expo__metro-config@55.0.27.patch` (skip `default` in the copy
 * loop; the helper sets it explicitly afterwards). This test generates the
 * helper exactly as the transform emits it into the bundle and runs it in
 * strict mode — remove the patch and it goes red.
 */
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

// @expo/metro-config is a dependency of `expo`, not of this app: resolve it
// the way Metro does, through expo's own package directory.
const requireFromApp = createRequire(import.meta.url);
const requireFromExpo = createRequire(requireFromApp.resolve("expo/package.json"));
const metroConfigPkg = requireFromExpo.resolve("@expo/metro-config/package.json");
const requireFromMetroConfig = createRequire(metroConfigPkg);

interface HelpersModule {
  namespaceWrapHelper: (template: unknown, name: unknown) => unknown;
}

function generatedHelperSource(): string {
  const helpers = requireFromMetroConfig("./build/transform-plugins/helpers.js") as HelpersModule;
  const template = (requireFromMetroConfig("@babel/template") as { default: unknown }).default;
  const t = requireFromMetroConfig("@babel/types") as { identifier: (n: string) => unknown };
  const generate = (
    requireFromMetroConfig("@babel/generator") as {
      default: (ast: unknown) => { code: string };
    }
  ).default;
  return generate(helpers.namespaceWrapHelper(template, t.identifier("_interopNamespace"))).code;
}

type Wrap = (e: unknown) => Record<string, unknown>;

function strictHelper(): Wrap {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval -- evaluating the generated helper is the point
  return new Function(
    `"use strict";\n${generatedHelperSource()}\nreturn _interopNamespace;`,
  )() as Wrap;
}

describe("@expo/metro-config namespaceWrapHelper (Release white screen)", () => {
  it("the emitted helper skips the CJS module's own `default` in its copy loop", () => {
    expect(generatedHelperSource()).toMatch(/if \(k === "default"\) return;/);
  });

  it("wraps a CJS module with its own `default` in strict mode without throwing", () => {
    const wrap = strictHelper();
    const cjs = { default: "own-default", createHash: () => "hash" };
    let ns: Record<string, unknown> = {};
    expect(() => {
      ns = wrap(cjs);
    }).not.toThrow();
    expect(ns.default).toBe(cjs);
    expect(ns.createHash).toBe(cjs.createHash);
  });

  it("keeps live getters for the other keys and passes ES modules through", () => {
    const wrap = strictHelper();
    const cjs: Record<string, unknown> = { value: 1 };
    const ns = wrap(cjs);
    cjs.value = 2;
    expect(ns.value).toBe(2);
    const esm = { __esModule: true, default: 3 };
    expect(wrap(esm)).toBe(esm);
  });
});
