/**
 * differential-tree — assemble the BASE tree `scripts/differential-vs-main.ts`
 * runs a probe in: the base ref's files, with a chosen set of workspace
 * packages taken from the base ref and every other workspace package taken
 * from this checkout, wired so that every import the probe can reach resolves
 * to exactly that mix — or refuse, loudly, when it cannot say that truthfully.
 *
 * History (#818; the #833 and #835 reviews each withdrew a fix):
 *
 *   1. The original archived ONE package. A package whose `tsconfig.json`
 *      lists `references` failed to transform any test on the base side
 *      (vite's oxc transform follows every reference, and the siblings were
 *      not in the temp tree), and its `node_modules` was a link to the working
 *      tree's, so no other package could come from the base ref.
 *   2. #833: working-tree packages between the probe and a from-main package
 *      were copied WITH their `dist`, and a bundle (render-engine's
 *      `browser.iife.js`, crypto's tsup, create-motebit, the CLI) had already
 *      inlined the working tree's version of the from-main package ⇒ false
 *      SAME. Rule: a working-tree `dist` never enters the base tree; every
 *      working-tree package that can reach a from-main package is copied as
 *      SOURCE and rebuilt there.
 *   3. #833: "can reach" ignored the root package.json's workspace deps
 *      (runtime, semiring, verifier, wallet-solana), which node resolves from
 *      ANY package ⇒ false SAME. Rule: they are implicit edges of every package.
 *   4. #835: (a) paths outside the workspace packages (tsconfig.base.json,
 *      root package.json, pnpm-lock.yaml, patches/, root configs) were taken
 *      from the base ref, but every LINKED package had been built by the
 *      working tree against the working tree's copies, so a change there read
 *      SAME while the aperture claimed those paths came from main. Rule: when
 *      any such path differs, REFUSE (or, with an explicit flag, hold the
 *      working tree's copy on BOTH sides and say that those paths are not
 *      differentialled). (b) the staleness check read only `src/`, so a
 *      changed build input elsewhere (`scripts/build-browser.mjs`, tsup
 *      config, package.json) read SAME. Rule: every tracked non-test file of
 *      the package except `dist`. (c) its repair line could not clear it:
 *      `tsc -b` skips an up-to-date dependent without touching its
 *      tsbuildinfo, so "older than a dependency's tsbuildinfo" never cleared.
 *      Rule: compare against the dependency's EMITTED output, which is what
 *      the dependent consumes, and repair the stale packages together with
 *      their dependents. (d) its fixture test ran `git init`/`config`/
 *      `commit` with the caller's GIT_DIR in the environment and, from a
 *      pre-push hook in a linked worktree, rewrote the real repository. Rule:
 *      every child process gets an environment with EVERY `GIT_*` variable
 *      removed and an explicit `cwd`, and this module runs only read-only git
 *      subcommands (an allowlist, enforced).
 *
 * Each workspace package in the base tree is one of:
 *
 *   - from-main: the base ref's source, with a `node_modules` that MIRRORS
 *     the working tree's (same relative link targets, so `@motebit/*` links
 *     land on the base tree's copy of that package; third-party deps land in
 *     the working tree's `.pnpm` store). Rebuilt inside the base tree when the
 *     probe can reach it.
 *   - head source, rebuilt: a working-tree package that can reach a from-main
 *     package. Its tracked + untracked-not-ignored files are copied (never
 *     `dist`, `*.tsbuildinfo` or ignored/generated files) and it is rebuilt
 *     inside the base tree when the probe can reach it; when the probe cannot,
 *     it stays unbuilt, so loading it fails loudly instead of quietly.
 *   - linked: a working-tree package that cannot reach any from-main package.
 *     A symlink is exact: nothing it loads differs between the two trees.
 *   - base-only: exists only on the base ref and was not requested. Left as
 *     the base ref's source, unbuilt.
 *
 * Node resolves a module from its REAL path, which is why a package that can
 * reach a from-main package must live inside the base tree.
 *
 * Residual, stated: third-party packages live in the working tree's `.pnpm`
 * store on both sides, so a third-party package that itself imports an
 * `@motebit/*` package would resolve it to the working tree.
 */
