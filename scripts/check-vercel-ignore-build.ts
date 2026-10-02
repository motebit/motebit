/**
 * Vercel Ignored Build Step routes through scripts/vercel-ignore-build.sh.
 *
 * Every `vercel.json` in the repo that declares an `ignoreCommand` must make
 * it exactly `sh <relative path to scripts/vercel-ignore-build.sh> <args>` —
 * no shell composition (`||`, `&&`, `;`, `|`, `$(`, backticks) that could
 * change the exit status the script decides. The script is the one place the
 * invariant lives: a PRODUCTION build (VERCEL_ENV=production, a push to main)
 * is never skipped; a preview is skipped only when proven safe; every error
 * builds (Vercel: exit 0 = skip, exit 1 = build).
 *
 * #1012: a proxy security fix merged to main as 42ce27f and Vercel reported
 * `motebit-proxy: Canceled by Ignored Build Step`, so production never got
 * the fix. The inline `git diff --quiet … -- services/proxy/ …` ran from the
 * project's Root Directory (services/proxy), where the repo-root pathspecs
 * match nothing — so it exited 0 (skip) on every commit, production included.
 *
 * Arguments are checked too, so a preview skip cannot be "proven" over the
 * wrong set:
 *   - paths mode: every path exists (repo-root relative), and the set covers
 *     the project's own directory, pnpm-lock.yaml, the root package.json and
 *     the directory of every workspace package in the project's transitive
 *     `workspace:` dependency closure (dependencies, devDependencies,
 *     peerDependencies, optionalDependencies);
 *   - `--turbo-ignore <name>`: <name> is the project's own package name.
 *
 * A vercel.json WITHOUT an ignoreCommand is not a violation (it always
 * builds from the repo's point of view) but is listed: its project's ignore
 * step may be configured in the Vercel dashboard, which this gate cannot see.
 *
 * Production ownership (one deployer per project). A project whose
 * production is deployed by a GitHub Action (`vercel --prod` in a workflow
 * whose `on.push` covers `main` and lists `<project dir>/**` in its paths)
 * must disable Vercel's Git-integration deploys of main in its vercel.json
 * (`"git": {"deploymentEnabled": {"main": false}}`), or main deploys twice.
 * Conversely, a vercel.json that disables main must have such an Action, or
 * production never deploys. Pre-existing double deploys are named in
 * KNOWN_DOUBLE_DEPLOY (a stale entry is itself a violation). The workflow ↔
 * project match is by the `<dir>/**` push path only: a workflow that deploys
 * a project without listing its dir is not seen.
 *
 * Exit 1 on any violation.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, posix, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";
import { failWithRepair } from "./lib/gate-report.js";

const SCRIPT = "scripts/vercel-ignore-build.sh";
const WORKSPACE_GLOB_DIRS = ["packages", "apps", "services"];
const SKIP_DIRS = new Set(["node_modules", ".git", ".next", ".turbo", "dist", "out", ".vercel"]);
const DEP_FIELDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];

/**
 * Projects known to deploy main both through a `vercel --prod` Action and
 * through Vercel's Git integration. Pre-existing; not changed by the gate.
 * Remove an entry once its vercel.json disables Git deploys of main.
 */
export const KNOWN_DOUBLE_DEPLOY: Record<string, string> = {
  "services/proxy":
    "deploy-proxy.yml runs `vercel --prod` and the motebit-proxy Git integration also builds main (#1012)",
};

interface Manifest {
  name?: string;
  [field: string]: unknown;
}

function findVercelJsons(root: string, dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) findVercelJsons(root, full, out);
    else if (entry === "vercel.json") out.push(relative(root, full).split("\\").join("/"));
  }
}

export function workspaceManifests(root: string): Map<string, { dir: string; manifest: Manifest }> {
  const out = new Map<string, { dir: string; manifest: Manifest }>();
  for (const group of WORKSPACE_GLOB_DIRS) {
    if (!existsSync(join(root, group))) continue;
    for (const d of readdirSync(join(root, group))) {
      const p = join(root, group, d, "package.json");
      if (!existsSync(p)) continue;
      const manifest = JSON.parse(readFileSync(p, "utf8")) as Manifest;
      if (typeof manifest.name === "string")
        out.set(manifest.name, { dir: `${group}/${d}`, manifest });
    }
  }
  return out;
}

