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
 * THE LAW (cold review R3) is the ground-truth OUTPUT scan
 * (`scanOutputForEnvValues`, scripts/check-client-build-output.ts): every build
 * env value, minus the stated exclusion rule, must be absent from every emitted
 * file. Each governed surface runs it from its own build (package.json `build`,
 * the Vite guard's `closeBundle`, EAS `eas-build-on-success`); this gate re-runs
 * it over whatever governed output is on disk, refuses a build script that
 * drops it, and refuses a second `vite.config.*` beside a Vite surface's
 * `vite.config.ts`. The arms below are EARLY WARNINGS — they judge source and
 * config, not what ships.
 *
 * Three early-warning arms (`publicEnvViolations` in the canonical module):
 *   (a) STATIC — in a deployed surface governed by `PUBLIC_BUILD_ENV`
 *       (`PUBLIC_ENV_SURFACES`: web + verify on Vite, mobile on Expo/EAS, docs on
 *       Next/Vercel), EVERY public env name its bundler inlines (any case) that
 *       its source (incl. .mdx) or committed config (app.json, eas.json — names
 *       AND values —, next.config, vercel.json, package.json) references must be
 *       named for that surface; next.config `env`/`publicRuntimeConfig` are
 *       refused (any spelling, plus `compiler.define`). In every other app, a credential-shaped name
 *       (/KEY|TOKEN|SECRET|PASSWORD|PRIVATE|RPC_URL|API/, any case) is RED unless
 *       `PUBLIC_ENV_ALLOWLIST` names that file + name + why; a stale entry is RED.
 *   (b) BUILT ARTIFACT — every text file under apps/<app>/dist (and
 *       apps/docs/.next/static when built) is scanned for credential shapes
 *       (`CREDENTIAL_RULES`); in a governed surface, every public env pair the
 *       bundler emitted (the whole-object `import.meta.env` literal) must pass
 *       the same name + value law as the build. RED with file + offset, redacted.
 *   (c) WIRING, BY EXECUTION — each Vite surface's real `vite.config.ts` is
 *       resolved through vite's own `resolveConfig` (plugins + env, from the repo
 *       cwd) with an unlisted `VITE_*` var planted in process.env, and again with
 *       it only in a `.env` file in a separate `envDir`; both must refuse.
 *       Removing `publicBuildEnvGuard` from the plugins turns this red (a
 *       check-gates-effective probe does exactly that).
 *
 * Flags: `--root <dir>` scans a fixture tree instead of the repo;
 * `--require-dist <a,b>` fails when those apps have no dist (CI runs this after
 * `pnpm build` so arm (b) can never be vacuous there); `--json` prints findings.
 *
 * Canonical law: scripts/lib/client-bundle-secrets.ts. See docs/drift-defenses.md #166.
 */

