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
 * Three arms, one law (`publicEnvViolations` in the canonical module):
 *   (a) STATIC — in a deployed surface governed by `PUBLIC_BUILD_ENV` (web,
 *       verify), EVERY public-prefixed env name (`VITE_*`, `NEXT_PUBLIC_*`,
 *       `EXPO_PUBLIC_*`, any case) its source references must be named for that
 *       surface. In every other app, a credential-shaped name
 *       (/KEY|TOKEN|SECRET|PASSWORD|PRIVATE|RPC_URL|API/, any case) is RED unless
 *       `PUBLIC_ENV_ALLOWLIST` names that file + name + why; a stale entry is RED.
 *   (b) BUILT ARTIFACT — every text file under apps/<app>/dist (and
 *       apps/docs/.next/static when built) is scanned for credential shapes
 *       (`CREDENTIAL_RULES`); in a governed surface, every public env pair the
 *       bundler emitted (the whole-object `import.meta.env` literal) must pass
 *       the same name + value law as the build. RED with file + offset, redacted.
 *   (c) WIRING, BY EXECUTION — each governed surface's real `vite.config.ts` is
 *       loaded through vite's own `loadConfigFromFile` with a planted unlisted
 *       `VITE_*` var; it must refuse. Deleting the `enforcePublicBuildEnv` call
 *       turns this red (a check-gates-effective probe does exactly that).
 *
 * Flags: `--root <dir>` scans a fixture tree instead of the repo;
 * `--require-dist <a,b>` fails when those apps have no dist (CI runs this after
 * `pnpm build` so arm (b) can never be vacuous there); `--json` prints findings.
 *
 * Canonical law: scripts/lib/client-bundle-secrets.ts. See docs/drift-defenses.md #166.
 */