import { execFileSync, spawn } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { cpus } from "node:os";
import { dirname, join } from "node:path";

// ── Environment and git: scrubbed, explicit, read-only ────────────────

/**
 * `base` with EVERY `GIT_*` variable removed, then `extra` applied. A git
 * hook exports GIT_DIR / GIT_INDEX_FILE / GIT_WORK_TREE (and, in a linked
 * worktree, a GIT_DIR that points into the shared repository); any child that
 * inherits them — git itself, or a build script that runs git — acts on THAT
 * repository whatever its `cwd`. Every child process this module or the
 * script starts gets this environment.
 */
export function cleanEnv(
  base: NodeJS.ProcessEnv = process.env,
  extra: Record<string, string> = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) if (!k.startsWith("GIT_")) env[k] = v;
  return { ...env, ...extra };
}

/** The only git subcommands this module and the script may run. None writes to a repository. */
export const READ_ONLY_GIT = new Set(["rev-parse", "archive", "ls-files"]);

/** Run a READ-ONLY git subcommand in `cwd` with a scrubbed environment. */
export function readGit(cwd: string, args: string[]): string {
  if (!READ_ONLY_GIT.has(args[0] ?? "")) {
    throw new Error(
      `differential-tree: refusing to run \`git ${args[0]}\` — only ${[...READ_ONLY_GIT].join(", ")} are allowed here.`,
    );
  }
  return execFileSync("git", args, {
    cwd,
    env: cleanEnv(),
    encoding: "utf-8",
    maxBuffer: 256 * 1024 * 1024,
  });
}

/** A run refused before comparing; its lines carry the reason and the repair. */
export class DifferentialRefusal extends Error {
  constructor(readonly lines: string[]) {
    super(lines.join("\n"));
  }
}

// ── Workspace model ──────────────────────────────────────────────────

export interface WorkspacePackage {
  /** Repo-relative directory, e.g. `packages/surface-kit`. */
  dir: string;
  name: string;
  /** Every workspace dependency name (dependencies, dev, peer, optional). */
  deps: string[];
  scripts: Record<string, string>;
}

/** The workspace globs (`packages/*` etc.) from pnpm-workspace.yaml. */
export function workspaceRoots(treeDir: string): string[] {
  const yaml = readFileSync(join(treeDir, "pnpm-workspace.yaml"), "utf-8");
  const roots: string[] = [];
  for (const m of yaml.matchAll(/^\s*-\s*["']?([^"'\s]+)\/\*["']?\s*$/gm)) roots.push(m[1]!);
  return roots;
}

function workspaceDepsOf(manifest: Record<string, unknown>): string[] {
  const deps = new Set<string>();
  for (const key of [
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
  ]) {
    const block = manifest[key] as Record<string, string> | undefined;
    for (const [k, v] of Object.entries(block ?? {})) if (v.startsWith("workspace:")) deps.add(k);
  }
  return [...deps].sort();
}

export function readPackage(treeDir: string, dir: string): WorkspacePackage | null {
  const file = join(treeDir, dir, "package.json");
  if (!existsSync(file)) return null;
  const m = JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>;
  return {
    dir,
    name: (m.name as string | undefined) ?? dir,
    deps: workspaceDepsOf(m),
    scripts: (m.scripts as Record<string, string> | undefined) ?? {},
  };
}

/**
 * The root package.json's workspace deps: linked into the ROOT node_modules,
 * so any workspace package can resolve them by walking up — declared or not.
 */
export function rootWorkspaceDeps(treeDir: string): string[] {
  const file = join(treeDir, "package.json");
  if (!existsSync(file)) return [];
  return workspaceDepsOf(JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>);
}

