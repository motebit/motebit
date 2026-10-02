/**
 * scripts/lib/vercel-config-schema.ts — the gate validates vercel.json with
 * Vercel's OWN schema code, so it must stay pinned to the packages the
 * mirrored CLI release pins, and those packages must still export the schemas
 * buildVercelConfigSchema composes. Either drifting turns this red.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import * as buildUtils from "@vercel/build-utils";
import * as routingUtils from "@vercel/routing-utils";
import { describe, expect, it } from "vitest";

import {
  BUILD_UTILS_EXPORTS,
  buildVercelConfigSchema,
  CLI_INLINE_KEYS,
  CLI_POST_SCHEMA_CHECKS,
  compileVercelConfigValidator,
  IGNORE_COMMAND_MAX,
  ROUTING_UTILS_EXPORTS,
  VERCEL_SCHEMA_SOURCE,
  VERCEL_TOP_LEVEL_KEYS,
} from "../lib/vercel-config-schema.js";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const require = createRequire(join(REPO, "package.json"));
const rootManifest = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")) as {
  devDependencies: Record<string, string>;
};

describe("pinned to the packages vercel CLI pins", () => {
  it.each(Object.entries(VERCEL_SCHEMA_SOURCE.packages))(
    "%s: root devDependency and installed version are exactly %s",
    (name, version) => {
      expect(rootManifest.devDependencies[name]).toBe(version);
      const installed = JSON.parse(
        readFileSync(require.resolve(`${name}/package.json`), "utf8"),
      ) as { version: string };
      expect(installed.version).toBe(version);
    },
  );
});

describe("the schema exports buildVercelConfigSchema composes still exist", () => {
  it.each(ROUTING_UTILS_EXPORTS)("@vercel/routing-utils exports %s as a schema", (name) => {
    const s = (routingUtils as Record<string, unknown>)[name] as { type?: unknown } | undefined;
    expect(s, name).toBeTypeOf("object");
    expect(s!.type, name).toBeDefined();
  });

  it.each(BUILD_UTILS_EXPORTS)("@vercel/build-utils exports %s", (name) => {
    const s = (buildUtils as Record<string, unknown>)[name];
    const schema = (typeof s === "function" ? (s as () => unknown)() : s) as
      { type?: unknown } | undefined;
    expect(schema, name).toBeTypeOf("object");
    expect(schema!.type, name).toBeDefined();
  });

  it("composes every package-exported key of the CLI's buildVercelConfigSchema", () => {
    const props = Object.keys(
      (buildVercelConfigSchema() as { properties: Record<string, unknown> }).properties,
    ).sort();
    expect(props).toEqual(
      [
        "builds",
        "routes",
        "cleanUrls",
        "headers",
        "redirects",
        "rewrites",
        "trailingSlash",
        "functions",
      ].sort(),
    );
    for (const k of CLI_INLINE_KEYS) expect(VERCEL_TOP_LEVEL_KEYS).toContain(k);
  });
});

describe("compileVercelConfigValidator", () => {
  const validate = compileVercelConfigValidator();

  it.each([
    ["apps/web/vercel.json"],
    ["apps/verify/vercel.json"],
    ["apps/docs/vercel.json"],
    ["services/proxy/vercel.json"],
  ])("control: committed %s passes both layers", (f) => {
    const cfg = JSON.parse(readFileSync(join(REPO, f), "utf8")) as unknown;
    expect(validate(cfg)).toEqual({ vercel: [], unmirrored: [], motebit: [] });
  });

  it("is compiled once per process (every caller shares one validator)", () => {
    expect(compileVercelConfigValidator()).toBe(validate);
  });

  it.each<[string, unknown, "vercel" | "unmirrored" | "motebit", RegExp]>([
    ["rewrite with no destination", { rewrites: [{ source: "/a" }] }, "vercel", /destination/],
    ["empty rewrite", { rewrites: [{}] }, "vercel", /source/],
    [
      "rewrite with an extra key",
      { rewrites: [{ source: "/a", destination: "/b", x: 1 }] },
      "vercel",
      /additional/,
    ],
    ['"headers": "x"', { headers: "x" }, "vercel", /headers must be array/],
    ["redirect with no destination", { redirects: [{ source: "/a" }] }, "vercel", /destination/],
    ["cleanUrls: 'yes'", { cleanUrls: "yes" }, "vercel", /cleanUrls must be boolean/],
    [
      "functions with builds",
      { functions: { "api/*.js": { memory: 1024 } }, builds: [] },
      "vercel",
      /FUNCTIONS_AND_BUILDS/,
    ],
    [
      'functions affinity "strict" with two regions',
      { functions: { "api/*.js": { regions: ["iad1", "sfo1"], affinity: { mode: "strict" } } } },
      "vercel",
      /INVALID_FUNCTION_AFFINITY_REGIONS/,
    ],
    [
      'functions affinity "strict" with regions ["all"]',
      { functions: { "api/*.js": { regions: ["all"], affinity: { mode: "strict" } } } },
      "vercel",
      /INVALID_FUNCTION_AFFINITY_REGIONS/,
    ],
    [
      'rewrite source "/:("',
      { rewrites: [{ source: "/:(", destination: "/b" }] },
      "vercel",
      /invalid `source` regular expression.*invalid_rewrite/,
    ],
    ['routes src "/a("', { routes: [{ src: "/a(" }] }, "vercel", /invalid_route/],
    [
      "redirect destination segment not in source",
      { redirects: [{ source: "/a/:x", destination: "/b/:y" }] },
      "vercel",
      /invalid_redirect/,
    ],
    ["a CLI-inline key it does not mirror", { crons: [] }, "unmirrored", /crons.*does not mirror/],
    [
      "ignoreCommand of 257 chars",
      { ignoreCommand: "x".repeat(IGNORE_COMMAND_MAX + 1) },
      "motebit",
      /ignoreCommand/,
    ],
    ["regions: 5", { regions: 5 }, "motebit", /regions must be array/],
    ["framework: 1", { framework: 1 }, "motebit", /framework/],
    ["unknown top-level key", { ignoreComand: "x" }, "motebit", /ignoreComand/],
    [
      "git.deploymentEnabled: 'no'",
      { git: { deploymentEnabled: "no" } },
      "motebit",
      /deploymentEnabled/,
    ],
  ])("RED: %s", (_n, cfg, layer, why) => {
    const r = validate(cfg);
    expect(r[layer].join("\n")).toMatch(why);
  });
});

/**
 * Differential: every mutant in vercel-cli-verdicts.json carries the verdict
 * the REAL vercel CLI gave it (validateConfig, then getTransformedRoutes),
 * recorded by scripts/record-vercel-cli-verdicts.ts — re-record per its
 * header. The validator's Vercel layer must agree on every one: refuse
 * exactly what the CLI refuses. Keys it does not mirror may add an
 * `unmirrored` refusal (motebit's own), never a `vercel` one the CLI lacks.
 */
