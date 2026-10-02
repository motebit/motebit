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
 * Every vercel.json is first validated against Vercel's own schema, vendored
 * at VERCEL_SCHEMA (scripts/vendor/vercel/README.md says where it comes from
 * and how to refresh it): every limit — the 256-char ignoreCommand, the
 * closed set of top-level keys — is read from that file, never hardcoded.
 * #1027: apps/web's inline path list made its ignoreCommand 1051 chars and
 * Vercel refused the config before building ("ignoreCommand should NOT be
 * longer than 256 characters") while every repo test and gate was green; the
 * same file feeds `vercel --prod`, so production would have broken too.
 *
 * Arguments are checked too, so a preview skip cannot be "proven" over the
 * wrong set:
 *   - `--watch <file>` (the file path relative to the project dir, as the
 *     command runs from there): the file is in the repo, lists one
 *     repo-root-relative path per line (`#` comments and blank lines aside;
 *     no whitespace, no duplicates, no absolute or `..` paths), every path
 *     exists, and the set EQUALS the project's BUILD INPUTS — no more, no
 *     less: its own directory, the directory of every
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
 * YAML, never grepped. The deploy step is a PINNED FORM, allowlisted rather
 * than pattern-matched (a cold review found ten shapes the pattern let
 * through — `continue-on-error`, `|| true`, an `exit 0` before the command,
 * a heredoc, `--target=preview`, `needs:` on a never-running job, an `if`
 * false on push to main, `paths-ignore`, a foreign `working-directory`, a
 * wrong or missing org id / token): its `run` is exactly `vercel --prod`
 * (optionally `--yes`), its keys and its job's keys come from an allowlist
 * (no continue-on-error, working-directory, shell or defaults), no `if` on
 * the step, its job or any job it `needs` is false on a push to main, and
 * VERCEL_TOKEN / VERCEL_ORG_ID / VERCEL_PROJECT_ID are the pinned secrets.
 * on.push holds only `branches` and `paths`, with no negated path. A workflow deploys a project's production when it runs
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
import Ajv, { type ErrorObject } from "ajv";
import Ajv2019 from "ajv/dist/2019.js";
import Ajv2020 from "ajv/dist/2020.js";
import { parse as parseYaml } from "yaml";
import { failWithRepair } from "./lib/gate-report.js";

const SCRIPT = "scripts/vercel-ignore-build.sh";
/** Vercel's published vercel.json schema, vendored (see scripts/vendor/vercel/README.md). */
export const VERCEL_SCHEMA = "scripts/vendor/vercel/vercel.schema.json";
const WORKSPACE_GLOB_DIRS = ["packages", "apps", "services"];
const SKIP_DIRS = new Set(["node_modules", ".git", ".next", ".turbo", "dist", "out", ".vercel"]);
const DEP_FIELDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];

export interface VercelSchema {
  $comment?: string;
  $schema?: string;
  properties?: Record<string, unknown>;
  additionalProperties?: unknown;
  [k: string]: unknown;
}

export function loadVercelSchema(root: string): VercelSchema {
  return JSON.parse(readFileSync(join(root, VERCEL_SCHEMA), "utf8")) as VercelSchema;
}

type Validate = ((data: unknown) => boolean) & { errors?: ErrorObject[] | null };

/** Compile with the Ajv class for the schema's own draft. */
export function compileVercelSchema(schema: VercelSchema): Validate {
  const draft = String(schema.$schema ?? "");
  const opts = { allErrors: true, strict: false } as const;
  const AjvClass = draft.includes("2020-12") ? Ajv2020 : draft.includes("2019-09") ? Ajv2019 : Ajv;
  if (/draft-0[34]/.test(draft)) {
    throw new Error(`${VERCEL_SCHEMA}: ${draft} is not supported by the gate's validator`);
  }
  return new AjvClass(opts).compile(schema) as Validate;
}

/**
 * What Vercel's schema refuses in one vercel.json: every validator error,
 * plus top-level keys the schema does not declare (closed even when a
 * refreshed schema leaves additionalProperties open — Vercel refuses unknown
 * keys at deploy time).
 */