/** Every workspace package directory present in `treeDir`. */
export function listWorkspaceDirs(treeDir: string, roots: string[]): string[] {
  const out: string[] = [];
  for (const r of roots) {
    const abs = join(treeDir, r);
    if (!existsSync(abs)) continue;
    for (const e of readdirSync(abs, { withFileTypes: true })) {
      if (!e.isDirectory() && !e.isSymbolicLink()) continue;
      const dir = `${r}/${e.name}`;
      if (existsSync(join(treeDir, dir, "package.json"))) out.push(dir);
    }
  }
  return out.sort();
}

export function workspaceGraph(treeDir: string, roots: string[]): Map<string, WorkspacePackage> {
  const byDir = new Map<string, WorkspacePackage>();
  for (const d of listWorkspaceDirs(treeDir, roots)) {
    const p = readPackage(treeDir, d);
    if (p != null) byDir.set(d, p);
  }
  return byDir;
}

/** The workspace package a repo-relative path belongs to, or null. */
export function packageDirOf(path: string, roots: string[]): string | null {
  const parts = path.split("/");
  if (parts.length < 2 || !roots.includes(parts[0]!)) return null;
  return `${parts[0]}/${parts[1]}`;
}

/** The working tree's files: tracked + untracked-not-ignored, present on disk. */
export function headFiles(root: string): string[] {
  return readGit(root, ["ls-files", "-co", "--exclude-standard", "-z"])
    .split("\0")
    .filter((f) => f !== "" && existsSync(join(root, f)));
}

/**
 * Workspace packages reachable from `from` (including `from`). Each package
 * reaches its declared workspace deps AND `implicit` (the root package.json's
 * workspace deps, resolvable from anywhere through the root node_modules).
 */
export function dependencyClosure(
  from: string,
  byDir: Map<string, WorkspacePackage>,
  implicit: string[] = [],
): Set<string> {
  const byName = new Map([...byDir.values()].map((p) => [p.name, p.dir]));
  const seen = new Set<string>();
  const stack = [from];
  while (stack.length > 0) {
    const d = stack.pop()!;
    if (seen.has(d)) continue;
    seen.add(d);
    for (const dep of [...(byDir.get(d)?.deps ?? []), ...implicit]) {
      const dd = byName.get(dep);
      if (dd != null && !seen.has(dd)) stack.push(dd);
    }
  }
  return seen;
}

/** `dirs` ordered so every package follows the DECLARED workspace deps it has inside `dirs`. */
export function topoOrder(dirs: string[], byDir: Map<string, WorkspacePackage>): string[] {
  const byName = new Map([...byDir.values()].map((p) => [p.name, p.dir]));
  const want = new Set(dirs);
  const out: string[] = [];
  const state = new Map<string, "visiting" | "done">();
  const visit = (d: string) => {
    if (state.has(d)) return;
    state.set(d, "visiting");
    for (const dep of byDir.get(d)?.deps ?? []) {
      const dd = byName.get(dep);
      if (dd != null && want.has(dd)) visit(dd);
    }
    state.set(d, "done");
    out.push(d);
  };
  for (const d of [...dirs].sort()) visit(d);
  return out;
}

// ── Comparing the two trees ──────────────────────────────────────────

function walkFiles(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const e of readdirSync(join(dir, prefix), { withFileTypes: true })) {
    const rel = prefix === "" ? e.name : `${prefix}/${e.name}`;
    if (e.isDirectory()) out.push(...walkFiles(dir, rel));
    else out.push(rel);
  }
  return out;
}

function sameFile(a: string, b: string): boolean {
  const sa = lstatSync(a);
  const sb = lstatSync(b);
  if (sa.isSymbolicLink() || sb.isSymbolicLink()) {
    return sa.isSymbolicLink() && sb.isSymbolicLink() && readlinkSync(a) === readlinkSync(b);
  }
  if (sa.size !== sb.size || ((sa.mode & 0o111) !== 0) !== ((sb.mode & 0o111) !== 0)) return false;
  return readFileSync(a).equals(readFileSync(b));
}

export interface TreeDifference {
  /** Workspace packages with any differing file (either direction). */
  packages: string[];
  /** Differing paths outside every workspace package. */
  rootPaths: string[];
}

