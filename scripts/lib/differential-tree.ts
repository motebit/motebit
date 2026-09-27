/**
 * differential-tree — assemble the BASE tree `scripts/differential-vs-main.ts`
 * runs a probe in: the base ref's files, with a chosen set of workspace
 * packages taken from the base ref and every other workspace package taken
 * from this checkout, wired so that every import the probe can reach resolves
 * to exactly that mix.
 *
 * History (#818, then the #833 review that withdrew the first fix):
 *
 *   1. The original archived ONE package. A package whose `tsconfig.json`
 *      lists `references` (surface-kit, most of `packages/*`) failed to
 *      transform any test on the base side: vite's oxc transform follows every
 *      reference, and `../core-identity` was not in the temp tree. (The
 *      "vitest.shared.ts loaded as CommonJS" warning beside it is a red
 *      herring — the root package.json has no `"type": "module"`, so it prints
 *      on the working tree too.) Its `node_modules` was a link to the working
 *      tree's, so no other package could come from the base ref.
 *   2. The first fix copied working-tree packages that sit between the probe
 *      and a from-main package WITH their built `dist`. A bundling build
 *      (render-engine's `browser.iife.js`, crypto's tsup `noExternal`,
 *      create-motebit, the CLI) had already INLINED the working tree's version
 *      of the from-main package, so a protocol change seen through mobile's
 *      creature bundle reported SAME while the aperture said protocol came
 *      from main. Rule now: a head `dist` is never copied into the base tree;
 *      every head package that can reach a from-main package is copied as
 *      SOURCE and rebuilt inside the base tree, bundling steps included.
 *   3. The first fix computed "can reach" from declared dependencies only.
 *      The root package.json declares workspace packages (runtime, semiring,
 *      verifier, wallet-solana) that node resolves from ANY package by walking
 *      up to the root `node_modules`. Rule now: every package's reachable set
 *      includes the root package.json's workspace deps.
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
 *     `dist`, never `*.tsbuildinfo`, never ignored/generated files) and it is
 *     rebuilt inside the base tree when the probe can reach it; when the probe
 *     cannot, it stays unbuilt, so loading it fails loudly instead of quietly.
 *   - linked: a working-tree package that cannot reach any from-main package.
 *     A symlink is exact: nothing it loads differs between the two trees.
 *   - base-only: exists only on the base ref and was not requested. Left as
 *     the base ref's source, unbuilt.
 *
 * Node resolves a module from its REAL path, which is why a package that can
 * reach a from-main package must live inside the base tree: a linked one would
 * resolve its imports from the working tree and silently skip the base version.
 *
 * Residual, stated: third-party packages live in the working tree's `.pnpm`
 * store on both sides, so a third-party package that itself imports an
 * `@motebit/*` package would resolve it to the working tree.
 */
import { execFileSync, spawn } from "node:child_process";
import {
  copyFileSync,
  existsSync,
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

/** The workspace package a repo-relative path belongs to, or null. */
export function packageDirOf(path: string, roots: string[]): string | null {
  const parts = path.split("/");
  if (parts.length < 2 || !roots.includes(parts[0]!)) return null;
  return `${parts[0]}/${parts[1]}`;
}

/**
 * The default aperture: every workspace package whose files differ between
 * the base ref and the working tree (committed, staged, unstaged and
 * untracked-not-ignored), in either direction of a rename.
 */
export function packagesTouchedSince(root: string, base: string, roots: string[]): string[] {
  const git = (args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 });
  const paths = [
    ...git(["diff", "--name-only", "--no-renames", base]).split("\n"),
    ...git(["ls-files", "--others", "--exclude-standard"]).split("\n"),
  ].filter(Boolean);
  const dirs = new Set<string>();
  for (const p of paths) {
    const d = packageDirOf(p, roots);
    if (d) dirs.add(d);
  }
  return [...dirs].sort();
}

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

function newestMtime(dir: string, skip: (name: string) => boolean = () => false): number {
  if (!existsSync(dir)) return -1;
  let newest = -1;
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (skip(e.name)) continue;
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) newest = Math.max(newest, statSync(p).mtimeMs);
    }
  };
  walk(dir);
  return newest;
}

/** When a package was last built: its newest `dist` file or package-root `*.tsbuildinfo` (-1 if never). */
export function buildTime(pkgDir: string): number {
  let t = newestMtime(join(pkgDir, "dist"));
  if (existsSync(pkgDir)) {
    for (const f of readdirSync(pkgDir)) {
      if (f.endsWith(".tsbuildinfo")) t = Math.max(t, statSync(join(pkgDir, f)).mtimeMs);
    }
  }
  return t;
}

/**
 * Working-tree packages among `dirs` whose build is stale: a buildable
 * package with `src/` that was never built, or was last built before its
 * newest non-test source file changed, or before a workspace package it
 * declares was last built (a bundling build — render-engine's browser bundle,
 * crypto's tsup — inlines its dependencies, so a rebuilt dependency makes it
 * stale even when its own source did not move). `tsc -b` refreshes
 * `*.tsbuildinfo` even when it re-emits nothing, so a `pnpm --filter
 * <pkg>... build` always clears this. Both sides of a differential read these
 * builds, so a stale one makes a real change read as SAME.
 */
