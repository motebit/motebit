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
 * followed by post-schema checks (CLI_POST_SCHEMA_CHECKS — mirrored where they
 * can fire on a config this gate accepts). `buildVercelConfigSchema` below
 * reproduces that composition from the two packages the CLI pins (root
 * devDependencies at the same exact versions — VERCEL_SCHEMA_SOURCE). The
 * keys whose schemas live only inline in the CLI bundle are NOT reproduced by
 * hand: a vercel.json using one is refused as "not mirrored" — motebit's own
 * fail-closed rule, reported separately (`unmirrored`), never as a Vercel
 * refusal (the CLI may well accept it); the repair is to mirror that key's
 * schema from the CLI, not to guess it.
 *
 * Then `vercel build` compiles the routing keys with @vercel/routing-utils'
 * `getTransformedRoutes` and throws its error — e.g. a rewrite `source` of
 * "/:(" or a route `src` of "/a(" is schema-valid but not a regular
 * expression. That runs here too (routing-utils' own code, same pin). Its
 * path-to-regexp is pinned to 6.3.0 by a scoped root override (the CLI
 * bundles 6.1.0; the repo-wide override would hand it 8.x, whose API
 * routing-utils cannot use; 6.3.0 is 6.1.0 plus the CVE-2024-45296 fix).
 *
 * scripts/__tests__/vercel-cli-verdicts.json is a corpus of mutants with the
 * real CLI's verdict on each, recorded by scripts/record-vercel-cli-verdicts.ts
 * (how to re-record is in its header); the schema test holds this validator to
 * every one of those verdicts.
 * Bumping: read the new CLI's buildVercelConfigSchema, pin its
 * @vercel/routing-utils + @vercel/build-utils versions here and in the root
 * package.json; scripts/__tests__/vercel-config-schema.test.ts goes red if the
 * installed versions or the schema exports drift from this file.
 *
 * Layer 2 — MOTEBIT_TIGHTENING_SCHEMA: motebit's rules on top of the CLI
 * schema, not Vercel's. Only the first has evidence that Vercel's SERVER
 * enforces it (isServerEvidenced picks its errors out); the rest are
 * motebit's own tightening. Each states its evidence:
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

/**
 * Every check vercel@62.2.0's validateConfig runs AFTER the schema (in its
 * order), and whether this file mirrors it. A check is mirrored when it can
 * fire on a config the gate otherwise accepts; the rest only involve keys in
 * CLI_INLINE_KEYS, which the gate already refuses as not mirrored.
 */
export const CLI_POST_SCHEMA_CHECKS = {
  INVALID_SCHEDULE: "schedules (not mirrored key)",
  INVALID_SCHEDULE_TIMEZONE: "schedules (not mirrored key)",
  INVALID_FUNCTION_AFFINITY_REGIONS:
    "mirrored for `functions` (services.*.functions / experimentalServicesV2.*.functions: not mirrored keys)",
  "proxy validateProxyConfig": "proxy (not mirrored key)",
  FUNCTIONS_AND_BUILDS: "mirrored",
  PROXY_AND_BUILDS: "proxy (not mirrored key)",
  EXPERIMENTAL_SERVICES_AND_BUILDS: "experimentalServices (not mirrored key)",
  EXPERIMENTAL_SERVICES_AND_FUNCTIONS: "experimentalServices (not mirrored key)",
  SERVICE_GROUPS_WITHOUT_SERVICES: "experimentalServiceGroups (not mirrored key)",
  SERVICES_AND_EXPERIMENTAL_SERVICES_V2: "services (not mirrored key)",
  "*_AND_EXPERIMENTAL_SERVICES": "services / experimentalServicesV2 (not mirrored keys)",
  "*_AND_BUILDS": "services / experimentalServicesV2 (not mirrored keys)",
  "*_AND_TOP_LEVEL_BUILD_SETTINGS": "services / experimentalServicesV2 (not mirrored keys)",
  INVALID_DAEMON: "daemons (not mirrored key)",
  "*_BINDING_UNKNOWN_SERVICE": "services / experimentalServicesV2 (not mirrored keys)",
} as const;

/** The routing keys `vercel build` hands to getTransformedRoutes. */
export const ROUTING_KEYS = [
  "routes",
  "rewrites",
  "redirects",
  "headers",
  "cleanUrls",
  "trailingSlash",
] as const;

/** Max `ignoreCommand` length Vercel's server enforces (PR #1027's build error; see header). */
export const IGNORE_COMMAND_MAX = 256;

/**
 * Whether a `motebit` verdict entry is the one tightening rule with evidence
 * that Vercel's server enforces it (`ignoreCommand` ≤ IGNORE_COMMAND_MAX);
 * every other entry is motebit's own tightening.
 */
export function isServerEvidenced(error: string): boolean {
  return error.startsWith(`/ignoreCommand must NOT have more than ${IGNORE_COMMAND_MAX} `);
}

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

export interface VercelConfigVerdict {
  /** What Vercel itself refuses: the CLI schema, its post-schema checks, getTransformedRoutes. */
  vercel: string[];
  /** CLI-inline keys this file does not mirror — motebit's fail-closed rule, not a Vercel verdict. */
  unmirrored: string[];
  /** The motebit tightening layer. */
  motebit: string[];
}

export type VercelConfigValidator = (cfg: unknown) => VercelConfigVerdict;

type FunctionConfig = { regions?: unknown; affinity?: { mode?: unknown } };

/** vercel@62.2.0 validateConfig's post-schema checks, for the keys mirrored (CLI_POST_SCHEMA_CHECKS). */
function postSchemaChecks(o: Record<string, unknown>): string[] {
  const out: string[] = [];
  const fns = (o["functions"] ?? {}) as Record<string, FunctionConfig>;
  for (const [pattern, fn] of Object.entries(fns)) {
    const regions = [...new Set(Array.isArray(fn.regions) ? fn.regions : [])];
    if (fn.affinity?.mode === "strict" && (regions.includes("all") || regions.length > 1))
      out.push(
        `/functions/${pattern} affinity mode "strict" requires at most one statically configured region (INVALID_FUNCTION_AFFINITY_REGIONS)`,
      );
  }
  if (o["functions"] != null && o["builds"] != null)
    out.push("/ `functions` cannot be used with `builds` (FUNCTIONS_AND_BUILDS)");
  return out;
}

/** `vercel build`'s route compilation (@vercel/routing-utils getTransformedRoutes) over the routing keys. */
function routingErrors(o: Record<string, unknown>): string[] {
  const routing = structuredClone(
    Object.fromEntries(ROUTING_KEYS.filter((k) => k in o).map((k) => [k, o[k]])),
  );
  const { error } = routingUtils.getTransformedRoutes(
    routing as Parameters<typeof routingUtils.getTransformedRoutes>[0],
  );
  if (error == null) return [];
  const all = error.errors != null && error.errors.length > 0 ? error.errors : [error.message];
  return all.map((m) => `/ ${m} (getTransformedRoutes ${error.code})`);
}

let compiled: VercelConfigValidator | undefined;

/**
 * Both layers, compiled once per process (Ajv compilation of Vercel's schemas
 * is the expensive part; every caller shares the result).
 */
export function compileVercelConfigValidator(): VercelConfigValidator {
  if (compiled != null) return compiled;
  // strict:false — Vercel's schemas carry annotation keywords (`example`,
  // `private`) and untyped `maximum`s that Ajv's strict mode rejects at
  // compile time; they constrain nothing, as in the CLI's compiled validator.
  // unicodeRegExp:false — the CLI's validator is a precompiled Ajv 6 build
  // (dist/chunks/config-validator.mjs) whose `pattern`/`patternProperties`
  // regexes carry no `u` flag, so `^.{1,256}$` counts UTF-16 units: a
  // functions key of 129 U+1F600 (258 units) is refused there. Ajv 8's
  // default `u` counts code points and would accept it. maxLength counts code
  // points in both (ucs2length), so only the regexes need this. The astral
  // and lone-surrogate mutants in vercel-cli-verdicts.json hold it.
  const ajv = new Ajv({ allErrors: true, strict: false, unicodeRegExp: false });
  const vercel = ajv.compile(buildVercelConfigSchema()) as Validate;
  const motebit = ajv.compile(MOTEBIT_TIGHTENING_SCHEMA) as Validate;
  compiled = (cfg) => {
    const v = errorsOf(vercel, cfg);
    const u: string[] = [];
    const isObject = cfg != null && typeof cfg === "object" && !Array.isArray(cfg);
    if (isObject) {
      const o = cfg as Record<string, unknown>;
      for (const k of CLI_INLINE_KEYS) {
        if (k in o)
          u.push(
            `/ \`${k}\` is validated by a schema inline in ${VERCEL_SCHEMA_SOURCE.cli} that scripts/lib/vercel-config-schema.ts does not mirror — mirror it before using the key`,
          );
      }
      // The CLI runs these only once the schema passes, and so must we: they
      // read the shapes the schema guarantees.
      if (v.length === 0) v.push(...postSchemaChecks(o));
      if (v.length === 0) v.push(...routingErrors(o));
    }
    const m = errorsOf(motebit, cfg);
    if (isObject) {
      const known = new Set<string>(VERCEL_TOP_LEVEL_KEYS);
      for (const k of Object.keys(cfg))
        if (!known.has(k)) m.push(`/ unknown top-level key (\`${k}\`)`);
    }
    return { vercel: [...new Set(v)], unmirrored: u, motebit: [...new Set(m)] };
  };
  return compiled;
}
