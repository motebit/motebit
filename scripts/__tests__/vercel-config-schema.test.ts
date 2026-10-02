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
    expect(validate(cfg)).toEqual({ vercel: [], motebit: [] });
  });

  it.each<[string, unknown, "vercel" | "motebit", RegExp]>([
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
    ["functions with builds", { functions: {}, builds: [] }, "vercel", /FUNCTIONS_AND_BUILDS/],
    ["a CLI-inline key it does not mirror", { crons: [] }, "vercel", /crons.*does not mirror/],
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
