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
 *     the project's BUILD INPUTS: its own directory, the directory of every
 *     workspace package in its transitive `workspace:` dependency closure
 *     (dependencies, devDependencies, peerDependencies,
 *     optionalDependencies), and the root build config the build reads —
 *     ROOT_BUILD_FILES that exist (package.json, pnpm-lock.yaml,
 *     pnpm-workspace.yaml, turbo.json, .npmrc) plus every repo file in the
 *     relative tsconfig `extends` chain of any closure dir (tsconfig.base.json);
 *   - `--turbo-ignore <name>`: <name> is the project's own package name, and
 *     every root tsconfig the closure extends is in turbo.json
 *     globalDependencies (turbo-ignore sees only what turbo hashes).
 *
 * A vercel.json WITHOUT an ignoreCommand is not a violation (it always
 * builds from the repo's point of view) but is listed: its project's ignore
 * step may be configured in the Vercel dashboard, which this gate cannot see.
 *
 * Production ownership (one deployer per project), parsed from the workflow
 * YAML, never grepped. A workflow deploys a project's production when it runs
 * on push to `main` with `<project dir>/**` in its paths and has a job and
 * step (neither with a statically-false `if`) whose `run` executes
 * `vercel … --prod` (a comment or `echo` does not count) with
 * VERCEL_PROJECT_ID = `${{ secrets.<PROJECT_ID_SECRETS[dir]> }}` — the
 * mapping is declared once below. Such a deployer must list every build
 * input in its on.push.paths (or production misses root-config changes) and,
 * when any other trigger (workflow_dispatch) can start it, restrict the job
 * to `github.ref == 'refs/heads/main'`. Its project must disable Vercel's
 * Git-integration deploys of main (`"git": {"deploymentEnabled": {"main":
 * false}}`), or main deploys twice; conversely a vercel.json that disables
 * main must have such a deployer, or production never deploys. Only `main`
 * may be disabled — `"deploymentEnabled": false` kills previews too.
 * Pre-existing double deploys are named in KNOWN_DOUBLE_DEPLOY (a stale
 * entry is itself a violation).
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

/**
 * Root files every project's build reads regardless of its own directory:
 * the install (root manifest, lockfile, workspace list) and the task graph
 * (turbo.json). Required only when present in the repo.
 */
export const ROOT_BUILD_FILES = [
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "turbo.json",
  ".npmrc",
];

/**
 * The Vercel project-id secret each Action-deployed project's `vercel --prod`
 * step must use — declared once. A workflow that lists a project's dir but
 * deploys another project's id is not that project's deployer.
 */
export const PROJECT_ID_SECRETS: Record<string, string> = {
  "apps/web": "VERCEL_WEB_PROJECT_ID",
  "services/proxy": "VERCEL_PROJECT_ID",
};

/** JSON with comments and trailing commas (tsconfig). */
export function parseJsonc(text: string): unknown {
  let out = "";
  let i = 0;
  let inStr = false;
  while (i < text.length) {
    const c = text[i]!;
    if (inStr) {
      out += c;
      if (c === "\\") {
        out += text[i + 1] ?? "";
        i += 2;
        continue;
      }
      if (c === '"') inStr = false;
      i++;
    } else if (c === '"') {
      inStr = true;
      out += c;
      i++;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (c === "/" && text[i + 1] === "*") {
      const e = text.indexOf("*/", i + 2);
      i = e < 0 ? text.length : e + 2;
    } else {
      out += c;
      i++;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

/**
 * Repo files a dir's tsconfig.json pulls in through its relative `extends`
 * chain (package-name extends resolve into node_modules — the lockfile
 * covers those).
 */
export function tsconfigExtendsChain(root: string, dir: string): string[] {
  const out: string[] = [];
  const stack = [join(root, dir, "tsconfig.json")];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const file = stack.pop()!;
    if (seen.has(file) || !existsSync(file)) continue;
    seen.add(file);
    let cfg: { extends?: unknown };
    try {
      cfg = parseJsonc(readFileSync(file, "utf8")) as { extends?: unknown };
    } catch {
      continue;
    }
    const ext = cfg.extends;
    const list = Array.isArray(ext) ? ext : ext == null ? [] : [ext];
    for (const e of list.map(String)) {
      if (!e.startsWith(".")) continue;
      let target = resolve(dirname(file), e);
      if (!existsSync(target) && existsSync(`${target}.json`)) target = `${target}.json`;
      const rel = relative(root, target).split("\\").join("/");
      if (rel.startsWith("..")) continue;
      out.push(rel);
      stack.push(target);
    }
  }
  return out;
}

/**
 * Root build config a project's build reads beyond its workspace closure:
 * ROOT_BUILD_FILES that exist, plus every repo file reached through the
 * tsconfig `extends` chain of any dir in the closure that lies outside it.
 */
export function rootBuildConfig(root: string, closure: string[]): string[] {
  const out = new Set(ROOT_BUILD_FILES.filter((f) => existsSync(join(root, f))));
  const inside = (f: string) => closure.some((d) => f === d || f.startsWith(`${d}/`));
  for (const d of closure) {
    for (const f of tsconfigExtendsChain(root, d)) if (!inside(f)) out.add(f);
  }
  return [...out].sort();
}

/** Does a workflow `paths` filter list fire for a change to repo path `p`? */
export function pathsCover(paths: string[], p: string): boolean {
  return paths.some(
    (g) => g === p || g === `${p}/**` || (g.endsWith("/**") && p.startsWith(g.slice(0, -2))),
  );
}

/** Does a `run:` script execute `vercel … --prod` (not a comment, echo or string)? */
export function runsVercelProd(run: string): boolean {
  const lines = run.replace(/\\\r?\n/g, " ").split(/\r?\n|&&|;/);
  for (const raw of lines) {
    const line = raw.replace(/(^|\s)#.*$/, "").trim();
    let toks = line.split(/\s+/).filter((t) => t.length > 0);
    while (toks.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[0]!)) toks = toks.slice(1);
    if (toks[0] === "npx") toks = toks.slice(1).filter((t) => t !== "-y" && t !== "--yes");
    else if (toks[0] === "pnpm" && (toks[1] === "dlx" || toks[1] === "exec")) toks = toks.slice(2);
    if (toks.length === 0 || !/^vercel(@\S+)?$/.test(toks[0]!)) continue;
    if (toks.includes("--prod")) return true;
  }
  return false;
}

const stripExpr = (e: string) =>
  e
    .trim()
    .replace(/^\$\{\{([\s\S]*)\}\}$/, "$1")
    .trim();
const hasContextRef = (e: string) => /[A-Za-z_][\w-]*\s*[.(\[]/.test(e);

/**
 * Can this `if:` be statically false? A constant expression (no context
 * reference or function call) passes only as `true`; in an `&&` chain any
 * constant non-`true` conjunct makes the whole statically false.
 */
export function ifStaticallyFalse(cond: unknown): boolean {
  if (cond === undefined || cond === null) return false;
  if (typeof cond === "boolean") return !cond;
  if (typeof cond === "number") return cond === 0;
  const e = stripExpr(String(cond));
  if (!e.includes("||")) {
    return e
      .split("&&")
      .map((c) =>
        c
          .trim()
          .replace(/^\((.*)\)$/, "$1")
          .trim(),
      )
      .some((c) => !hasContextRef(c) && c !== "true");
  }
  return !hasContextRef(e) && e !== "true";
}

/** Is this `if:` restricted to refs/heads/main (an `&&` conjunct, no `||`)? */
export function ifRestrictsToMain(cond: unknown): boolean {
  if (typeof cond !== "string") return false;
  const e = stripExpr(cond);
  if (e.includes("||")) return false;
  return e
    .split("&&")
    .map((c) => c.trim())
    .some((c) => /^github\.ref\s*==\s*'refs\/heads\/main'$/.test(c));
}

const secretRef = (v: unknown): string | undefined => {
  const m =
    typeof v === "string" ? /^\$\{\{\s*secrets\.([A-Za-z0-9_]+)\s*\}\}$/.exec(v.trim()) : null;
  return m?.[1];
};

export interface Deployer {
  workflow: string;
  paths: string[];
  /** Triggers other than push that can start the deploy (e.g. workflow_dispatch). */
  otherTriggers: string[];
  mainOnly: boolean;
}

interface Step {
  run?: unknown;
  if?: unknown;
  env?: Record<string, unknown>;
}
interface Job {
  if?: unknown;
  env?: Record<string, unknown>;
  steps?: Step[];
}

/**
 * Project dirs whose production a workflow deploys: on push to main with
 * `<dir>/**` in its paths, a job (no statically-false `if`) with a step (no
 * statically-false `if`) whose `run` executes `vercel … --prod` with
 * VERCEL_PROJECT_ID = the project's PROJECT_ID_SECRETS secret. `rejected`
 * names, per dir, the workflows that list it but fail one of those.
 */
export function actionDeployedProjects(
  root: string,
  projectDirs: string[],
  secrets: Record<string, string> = PROJECT_ID_SECRETS,
): { deployers: Map<string, Deployer>; rejected: Map<string, string[]> } {
  const deployers = new Map<string, Deployer>();
  const rejected = new Map<string, string[]>();
  const reject = (dir: string, why: string) =>
    rejected.set(dir, [...(rejected.get(dir) ?? []), why]);
  const wfDir = join(root, ".github", "workflows");
  if (!existsSync(wfDir)) return { deployers, rejected };
  for (const f of readdirSync(wfDir).sort()) {
    if (!/\.ya?ml$/.test(f)) continue;
    const text = readFileSync(join(wfDir, f), "utf8");
    if (!/\bvercel\b/.test(text)) continue;
    const name = `.github/workflows/${f}`;
    const wf = parseYaml(text) as {
      on?: Record<string, { branches?: unknown; paths?: unknown } | null>;
      env?: Record<string, unknown>;
      jobs?: Record<string, Job>;
    };
    const on = wf?.on != null && typeof wf.on === "object" ? wf.on : {};
    const push = on["push"];
    const branches = Array.isArray(push?.branches) ? push.branches.map(String) : [];
    if (!branches.includes("main")) continue;
    const paths = Array.isArray(push?.paths) ? push.paths.map(String) : [];
    for (const dir of projectDirs) {
      if (!paths.includes(`${dir}/**`)) continue;
      const secret = secrets[dir];
      const why: string[] = [];
      let found: { mainOnly: boolean } | undefined;
      for (const [jobId, job] of Object.entries(wf.jobs ?? {})) {
        for (const step of job?.steps ?? []) {
          if (typeof step?.run !== "string" || !runsVercelProd(step.run)) continue;
          if (ifStaticallyFalse(job.if) || ifStaticallyFalse(step.if)) {
            why.push(`job \`${jobId}\` runs \`vercel --prod\` under a statically-false \`if\``);
            continue;
          }
          const used = secretRef(
            step.env?.["VERCEL_PROJECT_ID"] ??
              job.env?.["VERCEL_PROJECT_ID"] ??
              wf.env?.["VERCEL_PROJECT_ID"],
          );
          if (secret == null) {
            why.push(`no project-id secret is declared for ${dir} in PROJECT_ID_SECRETS`);
            continue;
          }
          if (used !== secret) {
            why.push(
              `job \`${jobId}\` deploys VERCEL_PROJECT_ID=${used == null ? "<not a secrets.* ref>" : `secrets.${used}`}, not ${dir}'s secrets.${secret}`,
            );
            continue;
          }
          found = { mainOnly: ifRestrictsToMain(job.if) || ifRestrictsToMain(step.if) };
        }
      }
      if (found == null) {
        if (why.length === 0) why.push("no step's `run` executes `vercel … --prod`");
        reject(dir, `${name}: ${why.join("; ")}`);
        continue;
      }
      deployers.set(dir, {
        workflow: name,
        paths,
        otherTriggers: Object.keys(on)
          .filter((k) => k !== "push")
          .sort(),
        mainOnly: found.mainOnly,
      });
    }
  }
  return { deployers, rejected };
}

/** `"git": {"deploymentEnabled": …}` — only `{ "main": false }` may be off. */
function gitDeployState(cfg: { git?: unknown }): { mainOff: boolean; problem?: string } {
  const g = cfg.git as { deploymentEnabled?: unknown } | undefined;
  const de = g?.deploymentEnabled;
  if (de === undefined || de === true) return { mainOff: false };
  if (de === false)
    return {
      mainOff: true,
      problem:
        '"git": {"deploymentEnabled": false} disables Git deploys of EVERY branch (previews included); disable only main: {"deploymentEnabled": {"main": false}}',
    };
  if (de != null && typeof de === "object") {
    const off = Object.entries(de as Record<string, unknown>)
      .filter(([k, v]) => v === false && k !== "main")
      .map(([k]) => k);
    const mainOff = (de as Record<string, unknown>)["main"] === false;
    if (off.length > 0)
      return {
        mainOff,
        problem: `"git.deploymentEnabled" disables ${off.map((k) => `\`${k}\``).join(", ")} — only main may be disabled (previews must keep deploying)`,
      };
    return { mainOff };
  }
  return { mainOff: false, problem: '"git.deploymentEnabled" is neither a boolean nor an object' };
}

export interface VercelGateResult {
  files: string[];
  violations: string[];
  routed: string[];
  noIgnore: string[];
  actionOwned: string[];
  knownDoubleDeploy: string[];
}

function readTurboGlobalDeps(root: string): string[] {
  const p = join(root, "turbo.json");
  if (!existsSync(p)) return [];
  const g = (parseJsonc(readFileSync(p, "utf8")) as { globalDependencies?: unknown })
    .globalDependencies;
  return Array.isArray(g) ? g.map(String) : [];
}

export function collectVercelViolations(
  root: string,
  knownDoubleDeploy: Record<string, string> = KNOWN_DOUBLE_DEPLOY,
  secrets: Record<string, string> = PROJECT_ID_SECRETS,
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
  const { deployers, rejected } = actionDeployedProjects(root, files.map(dirname), secrets);

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
    const ownName = existsSync(join(root, projectDir, "package.json"))
      ? (JSON.parse(readFileSync(join(root, projectDir, "package.json"), "utf8")) as Manifest).name
      : undefined;
    const closure = ownName != null ? closureDirs(ownName, ws) : [];
    if (!closure.includes(norm(projectDir))) closure.push(norm(projectDir));
    const rootConfig = rootBuildConfig(root, closure);
    /** What the project's build reads: its workspace closure plus the root build config. */
    const buildInputs = [...new Set([...closure, ...rootConfig])].sort();

    const deployer = deployers.get(projectDir);
    const git = gitDeployState(cfg);
    const mainOff = git.mainOff;
    if (git.problem != null) violations.push(`${file}: ${git.problem}`);
    if (deployer != null && !mainOff) {
      if (knownDoubleDeploy[projectDir] != null) knownSeen.push(projectDir);
      else
        violations.push(
          `${file}: production is deployed by ${deployer.workflow} (\`vercel --prod\`) but Git deploys of main are not disabled — main deploys twice; set "git": {"deploymentEnabled": {"main": false}}`,
        );
    } else if (deployer == null && mainOff) {
      const why = rejected.get(projectDir);
      violations.push(
        `${file}: disables Git deploys of main but no workflow deploys it — production would never deploy (a deployer runs \`vercel … --prod\` on push to main with \`${projectDir}/**\` in its paths, in a job/step with no statically-false \`if\`, using VERCEL_PROJECT_ID=secrets.${secrets[projectDir] ?? "<declare in PROJECT_ID_SECRETS>"})${why != null ? `; rejected: ${why.join(" | ")}` : ""}`,
      );
    } else if (deployer != null) {
      actionOwned.push(`${projectDir} (${deployer.workflow})`);
    }
    if (deployer != null) {
      const uncovered = buildInputs.filter((p) => !pathsCover(deployer.paths, p));
      if (uncovered.length > 0)
        violations.push(
          `${deployer.workflow}: deploys ${projectDir} but its on.push.paths miss ${uncovered.map((m) => `\`${m}\``).join(", ")} — a change there would never redeploy production`,
        );
      if (deployer.otherTriggers.length > 0 && !deployer.mainOnly)
        violations.push(
          `${deployer.workflow}: runs \`vercel --prod\` for ${projectDir} on ${deployer.otherTriggers.join(", ")} without restricting the deploy job to main — add \`if: github.ref == 'refs/heads/main'\``,
        );
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

    if (args[0] === "--turbo-ignore") {
      if (args.length !== 2 || ownName == null || args[1] !== ownName) {
        violations.push(
          `${file}: \`--turbo-ignore\` must name exactly the project's own package (${ownName ?? "no package.json"}), got \`${args.slice(1).join(" ")}\``,
        );
        continue;
      }
      const globalDeps = readTurboGlobalDeps(root);
      const notGlobal = rootConfig.filter(
        (f) => !ROOT_BUILD_FILES.includes(f) && !globalDeps.includes(f),
      );
      if (notGlobal.length > 0) {
        violations.push(
          `${file}: \`--turbo-ignore\` cannot see ${notGlobal.map((m) => `\`${m}\``).join(", ")} (root build config outside every workspace) — list it in turbo.json globalDependencies`,
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
    const required = new Set<string>(buildInputs);
    const missing = [...required].filter((r) => !given.has(r)).sort();
    if (missing.length > 0) {
      violations.push(
        `${file}: watched paths miss ${missing.map((m) => `\`${m}\``).join(", ")} (the project dir, a workspace package in ${ownName ?? projectDir}'s transitive workspace closure, or root build config its build reads)`,
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
      fix: `Set the project's ignoreCommand to \`sh <relative path to ${SCRIPT}> <repo-root paths…>\` (include the project dir, every workspace dependency dir and the root build config: package.json, pnpm-lock.yaml, pnpm-workspace.yaml, turbo.json and the tsconfig extends chain) or \`sh <relative path to ${SCRIPT}> --turbo-ignore <own package name>\`; never compose it with || / && / ;. A project whose production a \`vercel --prod\` Action deploys sets \`"git": {"deploymentEnabled": {"main": false}}\` (and only such a project, never \`deploymentEnabled: false\`); its workflow runs \`vercel --prod\` in a real step with VERCEL_PROJECT_ID from the project's PROJECT_ID_SECRETS entry, lists every build input in on.push.paths, and restricts any non-push trigger to refs/heads/main. Then run \`pnpm check-vercel-ignore-build\`.`,
    });
  }

  console.log(
    `✓ Vercel ignore step: ${files.length} vercel.json file(s) found, ${routed.length} route their ignoreCommand through ${SCRIPT} [${routed.join("; ")}], ${noIgnore.length} declare none [${noIgnore.join(", ")}] (any dashboard-configured ignore step is not visible to this gate); production owned solely by a \`vercel --prod\` Action with Git deploys of main disabled: [${actionOwned.join("; ")}]; known double-deploy (Action + Git on main): [${knownDoubleDeploy.join(", ")}] (workflows matched to projects by their \`<dir>/**\` push path only).`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
