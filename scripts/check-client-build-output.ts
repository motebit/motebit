#!/usr/bin/env tsx
/**
 * check-client-build-output — the SECOND NET of invariant #166 (the primary
 * control is the per-var `PUBLIC_BUILD_ENV` allowlist guard), run on what a
 * client build actually emitted (cold review R3: three rounds found a pre-build or
 * static check judging something other than what ships).
 *
 *   tsx scripts/check-client-build-output.ts <app> [--dir <d>]... [--expo-config | --expo-config-only]
 *
 * Takes every env var visible to this process (the build's own environment —
 * each surface's package.json build script runs this right after its bundler)
 * plus every `.env*` file in the app dir, drops the values the exclusion rule
 * (`outputScanExclusion`) names, and fails if any remaining value — its full
 * value raw, URL-encoded, JSON-escaped once or twice, or base64/base64url at
 * any alignment; key-shaped fragments too for secret-named or public-prefixed
 * vars (`fragmentNeedlesApply`) — appears in any emitted file. Declared limit:
 * hex, reversed, char codes and split strings are not searched for. The
 * finding names the var; the value is never printed.
 *
 * Defaults per surface (dirs are app-relative):
 *   web / verify  dist/                     (after `vite build`; the guard's
 *                                            closeBundle runs the same law)
 *   docs          .next/ minus .next/cache, (after `next build`: static
 *                 and public/                chunks, prerendered html/rsc,
 *                                            manifests, server output; public/
 *                                            ships verbatim)
 *   mobile        no default dir. `--expo-config` scans the public Expo
 *                 config (`expo config --type public --json` — what ships in
 *                 the app manifest, incl. `extra`); `--dir` adds bundle output
 *                 (EAS `eas-build-on-success`: android/app/build, ios/build).
 * Never vacuous (`outputVacuityRefusal`): refuses (exit 1) unless at least one
 * JS bundle file (.js/.mjs/.cjs/.jsbundle/.bundle/.hbc) was read from a scanned
 * dir — a `--dir` that does not exist is not silently enough. The one
 * exception is the explicit `--expo-config-only` mode (scans the Expo public
 * config alone); the EAS hook must not use it (`judgeSurfaceWiring`).
 *
 * Law: scripts/lib/client-bundle-secrets.ts (`scanOutputForEnvValues`).
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  OUTPUT_SCAN_MIN_LENGTH,
  collectBuildEnv,
  listOutputFiles,
  outputScanRefusal,
  readOutputFiles,
  scanOutputForEnvValues,
} from "./lib/client-bundle-secrets.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, "..");

const DEFAULT_DIRS: Readonly<Record<string, { dirs: string[]; skip: string[] }>> = {
  web: { dirs: ["dist"], skip: [] },
  verify: { dirs: ["dist"], skip: [] },
  // `skip` entries with a `/` are app-relative paths; bare names skip any dir of that name.
  docs: { dirs: [".next", "public"], skip: [".next/cache"] },
  mobile: { dirs: [], skip: ["node_modules", "intermediates", "tmp", "kotlin", ".cxx"] },
};

/** An emitted JS bundle file (web/next chunks, Metro/Hermes bundles). */
const JS_BUNDLE_FILE = /\.(?:m?js|cjs|jsbundle|bundle|hbc)$/;

export interface OutputCheckResult {
  findings: string[];
  files: number;
  /** JS bundle files read from the scanned dirs (the never-vacuous floor). */
  bundleFiles: number;
  /** Requested dirs that do not exist (reported, never silently enough). */
  missingDirs: string[];
  scannedVars: number;
  excluded: Record<string, number>;
  scanned: string[];
}

export function checkBuildOutput(
  app: string,
  opts: {
    dirs?: string[];
    expoConfigJson?: string;
    processEnv?: Record<string, string | undefined>;
    repo?: string;
  } = {},
): OutputCheckResult {
  const repo = opts.repo ?? REPO;
  const appDir = join(repo, "apps", app);
  const spec = DEFAULT_DIRS[app] ?? { dirs: [], skip: [] };
  const requested = (opts.dirs ?? spec.dirs).map((d) => resolve(appDir, d));
  const dirs = requested.filter(existsSync);
  const skip = new Set(spec.skip.map((s) => (s.includes("/") ? resolve(appDir, s) : s)));
  const paths = dirs.flatMap((d) => listOutputFiles(d, skip));
  const files = function* (): Generator<{ label: string; text: string }> {
    yield* readOutputFiles(paths, (p) => relative(repo, p));
    if (opts.expoConfigJson != null) {
      yield { label: `apps/${app} (expo public config)`, text: opts.expoConfigJson };
    }
  };
  const vars = collectBuildEnv(opts.processEnv ?? process.env, [appDir]);
  const r = scanOutputForEnvValues(app, vars, files());
  return {
    findings: r.findings,
    files: r.files,
    bundleFiles: paths.filter((p) => JS_BUNDLE_FILE.test(p)).length,
    missingDirs: requested.filter((d) => !existsSync(d)).map((d) => relative(repo, d)),
    scannedVars: r.scannedVars,
    excluded: { ...r.excluded },
    scanned: [
      ...dirs.map((d) => relative(repo, d)),
      ...(opts.expoConfigJson != null ? ["expo public config"] : []),
    ],
  };
}

