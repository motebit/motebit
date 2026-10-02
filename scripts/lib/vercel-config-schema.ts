/**
 * What Vercel refuses in a vercel.json — validated with Vercel's OWN schema
 * code, from npm, plus one explicitly-motebit tightening layer on top.
 *
 * Layer 1 — Vercel's schema (VERCEL_SCHEMA_SOURCE). `vercel` CLI 62.2.0
 * (`dist/chunks/*.js`) validates every vercel.json with `validateConfig`,
 * which compiles `buildVercelConfigSchema()`:
 *
 *   { type: "object", additionalProperties: true, properties: {
 *       builds: buildsSchema,               // @vercel/build-utils
 *       routes, cleanUrls, headers, redirects, rewrites, trailingSlash,
 *                                           // @vercel/routing-utils
 *       functions: getFunctionsSchema(),    // @vercel/build-utils
 *       images, crons, schedules, bunVersion, proxy, experimentalServices,
 *       experimentalServiceGroups, services, experimentalServicesV2, daemons,
 *                                           // inline in the CLI bundle
 *   } }
 *
 * plus a `functions` + `builds` exclusion. `buildVercelConfigSchema` below
 * reproduces that composition from the two packages the CLI pins (root
 * devDependencies at the same exact versions — VERCEL_SCHEMA_SOURCE). The
 * keys whose schemas live only inline in the CLI bundle are NOT reproduced by
 * hand: a vercel.json using one is refused as "not mirrored" (fail closed —
 * the repair is to mirror that key's schema from the CLI, not to guess it).
 * Bumping: read the new CLI's buildVercelConfigSchema, pin its
 * @vercel/routing-utils + @vercel/build-utils versions here and in the root
 * package.json; scripts/__tests__/vercel-config-schema.test.ts goes red if the
 * installed versions or the schema exports drift from this file.
 *
 * Layer 2 — MOTEBIT_TIGHTENING_SCHEMA: rules Vercel's SERVER enforces at
 * deploy time that the CLI schema does not carry. These are motebit's, not
 * Vercel's, and each states its evidence:
 *   - `ignoreCommand` ≤ 256 chars. Evidence: PR #1027's motebit-web preview
 *     failed before building with `The vercel.json schema validation failed
 *     with the following message: ignoreCommand should NOT be longer than 256
 *     characters` (the CLI's own services schema allows 2048 — the server is
 *     stricter, so the server's number wins).
 *   - a closed top-level key set (VERCEL_TOP_LEVEL_KEYS): Vercel's documented
 *     project-configuration keys plus every key the CLI schema declares. A
 *     key Vercel accepts but this list lacks fails red (safe direction; the
 *     repair is to add it); a typo never reaches a deploy.
 *   - documented types on the scalar keys the CLI schema leaves open
 *     (commands and outputDirectory: string|null, framework: string|null,
 *     regions: string[], git.deploymentEnabled: boolean | {branch: boolean}).
 *     Unverified against the server's schema (openapi.vercel.sh is blocked
 *     from the build sandboxes); each only ever refuses.
 * NOT covered (known gaps): Vercel's server-side enum of `framework` values,
 * the full shape of `git`/`github`/`images`/…, region names.
 */

import * as buildUtils from "@vercel/build-utils";
import * as routingUtils from "@vercel/routing-utils";
import Ajv, { type ErrorObject } from "ajv";

/** The CLI release whose buildVercelConfigSchema this file mirrors, and the packages it pins. */
export const VERCEL_SCHEMA_SOURCE = {
  cli: "vercel@62.2.0",
  packages: { "@vercel/routing-utils": "6.6.0", "@vercel/build-utils": "14.15.0" },
} as const;

/** Keys buildVercelConfigSchema validates with schemas defined inline in the CLI bundle (not exported by any package). */
export const CLI_INLINE_KEYS = [
  "images",
  "crons",
  "schedules",
  "bunVersion",
  "proxy",
  "experimentalServices",
  "experimentalServiceGroups",
  "services",
  "experimentalServicesV2",
  "daemons",
] as const;

/** The package exports buildVercelConfigSchema composes (a test fails if any disappears). */
export const ROUTING_UTILS_EXPORTS = [
  "routesSchema",
  "cleanUrlsSchema",
  "headersSchema",
  "redirectsSchema",
  "rewritesSchema",
  "trailingSlashSchema",
] as const;
export const BUILD_UTILS_EXPORTS = ["buildsSchema", "getFunctionsSchema"] as const;