export function schemaProblems(schema: VercelSchema, validate: Validate, cfg: unknown): string[] {
  const out: string[] = [];
  if (!validate(cfg)) {
    for (const e of validate.errors ?? []) {
      const extra =
        e.keyword === "additionalProperties"
          ? ` (\`${String((e.params as { additionalProperty?: unknown }).additionalProperty)}\`)`
          : "";
      out.push(`${e.instancePath === "" ? "/" : e.instancePath} ${e.message ?? e.keyword}${extra}`);
    }
  }
  if (schema.additionalProperties !== false && cfg != null && typeof cfg === "object") {
    const known = new Set(Object.keys(schema.properties ?? {}));
    for (const k of Object.keys(cfg)) {
      if (!known.has(k)) out.push(`/ unknown top-level key (\`${k}\`)`);
    }
  }
  return [...new Set(out)];
}

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

/**
 * Is this step a production-deploy CANDIDATE — does its `run` mention
 * `vercel` and `--prod` anywhere? Deliberately loose: a candidate is then held
 * to the pinned form (deployStepProblems), so a disguised deploy is refused
 * rather than ignored.
 */
export function runsVercelProd(run: string): boolean {
  return /\bvercel\b/.test(run) && /(^|\s)--prod(\s|$)/.test(run);
}

/** The deploy step's `run`, pinned: `vercel --prod` with optional `--yes`, nothing else. */
const PINNED_RUN_FLAGS = new Set(["--prod", "--yes"]);
export function isPinnedDeployRun(run: string): boolean {
  const line = run.trim();
  if (line.includes("\n")) return false;
  const toks = line.split(/ +/);
  if (toks[0] !== "vercel") return false;
  const flags = toks.slice(1);
  return (
    flags.includes("--prod") &&
    flags.every((f) => PINNED_RUN_FLAGS.has(f)) &&
    new Set(flags).size === flags.length
  );
}

/** Keys a deploy step / its job may carry. Everything else changes what runs or whether failure fails. */
const STEP_KEYS = new Set(["name", "id", "run", "env", "if", "timeout-minutes"]);
const JOB_KEYS = new Set([
  "name",
  "runs-on",
  "timeout-minutes",
  "if",
  "needs",
  "env",
  "steps",
  "permissions",
  "concurrency",
  "environment",
]);
/** on.push keys a deployer may use: no paths-ignore / branches-ignore / tags. */
const PUSH_KEYS = new Set(["branches", "paths"]);
/** Secrets every deploy step must use besides the project id. */
export const PINNED_DEPLOY_SECRETS: Record<string, string> = {
  VERCEL_TOKEN: "VERCEL_TOKEN",
  VERCEL_ORG_ID: "VERCEL_ORG_ID",
};

const stripExpr = (e: string) =>
  e
    .trim()
    .replace(/^\$\{\{([\s\S]*)\}\}$/, "$1")
    .trim();
const hasContextRef = (e: string) => /[A-Za-z_][\w-]*\s*[.(\[]/.test(e);
const unparen = (c: string) =>
  c
    .trim()
    .replace(/^\((.*)\)$/, "$1")
    .trim();

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
      .map(unparen)
      .some((c) => !hasContextRef(c) && c !== "true");
  }
  return !hasContextRef(e) && e !== "true";
}

/** One comparison conjunct, evaluated in the push-to-main context; undefined = unknown. */
function conjunctOnPushToMain(c: string): boolean | undefined {
  const facts: Record<string, string> = {
    "github.event_name": "push",
    "github.ref": "refs/heads/main",
    "github.ref_name": "main",
  };
  const m =
    /^([\w.]+)\s*(==|!=)\s*'([^']*)'$/.exec(c) ??
    (() => {
      const r = /^'([^']*)'\s*(==|!=)\s*([\w.]+)$/.exec(c);
      return r == null ? null : ([r[0], r[3], r[2], r[1]] as unknown as RegExpExecArray);
    })();
  if (m == null) return !hasContextRef(c) ? c === "true" : undefined;
  const fact = facts[m[1]!];
  if (fact == null) return undefined;
  return m[2] === "==" ? fact === m[3] : fact !== m[3];
}

/**
 * Is this `if:` false when the workflow runs on a push to main (statically
 * false included)? Evaluates `||` of `&&` chains of comparisons against
 * github.event_name / github.ref / github.ref_name; any other term is unknown
 * (treated as possibly true).
 */
export function ifFalseOnPushToMain(cond: unknown): boolean {
  if (ifStaticallyFalse(cond)) return true;
  if (typeof cond !== "string") return false;
  const e = unparen(stripExpr(cond));
  return e.split("||").every((d) =>
    unparen(d)
      .split("&&")
      .map(unparen)
      .some((c) => conjunctOnPushToMain(c) === false),
  );
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
  [k: string]: unknown;
}
interface Job {
  if?: unknown;
  needs?: unknown;
  env?: Record<string, unknown>;
  steps?: Step[];
  [k: string]: unknown;
}