/**
 * Every path whose content differs between the freshly extracted base tree
 * and the working tree (tracked + untracked-not-ignored), by bytes, link
 * target and executable bit. Content, not `git diff`, so the comparison is
 * the same whichever repository the base came from.
 */
export function compareTrees(root: string, baseTree: string, roots: string[]): TreeDifference {
  const head = new Set(headFiles(root));
  const base = new Set(walkFiles(baseTree));
  const differing: string[] = [];
  for (const f of new Set([...head, ...base])) {
    if (!head.has(f) || !base.has(f) || !sameFile(join(root, f), join(baseTree, f))) {
      differing.push(f);
    }
  }
  const packages = new Set<string>();
  const rootPaths: string[] = [];
  for (const f of differing) {
    const d = packageDirOf(f, roots);
    if (d != null) packages.add(d);
    else rootPaths.push(f);
  }
  return { packages: [...packages].sort(), rootPaths: rootPaths.sort() };
}

// ── node_modules ─────────────────────────────────────────────────────

/** `node_modules` entries that are caches: never mirrored (they would write into the working tree). */
const MIRRORED_DOT_ENTRIES = new Set([".bin", ".pnpm"]);

/**
 * Recreate `src` (a pnpm `node_modules`) at `dst` so resolution from `dst`'s
 * position lands where the aperture says it should: symlinks are recreated
 * with the SAME target text (relative targets now resolve inside the base
 * tree — `@motebit/sdk -> ../../../sdk` reaches the base tree's sdk), scope
 * directories are recursed, `.bin` and `.pnpm` are linked absolutely to the
 * working tree's, and every other dot-entry (`.vite`, `.vite-temp`,
 * `.modules.yaml`, caches) is skipped.
 */
export function mirrorNodeModules(src: string, dst: string): void {
  mkdirSync(dst, { recursive: true });
  for (const e of readdirSync(src, { withFileTypes: true })) {
    if (e.name.startsWith(".") && !MIRRORED_DOT_ENTRIES.has(e.name)) continue;
    const s = join(src, e.name);
    const d = join(dst, e.name);
    if (e.isSymbolicLink()) symlinkSync(readlinkSync(s), d);
    else if (e.isDirectory() && e.name.startsWith("@")) mirrorNodeModules(s, d);
    else symlinkSync(s, d);
  }
}

// ── Builds ───────────────────────────────────────────────────────────

/**
 * A script as it runs in the base tree. `tsc -b` becomes `tsc -p
 * tsconfig.json`: build mode walks `references` and would REBUILD a stale
 * referenced package through its symlink — i.e. write into the working tree.
 * `-p` reads the referenced packages' existing declarations and emits only
 * this package. Every other step (tsup, esbuild bundles, `pnpm run
 * build:browser`) runs as written, inside the base tree, so whatever it
 * bundles is resolved from the base tree.
 */
export function baseScript(script: string): string {
  return script.replace(/\btsc -b(?=\s*(?:&&|;|$))/g, "tsc -p tsconfig.json");
}

/** The build command for a package, or null when it has no real build. */
export function baseBuildCommand(script: string | undefined): string | null {
  if (script == null || /^\s*echo\b/.test(script)) return null;
  return baseScript(script);
}

/** Rewrite every script of a base-tree package.json through `baseScript` (so nested `pnpm run` steps obey it too). */
function rewriteScripts(pkgDir: string): void {
  const file = join(pkgDir, "package.json");
  const m = JSON.parse(readFileSync(file, "utf-8")) as { scripts?: Record<string, string> };
  if (m.scripts == null) return;
  for (const [k, v] of Object.entries(m.scripts)) m.scripts[k] = baseScript(v);
  writeFileSync(file, `${JSON.stringify(m, null, 2)}\n`);
}

function newestMtime(dir: string): number {
  if (!existsSync(dir)) return -1;
  let newest = -1;
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) newest = Math.max(newest, statSync(p).mtimeMs);
    }
  };
  walk(dir);
  return newest;
}