/** Vercel CLI 62.2.0's buildVercelConfigSchema, minus the CLI-inline keys (see header). */
export function buildVercelConfigSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: true,
    properties: {
      builds: buildUtils.buildsSchema,
      routes: routingUtils.routesSchema,
      cleanUrls: routingUtils.cleanUrlsSchema,
      headers: routingUtils.headersSchema,
      redirects: routingUtils.redirectsSchema,
      rewrites: routingUtils.rewritesSchema,
      trailingSlash: routingUtils.trailingSlashSchema,
      functions: buildUtils.getFunctionsSchema(),
    },
  };
}

/** Max `ignoreCommand` length Vercel's server enforces (PR #1027's build error; see header). */
export const IGNORE_COMMAND_MAX = 256;

/** Vercel's documented project-configuration keys ∪ the CLI schema's keys. */
export const VERCEL_TOP_LEVEL_KEYS = [
  "$schema",
  "alias",
  "build",
  "buildCommand",
  "builds",
  "bunVersion",
  "cleanUrls",
  "crons",
  "devCommand",
  "env",
  "fluid",
  "framework",
  "functionFailoverRegions",
  "functions",
  "git",
  "github",
  "headers",
  "ignoreCommand",
  "images",
  "installCommand",
  "name",
  "outputDirectory",
  "public",
  "redirects",
  "regions",
  "rewrites",
  "routes",
  "scope",
  "trailingSlash",
  "version",
  ...CLI_INLINE_KEYS,
] as const;

const nullableString = { type: ["string", "null"] };

/** Motebit's tightening layer — NOT Vercel's schema; every rule's evidence is in the header. */
export const MOTEBIT_TIGHTENING_SCHEMA = {
  type: "object",
  properties: {
    ignoreCommand: { ...nullableString, maxLength: IGNORE_COMMAND_MAX },
    buildCommand: nullableString,
    devCommand: nullableString,
    installCommand: nullableString,
    outputDirectory: nullableString,
    framework: nullableString,
    regions: { type: "array", items: { type: "string" } },
    git: {
      type: "object",
      properties: {
        deploymentEnabled: {
          anyOf: [
            { type: "boolean" },
            { type: "object", additionalProperties: { type: "boolean" } },
          ],
        },
      },
    },
  },
} as const;

type Validate = ((data: unknown) => boolean) & { errors?: ErrorObject[] | null };

function describe(e: ErrorObject): string {
  const extra =
    e.keyword === "additionalProperties"
      ? ` (\`${String((e.params as { additionalProperty?: unknown }).additionalProperty)}\`)`
      : "";
  return `${e.instancePath === "" ? "/" : e.instancePath} ${e.message ?? e.keyword}${extra}`;
}

function errorsOf(validate: Validate, cfg: unknown): string[] {
  return validate(cfg) ? [] : (validate.errors ?? []).map(describe);
}

export type VercelConfigValidator = (cfg: unknown) => { vercel: string[]; motebit: string[] };

/**
 * Compile both layers once. `vercel` = what Vercel's own schema code refuses
 * (plus CLI-inline keys this gate does not mirror, and the CLI's
 * functions+builds exclusion); `motebit` = what the tightening layer refuses.
 */
export function compileVercelConfigValidator(): VercelConfigValidator {
  // strict:false — Vercel's schemas carry annotation keywords (`example`,
  // `private`) and untyped `maximum`s that Ajv's strict mode rejects at
  // compile time; they constrain nothing, as in the CLI's compiled validator.
  const ajv = new Ajv({ allErrors: true, strict: false });
  const vercel = ajv.compile(buildVercelConfigSchema()) as Validate;
  const motebit = ajv.compile(MOTEBIT_TIGHTENING_SCHEMA) as Validate;
  return (cfg) => {
    const v = errorsOf(vercel, cfg);
    if (cfg != null && typeof cfg === "object" && !Array.isArray(cfg)) {
      const o = cfg as Record<string, unknown>;
      for (const k of CLI_INLINE_KEYS) {
        if (k in o)
          v.push(
            `/ \`${k}\` is validated by a schema inline in ${VERCEL_SCHEMA_SOURCE.cli} that scripts/lib/vercel-config-schema.ts does not mirror — mirror it before using the key`,
          );
      }
      if (o["functions"] != null && o["builds"] != null)
        v.push("/ `functions` cannot be used with `builds` (FUNCTIONS_AND_BUILDS)");
    }
    const m = errorsOf(motebit, cfg);
    if (cfg != null && typeof cfg === "object" && !Array.isArray(cfg)) {
      const known = new Set<string>(VERCEL_TOP_LEVEL_KEYS);
      for (const k of Object.keys(cfg))
        if (!known.has(k)) m.push(`/ unknown top-level key (\`${k}\`)`);
    }
    return { vercel: [...new Set(v)], motebit: [...new Set(m)] };
  };
}
