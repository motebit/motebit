/**
 * differential-tree — assemble the two trees `scripts/differential-vs-main.ts`
 * runs a probe in, BOTH built fresh from source in temp dirs:
 *
 *   - the HEAD tree: the working tree's tracked + untracked-not-ignored files;
 *   - the BASE tree: the base ref's files, with every workspace package NOT
 *     taken from the base ref replaced by the working tree's source.
 *
 * In each tree every package the probe can reach is rebuilt in dependency
 * order by the same build logic. The working tree's own `dist` is never read
 * by either side, so no freshness judgement is ever made — or the run
 * refuses, loudly, when it cannot say what it compared.
 *
 * History (#818; the #833, #835 and #837 reviews each withdrew a fix):
 *
 *   1. The original archived ONE package. A package whose `tsconfig.json`
 *      lists `references` failed to transform any test on the base side (oxc
 *      follows every reference; the siblings were not in the temp tree), and
 *      its `node_modules` linked to the working tree's, so no other package
 *      could come from the base ref.
 *   2. #833: working-tree packages were copied WITH their `dist`; a bundle
 *      (render-engine's `browser.iife.js`, crypto's tsup, create-motebit, the
 *      CLI) had already inlined the working tree's version of a from-main
 *      package ⇒ false SAME. And "can reach" ignored the root package.json's
 *      workspace deps (runtime, semiring, verifier, wallet-solana), which node
 *      resolves from ANY package ⇒ false SAME.
 *   3. #835: root files (tsconfig.base.json, package.json, …) were claimed to
 *      come from main while linked packages had been built against the working
 *      tree's copies; and the fixture test rewrote the real repository through
 *      an inherited GIT_DIR. Rules kept: refuse on a differing root path that
 *      can affect a build or probe; every child runs with EVERY `GIT_*` removed
 *      and an explicit cwd; this module runs only read-only git (enforced).
 *   4. #837: the working tree's builds were judged fresh by mtimes. That can't
 *      be cleared on the real repo (tsup always re-emits; `tsc -b` dependents
 *      skip without touching tsbuildinfo) and it missed transitive bundle
 *      inputs; and a probe package NEW on the branch was linked to the working
 *      tree on the base side ⇒ silent SAME. Rules now: both sides are built
 *      from source in isolated trees (no freshness judgement exists); a probe
 *      package absent on the base ref refuses.
 *
 * Node resolves a module from its REAL path, so each tree is self-contained:
 * package sources are copied, and `node_modules` are MIRRORED from the working
 * tree's install (same relative link targets, so `@motebit/*` links land on
 * the same tree's copy of that package; third-party deps land in the working
 * tree's `.pnpm` store).
 *
 * Residual, stated: third-party packages come from the working tree's install
 * on both sides (one lockfile), so a third-party version change is not
 * differentialled, and a third-party package that imports an `@motebit/*`
 * package would resolve it to the working tree.
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

/**
 * Paths outside the workspace packages whose difference from the base ref
 * does NOT refuse the run. Each side's tree holds its OWN copy of these
 * (both trees are built from source), so a probe that reads one still sees
 * each side's version; the refusal exists only for root paths that are
 * consumed through the shared install or that no single side can own. Every
 * pattern is listed in the aperture of every run.
 */
export const ROOT_IGNORED: ReadonlyArray<{ pattern: RegExp; label: string; why: string }> = [
  {
    pattern: /^\.changeset\/[^/]+\.md$/,
    label: ".changeset/*.md",
    why: "release notes consumed only by `changeset version`; no build, test or probe reads them",
  },
  {
    pattern: /^docs\//,
    label: "docs/**",
    why: "prose; no package build reads docs/ (the self-knowledge corpus is committed inside its package)",
  },
  {
    pattern: /^\.claude\//,
    label: ".claude/**",
    why: "agent configuration; read by no build, test or probe",
  },
  {
    pattern: /^[^/]*\.md$|\/[^/]*\.md$/,
    label: "*.md outside packages",
    why: "markdown is not a build input; a test that reads one (runtime's emergent-interior eval reads THE_EMERGENT_INTERIOR.md) reads its own tree's copy",
  },
];

export function isIgnorableRootPath(path: string): boolean {
  return ROOT_IGNORED.some((r) => r.pattern.test(path));
}