export function closureDirs(
  start: string,
  ws: Map<string, { dir: string; manifest: Manifest }>,
): string[] {
  const seen = new Set<string>();
  const stack = [start];
  while (stack.length > 0) {
    const name = stack.pop()!;
    if (seen.has(name)) continue;
    seen.add(name);
    const m = ws.get(name)?.manifest;
    if (m == null) continue;
    for (const field of DEP_FIELDS) {
      const deps = m[field];
      if (deps == null || typeof deps !== "object") continue;
      for (const [dep, spec] of Object.entries(deps as Record<string, unknown>)) {
        if (String(spec).startsWith("workspace:") && ws.has(dep)) stack.push(dep);
      }
    }
  }
  return [...seen]
    .map((n) => ws.get(n)?.dir)
    .filter((d): d is string => d != null)
    .sort();
}

const norm = (p: string) => posix.normalize(p).replace(/\/+$/, "");

/** Project dirs whose production a `vercel --prod` workflow on push to main deploys. */
export function actionDeployedProjects(root: string, projectDirs: string[]): Map<string, string> {
  const out = new Map<string, string>();
  const wfDir = join(root, ".github", "workflows");
  if (!existsSync(wfDir)) return out;
  for (const f of readdirSync(wfDir).sort()) {
    if (!/\.ya?ml$/.test(f)) continue;
    const text = readFileSync(join(wfDir, f), "utf8");
    if (!/\bvercel\b[^\n]*--prod\b/.test(text)) continue;
    const wf = parseYaml(text) as { on?: { push?: { branches?: unknown; paths?: unknown } } };
    const push = wf?.on?.push;
    const branches = Array.isArray(push?.branches) ? push.branches.map(String) : [];
    if (!branches.includes("main")) continue;
    const paths = Array.isArray(push?.paths) ? push.paths.map(String) : [];
    for (const dir of projectDirs) {
      if (paths.includes(`${dir}/**`)) out.set(dir, `.github/workflows/${f}`);
    }
  }
  return out;
}

function mainGitDeployDisabled(cfg: { git?: unknown }): boolean {
  const g = cfg.git as { deploymentEnabled?: unknown } | undefined;
  const de = g?.deploymentEnabled;
  if (de === false) return true;
  return de != null && typeof de === "object" && (de as Record<string, unknown>)["main"] === false;
}

export interface VercelGateResult {
  files: string[];
  violations: string[];
  routed: string[];
  noIgnore: string[];
  actionOwned: string[];
  knownDoubleDeploy: string[];
}