export function staleBuilds(
  root: string,
  dirs: Iterable<string>,
  byDir: Map<string, WorkspacePackage>,
): string[] {
  const byName = new Map([...byDir.values()].map((p) => [p.name, p.dir]));
  const stale: string[] = [];
  for (const d of dirs) {
    const pkg = byDir.get(d);
    if (baseBuildCommand(pkg?.scripts.build) == null) continue;
    const srcNewest = newestMtime(join(root, d, "src"), (n) => n === "__tests__");
    if (srcNewest < 0) continue;
    const built = buildTime(join(root, d));
    const depBuilt = Math.max(
      -1,
      ...(pkg?.deps ?? [])
        .map((n) => byName.get(n))
        .filter((x): x is string => x != null && x !== d)
        .map((x) => buildTime(join(root, x))),
    );
    if (built < srcNewest || built < depBuilt) stale.push(d);
  }
  return stale.sort();
}

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
  /** Paths outside the workspace packages: always the base ref's. */
  rootFrom: string;
}

export interface BuildBaseTreeOptions {
  root: string;
  base: string;
  /** Directory the base tree is created in (must be empty or absent). */
  treeDir: string;
  /** Workspace package the probe runs in; always from the base ref. */
  host: string;
  fromMain: string[];
  log?: (line: string) => void;
}

/** The PATH entries a package's scripts expect: its own and the root `.bin`. */
export function binPath(treeDir: string, dir: string): string[] {
  return [join(treeDir, dir, "node_modules", ".bin"), join(treeDir, "node_modules", ".bin")];
}

function explain(what: string, cmd: string, cwd: string, out: string, err?: unknown): Error {
  const tail = out.split("\n").filter(Boolean).slice(-30).join("\n");
  return new Error(
    `${what} failed (\`${cmd}\` in ${cwd}):\n${tail}\n` +
      "Fix: the working tree's own builds must exist and be current for every package the base build reads " +
      "(`pnpm --filter <host package>... build`), and the command must succeed on the base ref.",
    { cause: err },
  );
}

function runAsync(cmd: string, cwd: string, extraPath: string[], what: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("sh", ["-c", cmd], {
      cwd,
      env: { ...process.env, PATH: [...extraPath, process.env.PATH ?? ""].join(":") },
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

/** Tracked + untracked-not-ignored files of `dir` in the working tree (its source, never build output). */
function headSourceFiles(root: string, dir: string): string[] {
  return execFileSync("git", ["ls-files", "-co", "--exclude-standard", "-z", "--", dir], {
    cwd: root,
    encoding: "utf-8",
    maxBuffer: 256 * 1024 * 1024,
  })
    .split("\0")
    .filter(Boolean);
}

export async function buildBaseTree(opts: BuildBaseTreeOptions): Promise<Aperture> {
  const { root, base, treeDir, host } = opts;
  const log = opts.log ?? (() => {});
  mkdirSync(treeDir, { recursive: true });

  // 1. The whole base ref, so every path a tsconfig/vitest config/test reads exists.
  const tar = `${treeDir}.tar`;
  execFileSync("git", ["archive", `--output=${tar}`, base], { cwd: root });
  execFileSync("tar", ["-xf", tar, "-C", treeDir]);
  rmSync(tar, { force: true });

  const roots = workspaceRoots(root);
  const headDirs = listWorkspaceDirs(root, roots);
  const baseDirs = listWorkspaceDirs(treeDir, roots);
  const fromMainSet = new Set([...opts.fromMain, host]);
  const fromMain = [...fromMainSet].filter((d) => baseDirs.includes(d)).sort();
  const absentOnBase = [...fromMainSet].filter((d) => !baseDirs.includes(d)).sort();
  // The root node_modules is mirrored from the working tree, so these are what it links.
  const implicit = rootWorkspaceDeps(root);

  // 2. The package graph as the base tree will see it: from-main packages
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

  // 3. A linked working-tree package the probe can reach is read from its
  //    working-tree build on the base side too: refuse if that build is stale.
  const linkedReach = [...probeReach].filter(
    (d) => headDirs.includes(d) && !fromMainSet.has(d) && !headSource.includes(d),
  );
  const stale = staleBuilds(root, linkedReach, byDir);
  if (stale.length > 0) {
    throw new Error(
      `working-tree builds older than their own source or a dependency's build, read by the base side: ${stale.join(", ")}.\n` +
        `Fix: pnpm ${stale.map((d) => `--filter ./${d}...`).join(" ")} run build`,
    );
  }

  // 4. Root node_modules, mirrored so root-level workspace links land in the base tree.
  if (existsSync(join(root, "node_modules"))) {
    mirrorNodeModules(join(root, "node_modules"), join(treeDir, "node_modules"));
  }

  // 5. Every workspace package, per the aperture.
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
      for (const f of headSourceFiles(root, d)) {
        const from = join(root, f);
        if (!existsSync(from)) continue; // tracked but deleted in the working tree
        mkdirSync(dirname(join(treeDir, f)), { recursive: true });
        copyFileSync(from, join(treeDir, f));
      }
      rewriteScripts(target);
      if (existsSync(headNm)) mirrorNodeModules(headNm, join(target, "node_modules"));
    } else {
      symlinkSync(join(root, d), target);
      linkedFromHead++;
    }
  }

  // 6. Rebuild inside the base tree every from-main or head-source package the
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
    rootFrom: base,
  };
}