export interface TreeDifference {
  /** Workspace packages with any differing file (either direction). */
  packages: string[];
  /** Differing paths outside every workspace package that can affect a build or probe. */
  rootPaths: string[];
  /** Differing paths outside every workspace package that match ROOT_IGNORED. */
  ignoredRootPaths: string[];
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
  const ignoredRootPaths: string[] = [];
  for (const f of differing) {
    const d = packageDirOf(f, roots);
    if (d != null) packages.add(d);
    else if (isIgnorableRootPath(f)) ignoredRootPaths.push(f);
    else rootPaths.push(f);
  }
  return {
    packages: [...packages].sort(),
    rootPaths: rootPaths.sort(),
    ignoredRootPaths: ignoredRootPaths.sort(),
  };
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

/** The PATH entries a package's scripts expect: its own and the root `.bin`. */
export function binPath(treeDir: string, dir: string): string[] {
  return [join(treeDir, dir, "node_modules", ".bin"), join(treeDir, "node_modules", ".bin")];
}

function explain(what: string, cmd: string, cwd: string, out: string, err?: unknown): Error {
  const tail = out.split("\n").filter(Boolean).slice(-30).join("\n");
  return new Error(
    `${what} failed (\`${cmd}\` in ${cwd}):\n${tail}\n` +
      "Fix: the command must succeed on this side's source (it runs in a temp tree built from source).",
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
  side: "base" | "head",
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
      log(`  building ${d} (${side} tree): ${cmd}`);
      running.set(
        d,
        runAsync(cmd, join(treeDir, d), binPath(treeDir, d), `${side}-tree build of ${d}`).then(
          () => {
            done.add(d);
            running.delete(d);
          },
        ),
      );
    }
    if (running.size === 0)
      throw new Error(`differential-tree: dependency cycle among ${order.join(", ")}`);
    await Promise.race(running.values());
  }
}

// ── The two trees ────────────────────────────────────────────────────

export interface Aperture {
  /** Workspace packages taken from the base ref (present on it). */
  fromMain: string[];
  /** Requested from the base ref but absent there (new on this branch). */
  absentOnBase: string[];
  /** Packages built inside the base tree, in build order. */
  builtBase: string[];
  /** Packages built inside the head tree, in build order (empty with headFromWorkingTree). */
  builtHead: string[];
  /** On the base ref only, not requested: the base ref's source, unbuilt. */
  baseOnly: string[];
  /** Workspace deps of the root package.json, reachable from every package. */
  rootWorkspaceDeps: string[];
  /**
   * Root paths that differ from the base ref and were held at the WORKING
   * TREE's copy on both sides (`rootFromHead`): not differentialled. Empty
   * unless the caller opted in; otherwise the run refuses.
   */
  rootHeldAtHead: string[];
  /** Differing root paths in ROOT_IGNORED: each side's tree holds its own copy. */
  rootIgnoredDiffering: string[];
  /** The ROOT_IGNORED patterns, for the report. */
  rootIgnoredPatterns: string[];
  /** The head side read the working tree's own builds: NOT freshness-checked. */
  headFromWorkingTree: boolean;
}

export interface BuildTreesOptions {
  root: string;
  /** Repository the base ref is read from (default `root`). */
  baseRepo?: string;
  base: string;
  /** Empty temp directory the trees are created in. */
  workDir: string;
  /** Workspace package the probe runs in; always from the base ref. */
  host: string;
  /** Workspace packages from the base ref, or `diff`: every package whose files differ. */
  fromMain: string[] | "diff";
  /** Hold differing build-affecting root paths at the working tree's copy instead of refusing. */
  rootFromHead?: boolean;
  /** Fast path: the head side runs in the working tree on its own builds (NOT freshness-checked). */
  headFromWorkingTree?: boolean;
  log?: (line: string) => void;
}

export interface Trees {
  baseTree: string;
  /** The head tree, or the working tree itself with headFromWorkingTree. */
  headTree: string;
  aperture: Aperture;
}

/** Copy repo-relative `files` from `root` into `into` (symlinks as symlinks). */
function copyFiles(root: string, files: string[], into: string): void {
  for (const f of files) {
    const from = join(root, f);
    const to = join(into, f);
    mkdirSync(dirname(to), { recursive: true });
    rmSync(to, { force: true });
    if (lstatSync(from).isSymbolicLink()) symlinkSync(readlinkSync(from), to);
    else copyFileSync(from, to);
  }
}

/** Mirror the working tree's root and per-package node_modules into `tree`. */
function wireNodeModules(root: string, tree: string, dirs: string[]): void {
  if (existsSync(join(root, "node_modules"))) {
    mirrorNodeModules(join(root, "node_modules"), join(tree, "node_modules"));
  }
  for (const d of dirs) {
    const nm = join(root, d, "node_modules");
    if (existsSync(nm) && existsSync(join(tree, d))) {
      mirrorNodeModules(nm, join(tree, d, "node_modules"));
    }
  }
}

/** The probe's reach in `graph`, as the buildable packages to build, dependencies first. */
function buildOrder(
  host: string,
  graph: Map<string, WorkspacePackage>,
  implicit: string[],
): string[] {
  const reach = dependencyClosure(host, graph, implicit);
  // The host is imported by relative path; build it only if something else it reaches imports it.
  const hostImported = [...reach].some(
    (d) => d !== host && dependencyClosure(d, graph, implicit).has(host),
  );
  return topoOrder(
    [...reach].filter(
      (d) => (d !== host || hostImported) && baseBuildCommand(graph.get(d)?.scripts.build) != null,
    ),
    graph,
  );
}