export function collectVercelViolations(
  root: string,
  knownDoubleDeploy: Record<string, string> = KNOWN_DOUBLE_DEPLOY,
): VercelGateResult {
  const files: string[] = [];
  findVercelJsons(root, root, files);
  files.sort();
  const ws = workspaceManifests(root);
  const violations: string[] = [];
  const routed: string[] = [];
  const noIgnore: string[] = [];
  const actionOwned: string[] = [];
  const knownSeen: string[] = [];
  const deployers = actionDeployedProjects(root, files.map(dirname));

  for (const file of files) {
    const projectDir = dirname(file);
    let cfg: { ignoreCommand?: unknown; git?: unknown };
    try {
      cfg = JSON.parse(readFileSync(join(root, file), "utf8")) as {
        ignoreCommand?: unknown;
        git?: unknown;
      };
    } catch (err) {
      violations.push(
        `${file}: not valid JSON (${err instanceof Error ? err.message : String(err)})`,
      );
      continue;
    }

    const deployer = deployers.get(projectDir);
    const mainOff = mainGitDeployDisabled(cfg);
    if (deployer != null && !mainOff) {
      if (knownDoubleDeploy[projectDir] != null) knownSeen.push(projectDir);
      else
        violations.push(
          `${file}: production is deployed by ${deployer} (\`vercel --prod\`) but Git deploys of main are not disabled — main deploys twice; set "git": {"deploymentEnabled": {"main": false}}`,
        );
    } else if (deployer == null && mainOff) {
      violations.push(
        `${file}: disables Git deploys of main but no workflow runs \`vercel --prod\` on push to main with \`${projectDir}/**\` in its paths — production would never deploy`,
      );
    } else if (deployer != null) {
      actionOwned.push(`${projectDir} (${deployer})`);
    }
    if (knownDoubleDeploy[projectDir] != null && (deployer == null || mainOff)) {
      violations.push(
        `${file}: KNOWN_DOUBLE_DEPLOY lists ${projectDir} but it no longer double-deploys — remove the stale entry`,
      );
    }

    if (cfg.ignoreCommand === undefined) {
      noIgnore.push(projectDir);
      continue;
    }
    const cmd = cfg.ignoreCommand;
    if (typeof cmd !== "string") {
      violations.push(`${file}: ignoreCommand is not a string`);
      continue;
    }
    if (/\|\||&&|[;|`&<>\n]|\$\(/.test(cmd)) {
      violations.push(
        `${file}: ignoreCommand composes shell (\`${cmd}\`) — the script's exit status must be the command's exit status`,
      );
      continue;
    }
    const expectedScript = posix.relative(projectDir, SCRIPT);
    const tokens = cmd.trim().split(/\s+/);
    if (tokens[0] !== "sh" || tokens[1] !== expectedScript) {
      violations.push(
        `${file}: ignoreCommand \`${cmd}\` does not start with \`sh ${expectedScript}\` (the command runs from ${projectDir})`,
      );
      continue;
    }
    const args = tokens.slice(2);
    const ownName = existsSync(join(root, projectDir, "package.json"))
      ? (JSON.parse(readFileSync(join(root, projectDir, "package.json"), "utf8")) as Manifest).name
      : undefined;

    if (args[0] === "--turbo-ignore") {
      if (args.length !== 2 || ownName == null || args[1] !== ownName) {
        violations.push(
          `${file}: \`--turbo-ignore\` must name exactly the project's own package (${ownName ?? "no package.json"}), got \`${args.slice(1).join(" ")}\``,
        );
        continue;
      }
      routed.push(`${projectDir} (turbo-ignore ${ownName})`);
      continue;
    }

    if (args.length === 0) {
      violations.push(`${file}: no watched paths passed to ${SCRIPT}`);
      continue;
    }
    const given = new Set(args.map(norm));
    for (const p of given) {
      if (p.startsWith("/") || p.startsWith("..") || !existsSync(resolve(root, p))) {
        violations.push(`${file}: watched path \`${p}\` does not exist relative to the repo root`);
      }
    }
    const required = new Set<string>(["pnpm-lock.yaml", "package.json", norm(projectDir)]);
    if (ownName != null) for (const d of closureDirs(ownName, ws)) required.add(d);
    const missing = [...required].filter((r) => !given.has(r)).sort();
    if (missing.length > 0) {
      violations.push(
        `${file}: watched paths miss ${missing.map((m) => `\`${m}\``).join(", ")} (the project dir, the root manifests, or a workspace package in ${ownName ?? projectDir}'s transitive workspace closure)`,
      );
      continue;
    }
    routed.push(`${projectDir} (${given.size} paths)`);
  }

  return { files, violations, routed, noIgnore, actionOwned, knownDoubleDeploy: knownSeen };
}

function main(): void {
  const ROOT = process.cwd();
  if (!existsSync(join(ROOT, SCRIPT))) {
    failWithRepair({
      invariant: `${SCRIPT} must exist — it is the one Ignored Build Step every Vercel project routes through`,
      canonical: SCRIPT,
      fix: `Restore ${SCRIPT} from git history (git log -- ${SCRIPT}).`,
    });
  }

  const { files, violations, routed, noIgnore, actionOwned, knownDoubleDeploy } =
    collectVercelViolations(ROOT);

  if (violations.length > 0) {
    failWithRepair({
      invariant: `every vercel.json ignoreCommand must route through ${SCRIPT} — a production build is never skipped, a preview is skipped only when proven safe over the right paths (#1012: proxy security fix 42ce27f was "Canceled by Ignored Build Step" on main)`,
      sites: violations,
      canonical: SCRIPT,
      fix: `Set the project's ignoreCommand to \`sh <relative path to ${SCRIPT}> <repo-root paths…>\` (include the project dir, pnpm-lock.yaml, package.json and every workspace dependency dir) or \`sh <relative path to ${SCRIPT}> --turbo-ignore <own package name>\`; never compose it with || / && / ;. A project whose production a \`vercel --prod\` Action deploys sets \`"git": {"deploymentEnabled": {"main": false}}\` (and only such a project). Then run \`pnpm check-vercel-ignore-build\`.`,
    });
  }

  console.log(
    `✓ Vercel ignore step: ${files.length} vercel.json file(s) found, ${routed.length} route their ignoreCommand through ${SCRIPT} [${routed.join("; ")}], ${noIgnore.length} declare none [${noIgnore.join(", ")}] (any dashboard-configured ignore step is not visible to this gate); production owned solely by a \`vercel --prod\` Action with Git deploys of main disabled: [${actionOwned.join("; ")}]; known double-deploy (Action + Git on main): [${knownDoubleDeploy.join(", ")}] (workflows matched to projects by their \`<dir>/**\` push path only).`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
