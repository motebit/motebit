#!/usr/bin/env tsx
/**
 * check-no-secrets-in-client-bundles — invariant #166. Deny by default.
 *
 * Law: a provider credential never reaches a browser, by construction.
 *
 * Incident 2026-09-30: https://motebit.com/assets/main-*.js carried a Helius
 * mainnet `?api-key=` in plain text. apps/web read `VITE_SOLANA_RPC_URL`, its
 * comment told deployers to set a Helius/Triton/QuickNode URL there, and Vite
 * inlines every `VITE_*` value into public JS. The account was drained to
 * 1M/1M credits and the provider halted every key on it. No gate looked at
 * public env names or at built bundles, so nothing went red.
 *
 * Two arms:
 *   (a) STATIC — every public-prefixed env name (`VITE_*`, `NEXT_PUBLIC_*`,
 *       `EXPO_PUBLIC_*`) in any app's source whose name matches
 *       /KEY|TOKEN|SECRET|PASSWORD|PRIVATE|RPC_URL|API/ is RED unless
 *       `PUBLIC_ENV_ALLOWLIST` names that file + name + why.
 *   (b) BUILT ARTIFACT — every text file under apps/<app>/dist (and
 *       apps/docs/.next/static when built) is scanned for credential shapes
 *       (`CREDENTIAL_RULES`); RED with file + offset, value redacted.
 *
 * Flags: `--root <dir>` scans a fixture tree instead of the repo;
 * `--require-dist <a,b>` fails when those apps have no dist (CI runs this after
 * `pnpm build` so arm (b) can never be vacuous there); `--json` prints findings.
 *
 * Canonical law: scripts/lib/client-bundle-secrets.ts. See docs/drift-defenses.md #166.
 */

import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, resolve, dirname, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { formatRepair } from "./lib/gate-report.js";
import {
  PUBLIC_ENV_ALLOWLIST,
  isSecretShapedEnvName,
  scanArtifactText,
  scanSourceForPublicEnvNames,
} from "./lib/client-bundle-secrets.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, "..");

const SOURCE_EXT = /\.(?:ts|tsx|js|jsx|mjs|cjs|vue|svelte|html)$/;
const ARTIFACT_EXT = /\.(?:js|mjs|cjs|html|css|json|map|txt|webmanifest|svg)$/;
const SOURCE_SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  ".next",
  "build",
  "out",
  "public",
  "__tests__",
  "e2e",
  "coverage",
  ".turbo",
  "src-tauri",
  "android",
  "ios",
  "target",
]);

function walk(dir: string, skip: Set<string>, keep: RegExp, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    if (skip.has(e)) continue;
    const full = join(dir, e);
    let s;
    try {
      s = statSync(full);
    } catch {
      continue;
    }
    if (s.isDirectory()) walk(full, skip, keep, out);
    else if (keep.test(e) && !/\.(?:test|spec)\.[a-z]+$/.test(e)) out.push(full);
  }
  return out;
}

export interface GateResult {
  staticFindings: string[];
  artifactFindings: string[];
  sourceFiles: number;
  apps: number;
  distDirs: string[];
  artifactFiles: number;
  missingDist: string[];
}