import {
  readdirSync,
  readFileSync,
  statSync,
  existsSync,
  mkdtempSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { join, resolve, dirname, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { formatRepair } from "./lib/gate-report.js";
import { checkBuildOutput } from "./check-client-build-output.js";
import {
  PUBLIC_BUILD_ENV,
  PUBLIC_ENV_ALLOWLIST,
  PUBLIC_ENV_SURFACES,
  isSecretShapedEnvName,
  publicEnvViolations,
  scanArtifactForPublicEnvPairs,
  scanArtifactText,
  scanSourceForPublicEnvNames,
  type PublicEnvAllowEntry,
} from "./lib/client-bundle-secrets.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, "..");

const SOURCE_EXT = /\.(?:ts|tsx|js|jsx|mjs|cjs|vue|svelte|html|mdx)$/;
const ARTIFACT_EXT = /\.(?:js|mjs|cjs|html|css|json|map|txt|webmanifest|svg)$/;
/** Skipped at ANY depth (dependencies, tests, native trees, tool caches). */
const SOURCE_SKIP_DIRS = new Set([
  "node_modules",
  "__tests__",
  "e2e",
  ".turbo",
  "src-tauri",
  "android",
  "ios",
  "target",
]);
/**
 * Skipped only at the app ROOT (build output / static assets there). Cold
 * review R3: skipping `build/` `out/` `public/` at any depth hid source that
 * Expo and Next still inline from. (The output scan is the law regardless.)
 */
const ROOT_ONLY_SKIP_DIRS = new Set([".next", "dist", "build", "out", "public", "coverage"]);

function walk(
  dir: string,
  skip: Set<string>,
  keep: RegExp,
  out: string[] = [],
  rootSkip: ReadonlySet<string> = new Set(),
): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    if (skip.has(e) || rootSkip.has(e)) continue;
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

/**
 * A governed surface's committed config file: every public name its bundler
 * inlines must be in PUBLIC_BUILD_ENV[app]; eas.json `build.<profile>.env`
 * values are judged by the same validators; next.config `env` /
 * `publicRuntimeConfig` (which inline ANY name) are refused; and the whole file
 * is scanned for credential shapes.
 */
export function judgeConfigFile(
  app: string,
  rel: string,
  text: string,
  surface: { bundler: string; inlines: RegExp },
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const { name, offset } of scanSourceForPublicEnvNames(text)) {
    if (seen.has(name) || !surface.inlines.test(name)) continue;
    seen.add(name);
    const line = text.slice(0, offset).split("\n").length;
    for (const p of publicEnvViolations(app, [{ name }])) out.push(`${rel}:${line} — ${p}`);
  }
  if (rel.endsWith("/eas.json")) {
    let eas: { build?: Record<string, { env?: Record<string, unknown> }> } = {};
    try {
      eas = JSON.parse(text) as typeof eas;
    } catch {
      out.push(`${rel} — unparseable JSON; cannot judge its build env`);
    }
    for (const [profile, cfg] of Object.entries(eas.build ?? {})) {
      for (const [name, value] of Object.entries(cfg?.env ?? {})) {
        if (!surface.inlines.test(name)) continue;
        for (const p of publicEnvViolations(app, [{ name, value: String(value) }])) {
          out.push(`${rel} build.${profile}.env — ${p}`);
        }
      }
    }
  }
  if (surface.bundler === "next" && /\/next\.config\.[cm]?[jt]s$/.test(rel)) {
    // Any spelling: `env:`, `"env":`, `'env':`, shorthand `env,` / `{ env }`,
    // and `compiler.define` / `defineServer` (cold review R3). Early warning
    // only — the output scan is the law.
    const re =
      /(?:^|[{,\s])["'`]?(env|publicRuntimeConfig|serverRuntimeConfig|define|defineServer)["'`]?\s*(?=[:,}(])/gm;
    for (const m of text.matchAll(re)) {
      const line = text.slice(0, m.index ?? 0).split("\n").length;
      out.push(
        `${rel}:${line} — next.config \`${m[1]}\` inlines arbitrary (non-NEXT_PUBLIC_) values into client JS; read NEXT_PUBLIC_* names listed in PUBLIC_BUILD_ENV.${app} instead`,
      );
    }
  }
  for (const f of scanArtifactText(text)) {
    out.push(`${rel} @ offset ${f.offset} — ${f.rule}: ${f.redacted}`);
  }
  return out;
}

/** The package.json script that must run the output scan (the law) per bundler. */
export const OUTPUT_SCAN_SCRIPT: Readonly<Record<string, string>> = {
  vite: "build",
  next: "build",
  expo: "eas-build-on-success",
};

/**
 * Cheap, explicit wiring for a governed surface:
 *   - a Vite surface has exactly ONE vite config, `vite.config.ts` (Vite prefers
 *     `vite.config.js` / `.mjs` over `.ts`, so a sibling without the guard
 *     would silently replace it — cold review R3);
 *   - its package.json `OUTPUT_SCAN_SCRIPT` script runs
 *     `check-client-build-output.ts <app>` (the law) after the bundler.
 */
export function judgeSurfaceWiring(
  app: string,
  appDir: string,
  surface: { bundler: string },
): string[] {
  const out: string[] = [];
  const rel = (f: string): string => `apps/${app}/${f}`;
  let entries: string[] = [];
  try {
    entries = readdirSync(appDir);
  } catch {
    return out;
  }
  if (surface.bundler === "vite") {
    for (const f of entries) {
      if (/^vite\.config\./.test(f) && f !== "vite.config.ts") {
        out.push(
          `${rel(f)} — a second vite config beside vite.config.ts (Vite loads .js/.mjs/.cjs before .ts, bypassing publicBuildEnvGuard("${app}")); delete it`,
        );
      }
    }
  }
  const script = OUTPUT_SCAN_SCRIPT[surface.bundler];
  if (script == null || !entries.includes("package.json")) return out;
  let scripts: Record<string, string> = {};
  try {
    scripts =
      (
        JSON.parse(readFileSync(join(appDir, "package.json"), "utf8")) as {
          scripts?: Record<string, string>;
        }
      ).scripts ?? {};
  } catch {
    out.push(`${rel("package.json")} — unparseable; cannot confirm the output scan runs`);
    return out;
  }
  const cmd = scripts[script] ?? "";
  if (/--expo-config-only\b/.test(cmd)) {
    out.push(
      `${rel("package.json")} scripts.${script} — uses \`--expo-config-only\`, which skips the bundle (never-vacuous floor); scan the emitted bundle with --dir`,
    );
  }
  if (!new RegExp(`check-client-build-output\\.ts ${app}(?:\\s|$)`).test(cmd)) {
    out.push(
      `${rel("package.json")} scripts.${script} — does not run \`check-client-build-output.ts ${app}\` after the bundler (the output scan is the law)`,
    );
  }
  return out;
}

export interface GateResult {
  staticFindings: string[];
  artifactFindings: string[];
  sourceFiles: number;
  /** Committed config files read for governed surfaces (names, eas env values, credential shapes). */
  configFiles: string[];
  apps: number;
  distDirs: string[];
  artifactFiles: number;
  missingDist: string[];
  /** Governed output dirs the ground-truth output scan (the law) read. */
  outputScanned: string[];
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
  const configFiles: string[] = [];
  let sourceFiles = 0;
  for (const app of apps) {
    const surface = Object.hasOwn(PUBLIC_ENV_SURFACES, app) ? PUBLIC_ENV_SURFACES[app] : undefined;
    const governed = surface != null;
    if (surface != null) {
      for (const cf of surface.configFiles) {
        const full = join(appsDir, app, cf);
        if (!existsSync(full)) continue;
        const rel = relative(root, full).split(sep).join("/");
        configFiles.push(rel);
        staticFindings.push(...judgeConfigFile(app, rel, readFileSync(full, "utf8"), surface));
      }
      staticFindings.push(...judgeSurfaceWiring(app, join(appsDir, app), surface));
    }
    for (const file of walk(
      join(appsDir, app),
      SOURCE_SKIP_DIRS,
      SOURCE_EXT,
      [],
      ROOT_ONLY_SKIP_DIRS,
    )) {
      sourceFiles++;
      const rel = relative(root, file).split(sep).join("/");
      const text = readFileSync(file, "utf8");
      const seen = new Set<string>();
      for (const { name, offset } of scanSourceForPublicEnvNames(text)) {
        if (seen.has(name)) continue;
        seen.add(name);
        const line = text.slice(0, offset).split("\n").length;
        if (governed) {
          // Only names this surface's bundler inlines can ship (vite: every
          // public prefix; expo: EXPO_PUBLIC_*; next: NEXT_PUBLIC_*).
          if (!surface.inlines.test(name)) continue;
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
    const surface = Object.hasOwn(PUBLIC_ENV_SURFACES, app) ? PUBLIC_ENV_SURFACES[app] : undefined;
    for (const file of walk(dir, new Set(["node_modules"]), ARTIFACT_EXT)) {
      artifactFiles++;
      const text = readFileSync(file, "utf8");
      const rel = relative(root, file).split(sep).join("/");
      for (const f of scanArtifactText(text)) {
        artifactFindings.push(`${rel} @ offset ${f.offset} — ${f.rule}: ${f.redacted}`);
      }
      if (surface == null) continue;
      for (const pair of scanArtifactForPublicEnvPairs(text)) {
        if (!surface.inlines.test(pair.name)) continue;
        for (const p of publicEnvViolations(app, [pair])) {
          artifactFindings.push(`${rel} @ offset ${pair.offset} — public-env-law: ${p}`);
        }
      }
    }
  }

  // THE LAW over whatever governed output is on disk, judged against THIS
  // process's env (in CI: the env the build just ran with). Each surface's own
  // build script already ran it; this re-run keeps the gate honest about it.
  const outputScanned: string[] = [];
  for (const app of apps) {
    if (!Object.hasOwn(PUBLIC_ENV_SURFACES, app)) continue;
    const r = checkBuildOutput(app, { repo: root });
    if (r.files === 0) continue;
    outputScanned.push(...r.scanned);
    artifactFindings.push(...r.findings.map((f) => `${f} — output-scan (the law)`));
  }

  return {
    staticFindings,
    artifactFindings,
    outputScanned,
    sourceFiles,
    configFiles,
    apps: apps.length,
    distDirs: distDirs.map((d) => relative(root, d.dir).split(sep).join("/")),
    artifactFiles,
    missingDist,
  };
}

/** An unlisted public var planted to prove a surface's vite config refuses it. */
export const WIRING_PROBE_VAR = "VITE___GATE_WIRING_PROBE";

type ViteResolve = {
  resolveConfig: (
    inline: {
      root: string;
      configFile: string;
      logLevel: "silent";
      envDir?: string;
      mode?: string;
    },
    command: "build",
    mode: string,
  ) => Promise<unknown>;
};

/**
 * Arm (c): resolve each governed surface's real vite config through vite's own
 * `resolveConfig` (the code path `vite build` takes, plugins and env included),
 * from THIS process's cwd (never the app dir), twice: once with an unlisted
 * public var planted in process.env, once with it only in a `.env` file inside
 * a separate `envDir` — so a guard that re-derives env from the cwd instead of
 * judging Vite's resolved env goes red. Both must refuse naming the var.
 * Vite is resolved from this repo's `apps/<app>` install.
 */
export async function checkWiring(
  root: string,
): Promise<{ findings: string[]; checked: string[] }> {
  const findings: string[] = [];
  const checked: string[] = [];
  for (const [app, surface] of Object.entries(PUBLIC_ENV_SURFACES)) {
    if (surface.bundler !== "vite") continue;
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
    let vite: ViteResolve;
    try {
      const req = createRequire(join(REPO, "apps", app, "package.json"));
      vite = (await import(pathToFileURL(req.resolve("vite")).href)) as ViteResolve;
    } catch (err) {
      findings.push(
        `${rel} — cannot resolve vite to execute the config (${err instanceof Error ? err.message : String(err)}); run pnpm install`,
      );
      continue;
    }
    const envDir = mkdtempSync(join(tmpdir(), `gate-wiring-${app}-`));
    writeFileSync(join(envDir, ".env.production"), `${WIRING_PROBE_VAR}=from-env-file\n`);
    const probes: { label: string; inline: { envDir?: string }; plant: boolean }[] = [
      { label: "planted in process.env", inline: {}, plant: true },
      {
        label: "only in <envDir>/.env.production (envDir != cwd)",
        inline: { envDir },
        plant: false,
      },
    ];
    try {
      for (const probe of probes) {
        const prev = process.env[WIRING_PROBE_VAR];
        if (probe.plant) process.env[WIRING_PROBE_VAR] = "1";
        else delete process.env[WIRING_PROBE_VAR];
        let refused = "";
        try {
          await vite.resolveConfig(
            { root: appDir, configFile: cfg, logLevel: "silent", ...probe.inline },
            "build",
            "production",
          );
        } catch (err) {
          refused = err instanceof Error ? err.message : String(err);
        } finally {
          if (prev === undefined) delete process.env[WIRING_PROBE_VAR];
          else process.env[WIRING_PROBE_VAR] = prev;
        }
        if (!refused.includes("refusing to build") || !refused.includes(WIRING_PROBE_VAR)) {
          findings.push(
            `${rel} — resolving the config with an unlisted ${WIRING_PROBE_VAR} ${probe.label} did not refuse the build; ` +
              `its plugins must include publicBuildEnvGuard("${app}") (it judges Vite's resolved config.env in configResolved)` +
              (refused ? ` (it threw something else: ${refused.split("\n")[0]})` : ""),
          );
        }
      }
    } finally {
      rmSync(envDir, { recursive: true, force: true });
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
          "scripts/lib/client-bundle-secrets.ts (PUBLIC_BUILD_ENV, PUBLIC_ENV_SURFACES, publicBuildEnvGuard, PUBLIC_ENV_ALLOWLIST, CREDENTIAL_RULES)",
        fix:
          "Remove the credential from the client: move it to a server secret and have the browser call a motebit server " +
          "that holds it (browser Solana RPC → services/proxy/src/solana-rpc.ts at https://api.motebit.com/v1/solana-rpc). " +
          "In a governed surface (apps/web, apps/verify, apps/mobile, apps/docs), a public env name that is genuinely public goes in PUBLIC_BUILD_ENV with a value " +
          "validator + why (a URL: its exact host allowlist); elsewhere a PUBLIC_ENV_ALLOWLIST entry with file + name + why. " +
          "A wiring finding means a governed vite.config.ts no longer lists publicBuildEnvGuard(app) in plugins — restore it. " +
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
  const staticOnly = Object.entries(PUBLIC_ENV_SURFACES)
    .filter(([, s]) => s.bundler !== "vite")
    .map(([a, s]) => `${a} (${s.bundler})`)
    .join(", ");
  console.log(
    `✓ check-no-secrets-in-client-bundles: THE LAW is the ground-truth output scan (scripts/check-client-build-output.ts — ` +
      `every build env value, minus the stated exclusion rule, absent from every emitted file; run by each governed surface's ` +
      `build script / the vite guard's closeBundle / EAS eas-build-on-success, and here over ` +
      `${r.outputScanned.length > 0 ? r.outputScanned.join(", ") : "no governed output on disk — none built"}). ` +
      `Early warnings below (static arms judge source/config, not what ships): ` +
      `${r.sourceFiles} app source file(s) (incl. .mdx) across ${r.apps} apps — governed surfaces ` +
      `against PUBLIC_BUILD_ENV (${governed} named vars; deny by default), the rest for credential-shaped public env names ` +
      `(${PUBLIC_ENV_ALLOWLIST.length} allowlisted with a reason); ${r.configFiles.length} governed config file(s) judged ` +
      `(${r.configFiles.join(", ")}); ${staticOnly} have no in-bundler hook — their output scan runs from the build script / EAS hook; ` +
      `${r.artifactFiles} built artifact file(s) in ${r.distDirs.length} dist dir(s) ` +
      `scanned for credential shapes + the public env literal${r.distDirs.length > 0 ? ` (${r.distDirs.join(", ")})` : " — none built; CI runs --require-dist after pnpm build"}; ` +
      `${wiring.checked.length} vite config(s) executed with a planted unlisted var and refused (${wiring.checked.join(", ") || "none present"}); ` +
      `sibling vite.config.* refused; every governed build script runs the output scan.`,
  );
}

if (isMain) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