/** What a dependent consumes: the newest file the package EMITTED into `dist` (-1 if none). */
export function emittedTime(pkgDir: string): number {
  return newestMtime(join(pkgDir, "dist"));
}

/**
 * When the package's own build last ran: its newest `dist` file or
 * package-root `*.tsbuildinfo` (`tsc -b` refreshes the tsbuildinfo when it
 * re-checks changed inputs without re-emitting). -1 if never.
 */
export function buildTime(pkgDir: string): number {
  let t = emittedTime(pkgDir);
  if (existsSync(pkgDir)) {
    for (const f of readdirSync(pkgDir)) {
      if (f.endsWith(".tsbuildinfo")) t = Math.max(t, statSync(join(pkgDir, f)).mtimeMs);
    }
  }
  return t;
}

/** A build input: every tracked or untracked-not-ignored file of the package except `dist/` and tests. */
export function isBuildInput(pathInPackage: string): boolean {
  if (pathInPackage.startsWith("dist/")) return false;
  const parts = pathInPackage.split("/");
  if (parts.includes("__tests__")) return false;
  return !/\.(test|spec|probe)\.[cm]?[jt]sx?$/.test(parts[parts.length - 1] ?? "");
}

/**
 * Working-tree packages among `dirs` whose build is stale: a buildable
 * package that was never built, or was last built before one of its build
 * inputs changed (any tracked non-test file outside `dist` — source, build
 * scripts, tsconfig, tsup config, package.json), or before a workspace
 * package it declares last EMITTED output (a bundling build inlines its
 * dependencies, so re-emitted dependency output makes it stale even when its
 * own inputs did not move). Both sides of a differential read these builds,
 * so a stale one makes a real change read as SAME.
 */
export function staleBuilds(
  root: string,
  dirs: Iterable<string>,
  byDir: Map<string, WorkspacePackage>,
  files: string[],
): string[] {
  const byName = new Map([...byDir.values()].map((p) => [p.name, p.dir]));
  const inputsOf = new Map<string, number>();
  for (const f of files) {
    const parts = f.split("/");
    if (parts.length < 3) continue;
    const d = `${parts[0]}/${parts[1]}`;
    if (!byDir.has(d) || !isBuildInput(parts.slice(2).join("/"))) continue;
    inputsOf.set(d, Math.max(inputsOf.get(d) ?? -1, lstatSync(join(root, f)).mtimeMs));
  }
  const stale: string[] = [];
  for (const d of dirs) {
    const pkg = byDir.get(d);
    if (baseBuildCommand(pkg?.scripts.build) == null) continue;
    const built = buildTime(join(root, d));
    const depEmitted = Math.max(
      -1,
      ...(pkg?.deps ?? [])
        .map((n) => byName.get(n))
        .filter((x): x is string => x != null && x !== d)
        .map((x) => emittedTime(join(root, x))),
    );
    if (built < 0 || built < (inputsOf.get(d) ?? -1) || built < depEmitted) stale.push(d);
  }
  return stale.sort();
}

/**
 * The command that clears a staleness refusal: the stale packages AND every
 * package in `reach` that depends on one of them (its build consumes theirs),
 * built by pnpm in dependency order.
 */
export function repairCommand(
  stale: string[],
  reach: Iterable<string>,
  byDir: Map<string, WorkspacePackage>,
): string {
  const set = new Set(stale);
  for (const d of reach) {
    if (baseBuildCommand(byDir.get(d)?.scripts.build) == null) continue;
    const closure = dependencyClosure(d, byDir);
    if ([...closure].some((x) => x !== d && stale.includes(x))) set.add(d);
  }
  return `pnpm ${[...set]
    .sort()
    .map((d) => `--filter ./${d}`)
    .join(" ")} run build`;
}

/** The PATH entries a package's scripts expect: its own and the root `.bin`. */
export function binPath(treeDir: string, dir: string): string[] {
  return [join(treeDir, dir, "node_modules", ".bin"), join(treeDir, "node_modules", ".bin")];
}