export function runGate(root: string, requireDist: string[] = []): GateResult {
  const appsDir = join(root, "apps");
  const apps = existsSync(appsDir)
    ? readdirSync(appsDir).filter((n) => {
        try {
          return statSync(join(appsDir, n)).isDirectory();
        } catch {
          return false;
        }
      })
    : [];

  const allow = new Map<string, string>();
  for (const a of PUBLIC_ENV_ALLOWLIST) allow.set(`${a.file}\u0000${a.name}`, a.why);

  const staticFindings: string[] = [];
  let sourceFiles = 0;
  for (const app of apps) {
    for (const file of walk(join(appsDir, app), SOURCE_SKIP_DIRS, SOURCE_EXT)) {
      sourceFiles++;
      const rel = relative(root, file).split(sep).join("/");
      const text = readFileSync(file, "utf8");
      const seen = new Set<string>();
      for (const { name, offset } of scanSourceForPublicEnvNames(text)) {
        if (!isSecretShapedEnvName(name) || seen.has(name)) continue;
        seen.add(name);
        if (allow.has(`${rel}\u0000${name}`)) continue;
        const line = text.slice(0, offset).split("\n").length;
        staticFindings.push(
          `${rel}:${line} — public env \`${name}\` is inlined into client JS and its name is credential-shaped`,
        );
      }
    }
  }

  // A stale allowlist entry is a pre-authorization waiting for a future leak:
  // only checked against the real repo (a fixture root has its own files).
  if (resolve(root) === REPO) {
    for (const a of PUBLIC_ENV_ALLOWLIST) {
      const full = join(root, a.file);
      const text = existsSync(full) ? readFileSync(full, "utf8") : "";
      if (!scanSourceForPublicEnvNames(text).some((n) => n.name === a.name)) {
        staticFindings.push(
          `${a.file} — stale PUBLIC_ENV_ALLOWLIST entry for \`${a.name}\` (the file no longer references it); delete the entry`,
        );
      }
    }
  }

  const distDirs: string[] = [];
  for (const app of apps) {
    for (const d of ["dist", join(".next", "static")]) {
      const full = join(appsDir, app, d);
      if (existsSync(full)) distDirs.push(full);
    }
  }
  const missingDist = requireDist.filter((a) => !existsSync(join(appsDir, a, "dist")));

  const artifactFindings: string[] = [];
  let artifactFiles = 0;
  for (const d of distDirs) {
    for (const file of walk(d, new Set(["node_modules"]), ARTIFACT_EXT)) {
      artifactFiles++;
      const text = readFileSync(file, "utf8");
      const rel = relative(root, file).split(sep).join("/");
      for (const f of scanArtifactText(text)) {
        artifactFindings.push(`${rel} @ offset ${f.offset} — ${f.rule}: ${f.redacted}`);
      }
    }
  }

  return {
    staticFindings,
    artifactFindings,
    sourceFiles,
    apps: apps.length,
    distDirs: distDirs.map((d) => relative(root, d).split(sep).join("/")),
    artifactFiles,
    missingDist,
  };
}

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const isMain =
  process.argv[1] != null && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const root = resolve(argValue("--root") ?? REPO);
  const requireDist = (argValue("--require-dist") ?? "").split(",").filter(Boolean);
  const r = runGate(root, requireDist);

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(r));
    process.exit(0);
  }

  const sites = [
    ...r.staticFindings,
    ...r.artifactFindings,
    ...r.missingDist.map((a) => `apps/${a}/dist — required by --require-dist but not built`),
  ];
  if (sites.length > 0) {
    process.stderr.write(
      formatRepair({
        invariant: `check-no-secrets-in-client-bundles: ${sites.length} way(s) a credential can reach a browser bundle`,
        canonical: "scripts/lib/client-bundle-secrets.ts (PUBLIC_ENV_ALLOWLIST, CREDENTIAL_RULES)",
        fix:
          "Remove the credential from the client: move it to a server secret and have the browser call a motebit server " +
          "that holds it (browser Solana RPC → services/proxy/src/solana-rpc.ts at https://api.motebit.com/v1/solana-rpc). " +
          "For a public-env NAME that is genuinely public (a publishable key, a plain URL), add a PUBLIC_ENV_ALLOWLIST entry " +
          "with file + name + why. For a built-artifact hit, unset the env var that inlined it and rebuild " +
          "(pnpm --filter @motebit/web build). Rotate any real key that was published.",
        sites,
        doctrine:
          "docs/drift-defenses.md #166; CLAUDE.md fail-closed privacy; docs/doctrine/security-boundaries.md",
      }),
    );
    process.exit(1);
  }

  console.log(
    `✓ check-no-secrets-in-client-bundles: ${r.sourceFiles} app source file(s) across ${r.apps} apps scanned for credential-shaped public env names ` +
      `(${PUBLIC_ENV_ALLOWLIST.length} allowlisted with a reason); ${r.artifactFiles} built artifact file(s) in ${r.distDirs.length} dist dir(s) ` +
      `scanned for credential shapes${r.distDirs.length > 0 ? ` (${r.distDirs.join(", ")})` : " — none built; CI runs --require-dist after pnpm build"}.`,
  );
}