describe("agrees with vercel@62.2.0 on every recorded mutant", () => {
  const corpus = JSON.parse(
    readFileSync(join(REPO, "scripts/__tests__/vercel-cli-verdicts.json"), "utf8"),
  ) as {
    $comment: string;
    mutants: {
      name: string;
      node?: string;
      config: unknown;
      cli: { ok: boolean; code?: string };
    }[];
  };
  const validate = compileVercelConfigValidator();

  it("was recorded from the CLI release this file mirrors, and covers every mirrored post-schema check", () => {
    expect(corpus.$comment).toContain(VERCEL_SCHEMA_SOURCE.cli);
    expect(corpus.mutants.length).toBeGreaterThanOrEqual(80);
    const codes = new Set(corpus.mutants.map((m) => m.cli.code));
    for (const [code, how] of Object.entries(CLI_POST_SCHEMA_CHECKS))
      if (how.startsWith("mirrored")) expect(codes, code).toContain(code);
    for (const c of ["invalid_rewrite", "invalid_redirect", "invalid_header", "invalid_route"])
      expect(codes, c).toContain(c);
  });

  it.each(corpus.mutants.map((m) => [m.name, m] as const))("%s", (_name, m) => {
    const r = validate(structuredClone(m.config));
    if (m.cli.ok) expect(r.vercel, "the CLI accepts this").toEqual([]);
    else
      expect(
        [...r.vercel, ...r.unmirrored].length,
        `the CLI refuses this (${m.cli.code ?? ""})`,
      ).toBeGreaterThan(0);
  });

  /**
   * The CLI compiles every regex without the `u` flag (UTF-16 units), Ajv 8
   * with it by default (code points); the two disagree only on input with
   * surrogates. So every regex-bearing node of the composed schema must have
   * mutants tagged with its JSON pointer (`node`): one the CLI accepts (the
   * surrounding config is otherwise valid, so the regex decides), one
   * carrying an astral code point (surrogate pair), one a lone surrogate. A
   * schema bump that adds a `pattern` or `patternProperties` goes red here
   * until its mutants are recorded.
   */
  it("every pattern / patternProperties node in the composed schema has recorded astral and lone-surrogate mutants", () => {
    const esc = (k: string): string => k.replace(/~/g, "~0").replace(/\//g, "~1");
    const nodes: string[] = [];
    const walk = (n: unknown, ptr: string): void => {
      if (n == null || typeof n !== "object") return;
      if (Array.isArray(n)) {
        n.forEach((x, i) => walk(x, `${ptr}/${i}`));
        return;
      }
      const o = n as Record<string, unknown>;
      if (typeof o["pattern"] === "string") nodes.push(ptr);
      if (o["patternProperties"] != null && typeof o["patternProperties"] === "object")
        for (const re of Object.keys(o["patternProperties"]))
          nodes.push(`${ptr}/patternProperties/${esc(re)}`);
      for (const [k, v] of Object.entries(o)) walk(v, `${ptr}/${esc(k)}`);
    };
    walk(buildVercelConfigSchema(), "");
    expect(nodes.length).toBeGreaterThanOrEqual(10);

    const pair = /[\uD800-\uDBFF][\uDC00-\uDFFF]/;
    const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    const missing: string[] = [];
    for (const node of nodes) {
      const tagged = corpus.mutants.filter((m) => m.node === node);
      const raw = tagged.map((m) => collectStrings(m.config).join("\n"));
      if (!tagged.some((m) => m.cli.ok)) missing.push(`${node}: no mutant the CLI accepts`);
      if (!raw.some((s) => pair.test(s)))
        missing.push(`${node}: no astral (surrogate-pair) mutant`);
      if (!raw.some((s) => lone.test(s))) missing.push(`${node}: no lone-surrogate mutant`);
    }
    expect(missing).toEqual([]);
    for (const m of corpus.mutants)
      if (m.node != null) expect(nodes, `${m.name} tags an unknown node`).toContain(m.node);
  });
});

/** Every string in a JSON value, property names included. */
function collectStrings(v: unknown): string[] {
  if (typeof v === "string") return [v];
  if (Array.isArray(v)) return v.flatMap(collectStrings);
  if (v != null && typeof v === "object")
    return Object.entries(v).flatMap(([k, x]) => [k, ...collectStrings(x)]);
  return [];
}