/**
 * Why a run is vacuous, or null. Refused when nothing was read, or — unless
 * the explicit `--expo-config-only` mode — when no JS bundle file was read
 * from a scanned dir (a missing `--dir` is filtered, so the Expo config alone
 * must never be enough for the EAS hook).
 */
export function outputVacuityRefusal(
  app: string,
  r: Pick<OutputCheckResult, "files" | "bundleFiles" | "missingDirs" | "scanned">,
  opts: { expoConfigOnly: boolean },
): string | null {
  const where = [...r.scanned, ...r.missingDirs.map((d) => `${d} (does not exist)`)].join(", ");
  if (r.files === 0) {
    return (
      `[apps/${app}] check-client-build-output: nothing to scan (${where || "no output dir exists"}) — ` +
      "run it after the build, pointing --dir at the emitted output"
    );
  }
  if (!opts.expoConfigOnly && r.bundleFiles === 0) {
    return (
      `[apps/${app}] check-client-build-output: no JS bundle file in the scanned output (${where}) — ` +
      "the scan would pass vacuously; point --dir at the emitted bundle (or use --expo-config-only explicitly, never from a build hook)"
    );
  }
  return null;
}

/** The public Expo config — what ships in the app manifest (incl. `extra`). */
export function expoPublicConfig(appDir: string): string {
  const r = spawnSync("npx", ["expo", "config", "--type", "public", "--json"], {
    cwd: appDir,
    encoding: "utf-8",
    env: process.env,
    timeout: 300_000,
  });
  if (r.status !== 0) {
    throw new Error(
      `expo config --type public failed (exit ${r.status}); cannot judge the manifest: ${(r.stderr ?? "").split("\n")[0]}`,
    );
  }
  return r.stdout;
}

function main(): void {
  const args = process.argv.slice(2);
  const app = args[0];
  if (app == null || app.startsWith("--") || !(app in DEFAULT_DIRS)) {
    console.error(
      `usage: check-client-build-output <${Object.keys(DEFAULT_DIRS).join("|")}> [--dir d]... [--expo-config | --expo-config-only]`,
    );
    process.exit(2);
  }
  const dirs: string[] = [];
  for (let i = 1; i < args.length; i++) if (args[i] === "--dir") dirs.push(args[++i] ?? "");
  const expoConfigOnly = args.includes("--expo-config-only");
  if (expoConfigOnly && dirs.length > 0) {
    console.error(
      "check-client-build-output: --expo-config-only scans the Expo config alone; drop --dir",
    );
    process.exit(2);
  }
  const expoConfigJson =
    expoConfigOnly || args.includes("--expo-config")
      ? expoPublicConfig(join(REPO, "apps", app))
      : undefined;
  const r = checkBuildOutput(app, {
    dirs: expoConfigOnly ? [] : dirs.length > 0 ? dirs : undefined,
    expoConfigJson,
  });
  const vacuous = outputVacuityRefusal(app, r, { expoConfigOnly });
  if (vacuous != null) {
    console.error(vacuous);
    process.exit(1);
  }
  if (r.findings.length > 0) {
    console.error(outputScanRefusal(app, r.findings));
    process.exit(1);
  }
  const ex = Object.entries(r.excluded)
    .map(([k, n]) => `${n} ${k}`)
    .join(", ");
  console.log(
    `✓ check-client-build-output [apps/${app}] (second net): ${r.files} emitted file(s) in ${r.scanned.join(", ")} carry none of ` +
      `${r.scannedVars} build env var value(s) (full value raw / url-encoded / json-escaped once+twice / base64 at all alignments; ` +
      `fragments for secret-named or public-prefixed vars; not hex / reversed / char codes / split strings); excluded by rule: ${ex || "none"} ` +
      `(short = < ${OUTPUT_SCAN_MIN_LENGTH} chars).`,
  );
}

const isMain =
  process.argv[1] != null && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