export async function buildTrees(opts: BuildTreesOptions): Promise<Trees> {
  const { root, base, workDir, host } = opts;
  const baseRepo = opts.baseRepo ?? root;
  const log = opts.log ?? (() => {});
  const baseTree = join(workDir, "base");
  mkdirSync(baseTree, { recursive: true });

  // 1. The whole base ref.
  const tar = join(workDir, "base.tar");
  readGit(baseRepo, ["archive", `--output=${tar}`, base]);
  execFileSync("tar", ["-xf", tar, "-C", baseTree], { env: cleanEnv() });
  rmSync(tar, { force: true });

  const roots = workspaceRoots(root);
  const files = headFiles(root);
  const headDirs = listWorkspaceDirs(root, roots);
  const baseDirs = listWorkspaceDirs(baseTree, roots);

  // 2. The probe's package must exist on the base ref: there is nothing else to compare.
  if (!baseDirs.includes(host)) {
    throw new DifferentialRefusal([
      `differential-vs-main: refused — the probe's package ${host} is new on this branch: there is nothing on ${base} to compare.`,
      `Fix: put the probe in a package that exists on ${base} (--pkg <dir>), or compare this package's behaviour some other way.`,
    ]);
  }

  // 3. What differs, by content. A differing root path that can affect a build
  //    or probe cannot be assigned to one side (the install is shared), so refuse
  //    unless told to hold it at the working tree's copy.
  const difference = compareTrees(root, baseTree, roots);
  if (difference.rootPaths.length > 0 && opts.rootFromHead !== true) {
    throw new DifferentialRefusal([
      `differential-vs-main: refused — ${difference.rootPaths.length} path(s) outside the workspace packages differ from ${base}:`,
      ...difference.rootPaths.slice(0, 40).map((p) => `    ${p}`),
      ...(difference.rootPaths.length > 40
        ? [`    … and ${difference.rootPaths.length - 40} more`]
        : []),
      "Builds, installs and tests read root files (tsconfig.base.json, package.json, pnpm-lock.yaml, patches/, root configs); the install is shared by both sides, so a change here cannot be assigned to one side.",
      `Not refused (each side reads its own copy): ${ROOT_IGNORED.map((r) => r.label).join(", ")}.`,
      `Fix: compare a tree whose other root paths equal ${base}'s (rebase, or stash those changes), or pass --root-from-head to hold the working tree's copy of every path above on BOTH sides — they are then listed as NOT differentialled.`,
    ]);
  }
  copyFiles(
    root,
    difference.rootPaths.filter((p) => existsSync(join(root, p))),
    baseTree,
  );
  for (const p of difference.rootPaths) {
    if (!existsSync(join(root, p))) rmSync(join(baseTree, p), { force: true });
  }

  const requested = opts.fromMain === "diff" ? difference.packages : opts.fromMain;
  const fromMainSet = new Set([...requested, host]);
  const fromMain = [...fromMainSet].filter((d) => baseDirs.includes(d)).sort();
  const absentOnBase = [...fromMainSet].filter((d) => !baseDirs.includes(d)).sort();
  const baseOnly = baseDirs.filter((d) => !headDirs.includes(d) && !fromMainSet.has(d)).sort();

  // 4. The base tree: every package NOT taken from the base ref is the working
  //    tree's SOURCE (never its dist).
  for (const d of headDirs) {
    if (fromMainSet.has(d)) continue;
    rmSync(join(baseTree, d), { recursive: true, force: true });
    copyFiles(
      root,
      files.filter((f) => f.startsWith(`${d}/`)),
      baseTree,
    );
  }
  wireNodeModules(root, baseTree, [...new Set([...headDirs, ...baseDirs])]);

  // 5. The head tree: the working tree's source, unless the caller opted into
  //    reading the working tree's own builds.
  const headTree = opts.headFromWorkingTree === true ? root : join(workDir, "head");
  if (opts.headFromWorkingTree !== true) {
    copyFiles(root, files, headTree);
    wireNodeModules(root, headTree, headDirs);
  }

  // 6. Build the probe's reach in each tree from source, the same way.
  //    The root node_modules is the working tree's install, so these are what it links.
  const implicit = rootWorkspaceDeps(root);
  const baseGraph = workspaceGraph(baseTree, roots);
  const baseOrder = buildOrder(host, baseGraph, implicit);
  const headGraph = workspaceGraph(headTree, roots);
  const headOrder = opts.headFromWorkingTree === true ? [] : buildOrder(host, headGraph, implicit);
  for (const d of baseOrder) rewriteScripts(join(baseTree, d));
  for (const d of headOrder) rewriteScripts(join(headTree, d));
  await Promise.all([
    buildAll(baseOrder, baseGraph, baseTree, "base", log),
    buildAll(headOrder, headGraph, headTree, "head", log),
  ]);

  return {
    baseTree,
    headTree,
    aperture: {
      fromMain,
      absentOnBase,
      builtBase: baseOrder,
      builtHead: headOrder,
      baseOnly,
      rootWorkspaceDeps: implicit,
      rootHeldAtHead: difference.rootPaths,
      rootIgnoredDiffering: difference.ignoredRootPaths,
      rootIgnoredPatterns: ROOT_IGNORED.map((r) => r.label),
      headFromWorkingTree: opts.headFromWorkingTree === true,
    },
  };
}
