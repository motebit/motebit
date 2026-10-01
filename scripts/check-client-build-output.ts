#!/usr/bin/env tsx
/**
 * check-client-build-output — THE LAW of invariant #166, run on what a client
 * build actually emitted (cold review R3: three rounds found a pre-build or
 * static check judging something other than what ships).
 *
 *   tsx scripts/check-client-build-output.ts <app> [--dir <d>]... [--expo-config]
 *
 * Takes every env var visible to this process (the build's own environment —
 * each surface's package.json build script runs this right after its bundler)
 * plus every `.env*` file in the app dir, drops the values the exclusion rule
 * (`outputScanExclusion`) names, and fails if any remaining value — raw,
 * URL-encoded, JSON-escaped or base64 — appears in any emitted file. The
 * finding names the var; the value is never printed.
 *
 * Defaults per surface (dirs are app-relative):
 *   web / verify  dist/                     (after `vite build`; the guard's
 *                                            closeBundle runs the same law)
 *   docs          .next/ minus .next/cache  (after `next build`: static
 *                                            chunks, prerendered html/rsc,
 *                                            manifests, server output)
 *   mobile        no default dir. `--expo-config` scans the public Expo
 *                 config (`expo config --type public --json` — what ships in
 *                 the app manifest, incl. `extra`); `--dir` adds bundle output
 *                 (EAS `eas-build-on-success`: android/app/build, ios/build).
 * Refuses (exit 1) when nothing was scanned, so it can never pass vacuously.
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
  docs: { dirs: [".next"], skip: ["cache"] },
  mobile: { dirs: [], skip: ["node_modules", "intermediates", "tmp", "kotlin", ".cxx"] },
};

export interface OutputCheckResult {
  findings: string[];
  files: number;
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
  const dirs = (opts.dirs ?? spec.dirs).map((d) => resolve(appDir, d)).filter(existsSync);
  const skip = new Set(spec.skip);
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
    scannedVars: r.scannedVars,
    excluded: { ...r.excluded },
    scanned: [
      ...dirs.map((d) => relative(repo, d)),
      ...(opts.expoConfigJson != null ? ["expo public config"] : []),
    ],
  };
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
      `usage: check-client-build-output <${Object.keys(DEFAULT_DIRS).join("|")}> [--dir d]... [--expo-config]`,
    );
    process.exit(2);
  }
  const dirs: string[] = [];
  for (let i = 1; i < args.length; i++) if (args[i] === "--dir") dirs.push(args[++i] ?? "");
  const expoConfigJson = args.includes("--expo-config")
    ? expoPublicConfig(join(REPO, "apps", app))
    : undefined;
  const r = checkBuildOutput(app, { dirs: dirs.length > 0 ? dirs : undefined, expoConfigJson });
  if (r.files === 0) {
    console.error(
      `[apps/${app}] check-client-build-output: nothing to scan (${r.scanned.join(", ") || "no output dir exists"}) — ` +
        "run it after the build, pointing --dir at the emitted output",
    );
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
    `✓ check-client-build-output [apps/${app}] (the law): ${r.files} emitted file(s) in ${r.scanned.join(", ")} carry none of ` +
      `${r.scannedVars} build env var value(s) (raw / url-encoded / json-escaped / base64); excluded by rule: ${ex || "none"} ` +
      `(short = < ${OUTPUT_SCAN_MIN_LENGTH} chars).`,
  );
}

const isMain =
  process.argv[1] != null && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