function explain(what: string, cmd: string, cwd: string, out: string, err?: unknown): Error {
  const tail = out.split("\n").filter(Boolean).slice(-30).join("\n");
  return new Error(
    `${what} failed (\`${cmd}\` in ${cwd}):\n${tail}\n` +
      "Fix: the command must succeed on the base ref; the working tree's builds it reads must be current.",
    { cause: err },
  );
}

function runAsync(cmd: string, cwd: string, extraPath: string[], what: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("sh", ["-c", cmd], {
      cwd,
      env: cleanEnv(process.env, {
        PATH: [...extraPath, process.env.PATH ?? ""].join(":"),
      }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (b: Buffer) => (out += b.toString()));
    child.stderr.on("data", (b: Buffer) => (out += b.toString()));
    child.on("error", (err) => reject(explain(what, cmd, cwd, out, err)));
    child.on("close", (code) =>
      code === 0 ? resolvePromise() : reject(explain(what, cmd, cwd, `${out}\n(exit ${code})`)),
    );
  });
}

/** Run a package's `pretest` script if it has one (generated test inputs). */
export async function runPretest(treeDir: string, pkg: WorkspacePackage | null): Promise<void> {
  const cmd = pkg?.scripts.pretest;
  if (cmd == null) return;
  await runAsync(
    cmd,
    join(treeDir, pkg!.dir),
    binPath(treeDir, pkg!.dir),
    `pretest for ${pkg!.dir}`,
  );
}

/** Build `order` (dependencies first) with bounded parallelism along declared deps. */
async function buildAll(
  order: string[],
  byDir: Map<string, WorkspacePackage>,
  treeDir: string,
  label: (d: string) => string,
  log: (line: string) => void,
): Promise<void> {
  const byName = new Map([...byDir.values()].map((p) => [p.name, p.dir]));
  const inSet = new Set(order);
  const waitsOn = (d: string) =>
    (byDir.get(d)?.deps ?? [])
      .map((n) => byName.get(n))
      .filter((x): x is string => x != null && x !== d && inSet.has(x));
  const limit = Math.max(2, Math.floor(cpus().length / 2));
  const done = new Set<string>();
  const running = new Map<string, Promise<void>>();
  while (done.size < order.length) {
    for (const d of order) {
      if (running.size >= limit) break;
      if (done.has(d) || running.has(d) || !waitsOn(d).every((x) => done.has(x))) continue;
      const cmd = baseBuildCommand(byDir.get(d)?.scripts.build)!;
      log(`  building ${d} (${label(d)}): ${cmd}`);
      running.set(
        d,
        runAsync(cmd, join(treeDir, d), binPath(treeDir, d), `base-tree build of ${d}`).then(() => {
          done.add(d);
          running.delete(d);
        }),
      );
    }
    if (running.size === 0)
      throw new Error(`differential-tree: dependency cycle among ${order.join(", ")}`);
    await Promise.race(running.values());
  }
}

// ── The base tree ────────────────────────────────────────────────────

export interface Aperture {
  /** Workspace packages taken from the base ref (present on it). */
  fromMain: string[];
  /** Requested from the base ref but absent there (new on this branch). */
  absentOnBase: string[];
  /** From-main packages rebuilt from base sources, in build order. */
  rebuiltFromMain: string[];
  /** Working-tree packages rebuilt FROM SOURCE inside the base tree (they reach a from-main package). */
  rebuiltFromHead: string[];
  /** Working-tree sources copied because they reach a from-main package, left unbuilt (the probe cannot reach them). */
  copiedUnbuilt: string[];
  /** Working-tree packages linked in unchanged (they cannot reach any from-main package). */
  linkedFromHead: number;
  /** On the base ref only, not requested: the base ref's source, unbuilt. */
  baseOnly: string[];
  /** Workspace deps of the root package.json, reachable from every package. */
  rootWorkspaceDeps: string[];
  /**
   * Paths outside the workspace packages that differ from the base ref and
   * were held at the WORKING TREE's copy on both sides (`rootFromHead`): not
   * differentialled. Empty unless the caller opted in; otherwise the run
   * refuses.
   */
  rootHeldAtHead: string[];
}