const needsOf = (job: Job | undefined): string[] =>
  job?.needs == null ? [] : Array.isArray(job.needs) ? job.needs.map(String) : [String(job.needs)];

/** Why a job `needs` chain can keep the deploy job from running on a push to main. */
function needsProblems(jobs: Record<string, Job>, jobId: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>([jobId]);
  const stack = needsOf(jobs[jobId]);
  while (stack.length > 0) {
    const n = stack.pop()!;
    if (seen.has(n)) continue;
    seen.add(n);
    const j = jobs[n];
    if (j == null) {
      out.push(`job \`${jobId}\` needs \`${n}\`, which does not exist`);
      continue;
    }
    if (ifFalseOnPushToMain(j.if))
      out.push(`job \`${jobId}\` needs \`${n}\`, whose \`if\` is false on a push to main`);
    if (j["continue-on-error"] !== undefined)
      out.push(`job \`${jobId}\` needs \`${n}\`, which sets continue-on-error`);
    stack.push(...needsOf(j));
  }
  return out;
}

/** Everything wrong with one deploy-candidate step (empty = the pinned deploy). */
function deployStepProblems(
  wf: { env?: Record<string, unknown>; jobs?: Record<string, Job> },
  jobId: string,
  job: Job,
  step: Step,
  projectSecret: string | undefined,
  dir: string,
): string[] {
  const why: string[] = [];
  const at = `job \`${jobId}\``;
  if (!isPinnedDeployRun(String(step.run)))
    why.push(
      `${at} runs \`${String(step.run).trim().replace(/\n/g, "⏎")}\`, not the pinned form \`vercel --prod [--yes]\` (one command, nothing composed)`,
    );
  for (const k of Object.keys(step)) {
    if (!STEP_KEYS.has(k))
      why.push(`${at}: the deploy step sets \`${k}\` (allowed: ${[...STEP_KEYS].join(", ")})`);
  }
  for (const k of Object.keys(job)) {
    if (!JOB_KEYS.has(k)) why.push(`${at} sets \`${k}\` (allowed: ${[...JOB_KEYS].join(", ")})`);
  }
  if (ifStaticallyFalse(job.if) || ifStaticallyFalse(step.if))
    why.push(`${at} runs \`vercel --prod\` under a statically-false \`if\``);
  else if (ifFalseOnPushToMain(job.if) || ifFalseOnPushToMain(step.if))
    why.push(`${at} runs \`vercel --prod\` under an \`if\` that is false on a push to main`);
  why.push(...needsProblems(wf.jobs ?? {}, jobId));
  const envOf = (k: string) => step.env?.[k] ?? job.env?.[k] ?? wf.env?.[k];
  if (projectSecret == null) {
    why.push(`no project-id secret is declared for ${dir} in PROJECT_ID_SECRETS`);
  } else {
    const used = secretRef(envOf("VERCEL_PROJECT_ID"));
    if (used !== projectSecret)
      why.push(
        `${at} deploys VERCEL_PROJECT_ID=${used == null ? "<not a secrets.* ref>" : `secrets.${used}`}, not ${dir}'s secrets.${projectSecret}`,
      );
  }
  for (const [name, secret] of Object.entries(PINNED_DEPLOY_SECRETS)) {
    const used = secretRef(envOf(name));
    if (used !== secret)
      why.push(
        `${at} sets ${name}=${used == null ? "<missing or not a secrets.* ref>" : `secrets.${used}`}, not secrets.${secret}`,
      );
  }
  return why;
}

/**
 * Project dirs whose production a workflow deploys: on push to main with
 * `<dir>/**` in its paths and a step in the PINNED deploy form (see the header).
 * `rejected` names, per dir, why a workflow listing it is not its deployer;
 * `broken` holds the subset where the workflow does try to deploy (a
 * `vercel … --prod` candidate step exists) — those are violations outright.
 */