import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve, dirname, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { formatRepair } from "./lib/gate-report.js";
import {
  PUBLIC_BUILD_ENV,
  PUBLIC_ENV_ALLOWLIST,
  isSecretShapedEnvName,
  publicEnvViolations,
  scanArtifactForPublicEnvPairs,
  scanArtifactText,
  scanSourceForPublicEnvNames,
  type PublicEnvAllowEntry,
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

export interface GateOptions {
  /** The root whose PUBLIC_ENV_ALLOWLIST is checked for stale entries (default: this repo). */
  repoRoot?: string;
  allowlist?: readonly PublicEnvAllowEntry[];
}

export function runGate(
  root: string,
  requireDist: string[] = [],
  opts: GateOptions = {},
): GateResult {
  const allowlist = opts.allowlist ?? PUBLIC_ENV_ALLOWLIST;
  const repoRoot = resolve(opts.repoRoot ?? REPO);
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
  for (const a of allowlist) allow.set(`${a.file}\u0000${a.name}`, a.why);

  const staticFindings: string[] = [];
  let sourceFiles = 0;
  for (const app of apps) {
    const governed = Object.hasOwn(PUBLIC_BUILD_ENV, app);
    for (const file of walk(join(appsDir, app), SOURCE_SKIP_DIRS, SOURCE_EXT)) {
      sourceFiles++;
      const rel = relative(root, file).split(sep).join("/");
      const text = readFileSync(file, "utf8");
      const seen = new Set<string>();
      for (const { name, offset } of scanSourceForPublicEnvNames(text)) {
        if (seen.has(name)) continue;
        seen.add(name);
        const line = text.slice(0, offset).split("\n").length;
        if (governed) {
          for (const p of publicEnvViolations(app, [{ name }])) {
            staticFindings.push(`${rel}:${line} — ${p}`);
          }
          continue;
        }
        if (!isSecretShapedEnvName(name)) continue;
        if (allow.has(`${rel}\u0000${name}`)) continue;
        staticFindings.push(
          `${rel}:${line} — public env \`${name}\` is inlined into client JS and its name is credential-shaped`,
        );
      }
    }
  }

  // A stale allowlist entry is a pre-authorization waiting for a future leak:
  // checked when `root` is the allowlist's own repo (a fixture root has its own
  // files; tests inject `repoRoot` + `allowlist` to pin this branch).
  if (resolve(root) === repoRoot) {
    for (const a of allowlist) {
      const full = join(root, a.file);
      const text = existsSync(full) ? readFileSync(full, "utf8") : "";
      if (!scanSourceForPublicEnvNames(text).some((n) => n.name === a.name)) {
        staticFindings.push(
          `${a.file} — stale PUBLIC_ENV_ALLOWLIST entry for \`${a.name}\` (the file no longer references it); delete the entry`,
        );
      }
    }
  }

  const distDirs: { app: string; dir: string }[] = [];
  for (const app of apps) {
    for (const d of ["dist", join(".next", "static")]) {
      const full = join(appsDir, app, d);
      if (existsSync(full)) distDirs.push({ app, dir: full });
    }
  }
  const missingDist = requireDist.filter((a) => !existsSync(join(appsDir, a, "dist")));

  const artifactFindings: string[] = [];
  let artifactFiles = 0;
  for (const { app, dir } of distDirs) {
    const governed = Object.hasOwn(PUBLIC_BUILD_ENV, app);
    for (const file of walk(dir, new Set(["node_modules"]), ARTIFACT_EXT)) {
      artifactFiles++;
      const text = readFileSync(file, "utf8");
      const rel = relative(root, file).split(sep).join("/");
      for (const f of scanArtifactText(text)) {
        artifactFindings.push(`${rel} @ offset ${f.offset} — ${f.rule}: ${f.redacted}`);
      }
      if (!governed) continue;
      for (const pair of scanArtifactForPublicEnvPairs(text)) {
        for (const p of publicEnvViolations(app, [pair])) {
          artifactFindings.push(`${rel} @ offset ${pair.offset} — public-env-law: ${p}`);
        }
      }
    }
  }

  return {
    staticFindings,
    artifactFindings,
    sourceFiles,
    apps: apps.length,
    distDirs: distDirs.map((d) => relative(root, d.dir).split(sep).join("/")),
    artifactFiles,
    missingDist,
  };
}

/** An unlisted public var planted to prove a surface's vite config refuses it. */
export const WIRING_PROBE_VAR = "VITE___GATE_WIRING_PROBE";

/**
 * Arm (c): load each governed surface's real vite config through vite's own
 * `loadConfigFromFile` (the code path `vite build` takes) with an unlisted
 * public var planted in process.env. The config must throw naming that var.
 * Vite is resolved from this repo's `apps/<app>` install.
 */
export async function checkWiring(
  root: string,
): Promise<{ findings: string[]; checked: string[] }> {
  const findings: string[] = [];
  const checked: string[] = [];
  for (const app of Object.keys(PUBLIC_BUILD_ENV)) {
    const appDir = join(root, "apps", app);
    if (!existsSync(appDir)) continue;
    const cfg = join(appDir, "vite.config.ts");
    const rel = relative(root, cfg).split(sep).join("/");
    checked.push(rel);
    if (!existsSync(cfg)) {
      findings.push(
        `${rel} — governed surface has no vite.config.ts to enforce PUBLIC_BUILD_ENV.${app}`,
      );
      continue;
    }
    let vite: {
      loadConfigFromFile: (
        env: { command: "build"; mode: string; isSsrBuild: boolean; isPreview: boolean },
        file: string,
        root: string,
        logLevel: "silent",
      ) => Promise<unknown>;
    };
    try {
      const req = createRequire(join(REPO, "apps", app, "package.json"));
      vite = (await import(pathToFileURL(req.resolve("vite")).href)) as typeof vite;
    } catch (err) {
      findings.push(
        `${rel} — cannot resolve vite to execute the config (${err instanceof Error ? err.message : String(err)}); run pnpm install`,
      );
      continue;
    }
    const prev = process.env[WIRING_PROBE_VAR];
    process.env[WIRING_PROBE_VAR] = "1";
    let refused = "";
    try {
      await vite.loadConfigFromFile(
        { command: "build", mode: "production", isSsrBuild: false, isPreview: false },
        cfg,
        appDir,
        "silent",
      );
    } catch (err) {
      refused = err instanceof Error ? err.message : String(err);
    } finally {
      if (prev === undefined) delete process.env[WIRING_PROBE_VAR];
      else process.env[WIRING_PROBE_VAR] = prev;
    }
    if (!refused.includes("refusing to build") || !refused.includes(WIRING_PROBE_VAR)) {
      findings.push(
        `${rel} — executing the config with an unlisted ${WIRING_PROBE_VAR} did not refuse the build; ` +
          `its default export must call enforcePublicBuildEnv("${app}", process.env, () => loadEnv(mode, process.cwd(), "")) first` +
          (refused ? ` (it threw something else: ${refused.split("\n")[0]})` : ""),
      );
    }
  }
  return { findings, checked };
}

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const isMain =
  process.argv[1] != null && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
async function main(): Promise<void> {
  const root = resolve(argValue("--root") ?? REPO);
  const requireDist = (argValue("--require-dist") ?? "").split(",").filter(Boolean);
  const r = runGate(root, requireDist);
  const wiring = await checkWiring(root);

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ ...r, wiring }));
    process.exit(0);
  }

  const sites = [
    ...r.staticFindings,
    ...r.artifactFindings,
    ...wiring.findings,
    ...r.missingDist.map((a) => `apps/${a}/dist — required by --require-dist but not built`),
  ];
  if (sites.length > 0) {
    process.stderr.write(
      formatRepair({
        invariant: `check-no-secrets-in-client-bundles: ${sites.length} way(s) a credential can reach a browser bundle`,
        canonical:
          "scripts/lib/client-bundle-secrets.ts (PUBLIC_BUILD_ENV, enforcePublicBuildEnv, PUBLIC_ENV_ALLOWLIST, CREDENTIAL_RULES)",
        fix:
          "Remove the credential from the client: move it to a server secret and have the browser call a motebit server " +
          "that holds it (browser Solana RPC → services/proxy/src/solana-rpc.ts at https://api.motebit.com/v1/solana-rpc). " +
          "In apps/web or apps/verify, a public env name that is genuinely public goes in PUBLIC_BUILD_ENV with a value " +
          "validator + why (a URL: its exact host allowlist); elsewhere a PUBLIC_ENV_ALLOWLIST entry with file + name + why. " +
          "A wiring finding means a governed vite.config.ts no longer calls enforcePublicBuildEnv first — restore it. " +
          "For a built-artifact hit, unset the env var that inlined it and rebuild " +
          "(pnpm --filter @motebit/web build). Rotate any real key that was published.",
        sites,
        doctrine:
          "docs/drift-defenses.md #166; CLAUDE.md fail-closed privacy; docs/doctrine/security-boundaries.md",
      }),
    );
    process.exit(1);
  }

  const governed = Object.entries(PUBLIC_BUILD_ENV)
    .map(([a, e]) => `${a}: ${e.length}`)
    .join(", ");
  console.log(
    `✓ check-no-secrets-in-client-bundles: ${r.sourceFiles} app source file(s) across ${r.apps} apps scanned — governed surfaces ` +
      `against PUBLIC_BUILD_ENV (${governed} named vars), the rest for credential-shaped public env names ` +
      `(${PUBLIC_ENV_ALLOWLIST.length} allowlisted with a reason); ${r.artifactFiles} built artifact file(s) in ${r.distDirs.length} dist dir(s) ` +
      `scanned for credential shapes + the public env law${r.distDirs.length > 0 ? ` (${r.distDirs.join(", ")})` : " — none built; CI runs --require-dist after pnpm build"}; ` +
      `${wiring.checked.length} vite config(s) executed with a planted unlisted var and refused (${wiring.checked.join(", ") || "none present"}).`,
  );
}

if (isMain) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