export interface BuildBaseTreeOptions {
  root: string;
  /** Repository the base ref is read from (default `root`). */
  baseRepo?: string;
  base: string;
  /** Directory the base tree is created in (must be empty or absent). */
  treeDir: string;
  /** Workspace package the probe runs in; always from the base ref. */
  host: string;
  /** Workspace packages from the base ref, or `diff`: every package whose files differ. */
  fromMain: string[] | "diff";
  /** Hold differing paths outside the workspace packages at the working tree's copy instead of refusing. */
  rootFromHead?: boolean;
  log?: (line: string) => void;
}

export async function buildBaseTree(opts: BuildBaseTreeOptions): Promise<Aperture> {
  const { root, base, treeDir, host } = opts;
  const baseRepo = opts.baseRepo ?? root;
  const log = opts.log ?? (() => {});
  mkdirSync(treeDir, { recursive: true });

  // 1. The whole base ref, so every path a tsconfig/vitest config/test reads exists.
  const tar = `${treeDir}.tar`;
  readGit(baseRepo, ["archive", `--output=${tar}`, base]);
  execFileSync("tar", ["-xf", tar, "-C", treeDir], { env: cleanEnv() });
  rmSync(tar, { force: true });

  const roots = workspaceRoots(root);
  const files = headFiles(root);

  // 2. What differs, by content. Outside the workspace packages, a difference
  //    cannot be represented honestly (linked packages were built by the
  //    working tree against its own copy), so refuse unless told to hold it.
  const difference = compareTrees(root, treeDir, roots);
  if (difference.rootPaths.length > 0 && opts.rootFromHead !== true) {
    throw new DifferentialRefusal([
      `differential-vs-main: refused — ${difference.rootPaths.length} path(s) outside the workspace packages differ from ${base}:`,
      ...difference.rootPaths.slice(0, 40).map((p) => `    ${p}`),
      ...(difference.rootPaths.length > 40
        ? [`    … and ${difference.rootPaths.length - 40} more`]
        : []),
      "Builds and tests read root files (tsconfig.base.json, package.json, pnpm-lock.yaml, patches/, root configs). Every linked working-tree package was built against the working tree's copies, so a change here would read SAME while the base side claimed main's.",
      `Fix: compare a tree whose paths outside the workspace packages equal ${base}'s (rebase, or stash those changes), or pass --root-from-head to hold the working tree's copy of every path above on BOTH sides — they are then listed as NOT differentialled.`,
    ]);
  }
  for (const p of difference.rootPaths) {
    const into = join(treeDir, p);
    rmSync(into, { force: true });
    const from = join(root, p);
    if (!existsSync(from)) continue;
    mkdirSync(dirname(into), { recursive: true });
    if (lstatSync(from).isSymbolicLink()) symlinkSync(readlinkSync(from), into);
    else copyFileSync(from, into);
  }

  const headDirs = listWorkspaceDirs(root, roots);
  const baseDirs = listWorkspaceDirs(treeDir, roots);
  const requested = opts.fromMain === "diff" ? difference.packages : opts.fromMain;
  const fromMainSet = new Set([...requested, host]);
  const fromMain = [...fromMainSet].filter((d) => baseDirs.includes(d)).sort();
  const absentOnBase = [...fromMainSet].filter((d) => !baseDirs.includes(d)).sort();
  // The root node_modules is mirrored from the working tree, so these are what it links.
  const implicit = rootWorkspaceDeps(root);

  // 3. The package graph as the base tree will see it: from-main packages
  //    declare their base deps, everything else its working-tree deps.
  const byDir = new Map<string, WorkspacePackage>();
  for (const d of new Set([...headDirs, ...baseDirs])) {
    const p = fromMain.includes(d) ? readPackage(treeDir, d) : readPackage(root, d);
    if (p != null) byDir.set(d, p);
  }
  const reachesFromMain = (d: string) =>
    [...dependencyClosure(d, byDir, implicit)].some((x) => x !== d && fromMain.includes(x));
  const headSource = headDirs.filter((d) => !fromMainSet.has(d) && reachesFromMain(d)).sort();
  const probeReach = dependencyClosure(host, byDir, implicit);
  const baseOnly = baseDirs.filter((d) => !headDirs.includes(d) && !fromMainSet.has(d)).sort();

  // 4. A linked working-tree package the probe can reach is read from its
  //    working-tree build on the base side too: refuse if that build is stale.
  const linkedReach = [...probeReach].filter(
    (d) => headDirs.includes(d) && !fromMainSet.has(d) && !headSource.includes(d),
  );
  const stale = staleBuilds(root, linkedReach, byDir, files);
  if (stale.length > 0) {
    throw new DifferentialRefusal([
      `differential-vs-main: refused — working-tree builds the base side reads are stale: ${stale.join(", ")}.`,
      `Fix: ${repairCommand(stale, linkedReach, byDir)}`,
    ]);
  }

  // 5. Root node_modules, mirrored so root-level workspace links land in the base tree.
  if (existsSync(join(root, "node_modules"))) {
    mirrorNodeModules(join(root, "node_modules"), join(treeDir, "node_modules"));
  }

  // 6. Every workspace package, per the aperture.
  let linkedFromHead = 0;
  for (const d of new Set([...headDirs, ...baseDirs])) {
    const target = join(treeDir, d);
    const headNm = join(root, d, "node_modules");
    if (fromMain.includes(d)) {
      rewriteScripts(target);
      if (existsSync(headNm)) mirrorNodeModules(headNm, join(target, "node_modules"));
      else
        log(
          `  ! ${d}: no node_modules in the working tree (new on ${base}?) — its imports may not resolve`,
        );
      continue;
    }
    if (!headDirs.includes(d)) continue; // base-only, not requested: left as extracted
    rmSync(target, { recursive: true, force: true });
    if (headSource.includes(d)) {
      // SOURCE only — a head dist may have inlined the working tree's version of a from-main package.
      for (const f of files) {
        if (!f.startsWith(`${d}/`)) continue;
        mkdirSync(dirname(join(treeDir, f)), { recursive: true });
        const from = join(root, f);
        if (lstatSync(from).isSymbolicLink()) symlinkSync(readlinkSync(from), join(treeDir, f));
        else copyFileSync(from, join(treeDir, f));
      }
      rewriteScripts(target);
      if (existsSync(headNm)) mirrorNodeModules(headNm, join(target, "node_modules"));
    } else {
      symlinkSync(join(root, d), target);
      linkedFromHead++;
    }
  }

  // 7. Rebuild inside the base tree every from-main or head-source package the
  //    probe can reach, dependencies first. The host is imported by relative
  //    path, so it is built only when something else the probe reaches imports it.
  const hostImported = [...probeReach].some(
    (d) => d !== host && dependencyClosure(d, byDir, implicit).has(host),
  );
  const candidates = [...probeReach].filter(
    (d) =>
      (fromMain.includes(d) || headSource.includes(d)) &&
      (d !== host || hostImported) &&
      baseBuildCommand(byDir.get(d)?.scripts.build) != null,
  );
  const order = topoOrder(candidates, byDir);
  await buildAll(
    order,
    byDir,
    treeDir,
    (d) => (fromMain.includes(d) ? `${base} source` : "working-tree source"),
    log,
  );

  return {
    fromMain,
    absentOnBase,
    rebuiltFromMain: order.filter((d) => fromMain.includes(d)),
    rebuiltFromHead: order.filter((d) => headSource.includes(d)),
    copiedUnbuilt: headSource.filter((d) => !order.includes(d)),
    linkedFromHead,
    baseOnly,
    rootWorkspaceDeps: implicit,
    rootHeldAtHead: difference.rootPaths,
  };
}