export function actionDeployedProjects(
  root: string,
  projectDirs: string[],
  secrets: Record<string, string> = PROJECT_ID_SECRETS,
): {
  deployers: Map<string, Deployer>;
  rejected: Map<string, string[]>;
  broken: Map<string, string[]>;
} {
  const deployers = new Map<string, Deployer>();
  const rejected = new Map<string, string[]>();
  const broken = new Map<string, string[]>();
  const reject = (dir: string, why: string) =>
    rejected.set(dir, [...(rejected.get(dir) ?? []), why]);
  const wfDir = join(root, ".github", "workflows");
  if (!existsSync(wfDir)) return { deployers, rejected, broken };
  for (const f of readdirSync(wfDir).sort()) {
    if (!/\.ya?ml$/.test(f)) continue;
    const text = readFileSync(join(wfDir, f), "utf8");
    if (!/\bvercel\b/.test(text)) continue;
    const name = `.github/workflows/${f}`;
    const wf = parseYaml(text) as {
      on?: Record<string, Record<string, unknown> | null>;
      env?: Record<string, unknown>;
      defaults?: unknown;
      jobs?: Record<string, Job>;
    };
    const on = wf?.on != null && typeof wf.on === "object" ? wf.on : {};
    const push = on["push"];
    const branches = Array.isArray(push?.["branches"])
      ? (push["branches"] as unknown[]).map(String)
      : [];
    if (!branches.includes("main")) continue;
    const paths = Array.isArray(push?.["paths"]) ? (push["paths"] as unknown[]).map(String) : [];
    const wfWhy: string[] = [];
    for (const k of Object.keys(push ?? {})) {
      if (!PUSH_KEYS.has(k)) wfWhy.push(`on.push sets \`${k}\` (allowed: branches, paths)`);
    }
    for (const g of paths)
      if (g.startsWith("!")) wfWhy.push(`on.push.paths has a negated pattern \`${g}\``);
    if (wf.defaults !== undefined)
      wfWhy.push(
        "the workflow sets `defaults` (a run shell or working-directory the deploy would inherit)",
      );
    for (const dir of projectDirs) {
      if (!paths.includes(`${dir}/**`)) continue;
      const why: string[] = [...wfWhy];
      let found: { mainOnly: boolean } | undefined;
      let candidates = 0;
      for (const [jobId, job] of Object.entries(wf.jobs ?? {})) {
        for (const step of job?.steps ?? []) {
          if (typeof step?.run !== "string" || !runsVercelProd(step.run)) continue;
          candidates++;
          const stepWhy = deployStepProblems(wf, jobId, job, step, secrets[dir], dir);
          if (stepWhy.length > 0) {
            why.push(...stepWhy);
            continue;
          }
          found = { mainOnly: ifRestrictsToMain(job.if) || ifRestrictsToMain(step.if) };
        }
      }
      if (candidates === 0) why.push("no step's `run` executes `vercel … --prod`");
      if (found == null || why.length > 0) {
        reject(dir, `${name}: ${why.join("; ")}`);
        if (candidates > 0)
          broken.set(dir, [
            ...(broken.get(dir) ?? []),
            `${name}: deploys ${dir}'s production outside the pinned form — ${why.join("; ")}`,
          ]);
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
  return { deployers, rejected, broken };
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
  const { deployers, rejected, broken } = actionDeployedProjects(root, files.map(dirname), secrets);
  const schema = loadVercelSchema(root);
  const validate = compileVercelSchema(schema);

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
    const refused = schemaProblems(schema, validate, cfg);
    if (refused.length > 0)
      violations.push(
        `${file}: fails Vercel's vercel.json schema (${VERCEL_SCHEMA}) — Vercel refuses this config before building, previews and \`vercel --prod\` alike: ${refused.join("; ")}`,
      );
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
    if (!(deployer == null && mainOff)) violations.push(...(broken.get(projectDir) ?? []));
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

    if (args[0] !== "--watch" || args.length !== 2) {
      violations.push(
        `${file}: ignoreCommand arguments must be exactly \`--watch <watch file>\` or \`--turbo-ignore <own package>\`, got \`${args.join(" ")}\` (watched paths live in a committed watch file, never inline — #1027)`,
      );
      continue;
    }
    const watchFile = posix.normalize(posix.join(projectDir, args[1]!));
    if (
      watchFile.startsWith("..") ||
      watchFile.startsWith("/") ||
      !existsSync(join(root, watchFile)) ||
      !statSync(join(root, watchFile)).isFile()
    ) {
      violations.push(
        `${file}: watch file \`${args[1]}\` (from ${projectDir}) is not a file in the repo`,
      );
      continue;
    }
    const lines = readFileSync(join(root, watchFile), "utf8").split("\n");
    const listed: string[] = [];
    const bad: string[] = [];
    for (const line of lines) {
      if (line === "" || line.startsWith("#")) continue;
      if (
        /\s/.test(line) ||
        line.startsWith("/") ||
        line.split("/").some((seg) => seg === ".." || seg === ".") ||
        norm(line) !== line
      ) {
        bad.push(JSON.stringify(line));
        continue;
      }
      listed.push(line);
    }
    if (bad.length > 0) {
      violations.push(
        `${watchFile}: malformed watch file line(s) ${bad.join(", ")} — one repo-root-relative path per line, no whitespace, no leading /, no . or .. segments, no trailing /`,
      );
      continue;
    }
    if (listed.length === 0) {
      violations.push(`${watchFile}: the watch file lists no paths`);
      continue;
    }
    const given = new Set(listed);
    const dups = listed.filter((p, i) => listed.indexOf(p) !== i);
    if (dups.length > 0)
      violations.push(
        `${watchFile}: ${[...new Set(dups)].map((d) => `\`${d}\``).join(", ")} listed more than once`,
      );
    for (const p of given) {
      if (!existsSync(resolve(root, p))) {
        violations.push(
          `${watchFile}: watched path \`${p}\` does not exist relative to the repo root`,
        );
      }
    }
    const required = new Set<string>(buildInputs);
    const missing = [...required].filter((r) => !given.has(r)).sort();
    const extra = [...given].filter((g) => !required.has(g)).sort();
    if (missing.length > 0) {
      violations.push(
        `${watchFile}: watched paths miss ${missing.map((m) => `\`${m}\``).join(", ")} (the project dir, a workspace package in ${ownName ?? projectDir}'s transitive workspace closure, or root build config its build reads)`,
      );
    }
    if (extra.length > 0) {
      violations.push(
        `${watchFile}: watches ${extra.map((m) => `\`${m}\``).join(", ")}, not a build input of ${ownName ?? projectDir} (the list is exactly the closure + root build config, nothing else)`,
      );
    }
    if (missing.length > 0 || extra.length > 0) continue;
    routed.push(`${projectDir} (${watchFile}: ${given.size} paths)`);
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
      fix: `Make every vercel.json valid under ${VERCEL_SCHEMA} (Vercel's own schema — e.g. ignoreCommand within its maxLength, no unknown keys). Set the project's ignoreCommand to \`sh <relative path to ${SCRIPT}> --watch <relative path to scripts/vercel-watch/<project>.txt>\` whose file lists, one per line, exactly the project dir, every workspace dependency dir and the root build config (package.json, pnpm-lock.yaml, pnpm-workspace.yaml, turbo.json and the tsconfig extends chain) — nothing else — or \`sh <relative path to ${SCRIPT}> --turbo-ignore <own package name>\`; never compose it with || / && / ;. A project whose production a \`vercel --prod\` Action deploys sets \`"git": {"deploymentEnabled": {"main": false}}\` (and only such a project, never \`deploymentEnabled: false\`); its workflow runs exactly \`vercel --prod [--yes]\` in a step with only allowlisted keys (no continue-on-error, working-directory, shell; no job/workflow defaults), no \`if\` or \`needs\` that is false on a push to main, VERCEL_TOKEN / VERCEL_ORG_ID from their pinned secrets and VERCEL_PROJECT_ID from the project's PROJECT_ID_SECRETS entry, on.push only branches + paths (no paths-ignore, no negated path), lists every build input in on.push.paths, and restricts any non-push trigger to refs/heads/main. Then run \`pnpm check-vercel-ignore-build\`.`,
    });
  }

  const schemaNote = String(loadVercelSchema(ROOT).$comment ?? "").startsWith("INTERIM")
    ? "an INTERIM hand-written subset — refresh it from https://openapi.vercel.sh/vercel.json per scripts/vendor/vercel/README.md"
    : "vendored from https://openapi.vercel.sh/vercel.json";
  console.log(
    `✓ Vercel ignore step: ${files.length} vercel.json file(s) found, all valid under ${VERCEL_SCHEMA} (${schemaNote}), ${routed.length} route their ignoreCommand through ${SCRIPT} [${routed.join("; ")}], ${noIgnore.length} declare none [${noIgnore.join(", ")}] (any dashboard-configured ignore step is not visible to this gate); production owned solely by a \`vercel --prod\` Action with Git deploys of main disabled: [${actionOwned.join("; ")}]; known double-deploy (Action + Git on main): [${knownDoubleDeploy.join(", ")}] (workflows matched to projects by their \`<dir>/**\` push path only).`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
