/**
 * differential-tree — assemble the BASE tree `scripts/differential-vs-main.ts`
 * runs a probe in: the base ref's files, with a chosen set of workspace
 * packages taken from the base ref and every other workspace package taken
 * from this checkout, wired so that imports resolve to exactly that mix.
 *
 * Why this is its own module (#818): the first version archived ONE package
 * and linked the working tree's `node_modules` under it. Three things broke:
 *
 *   1. A package whose `tsconfig.json` lists `references` (surface-kit, and
 *      most of `packages/*`) failed to transform any test file on the base
 *      side: vite's oxc transform loads the tsconfig, follows every
 *      reference, and `../core-identity` did not exist in the temp tree
 *      (`[TSCONFIG_ERROR] Failed to load tsconfig '../core-identity'`). The
 *      "vitest.shared.ts loaded as CommonJS" warning printed beside it is a
 *      red herring: the root `package.json` has no `"type": "module"`, so the
 *      warning prints on the working tree too, where the run passes.
 *   2. Only one package could come from the base ref. The package's
 *      `node_modules` was a link to the working tree's, so every workspace
 *      import resolved to this checkout even when the change also moved that
 *      package — a change spanning surface-kit and an app could not be
 *      differentialled at all.
 *   3. Generated inputs (`pretest`, e.g. apps/mobile's creature bundle) were
 *      never produced on either side.
 *
 * The shape now: the WHOLE base ref is extracted (45 MB, under a second), so
 * every sibling a tsconfig references exists. Each workspace package is then
 * one of:
 *
 *   - from-main: kept as extracted, with a `node_modules` that MIRRORS the
 *     working tree's (same relative link targets, so `@motebit/*` links land
 *     on the base tree's copy of that package, and external deps land in the
 *     working tree's `.pnpm` store through the mirrored root `node_modules`).
 *     If anything in the probe host's dependency closure imports it, it is
 *     rebuilt from base sources.
 *   - materialized head copy: a working-tree package in the host's closure
 *     that itself depends on a from-main package. Copied (with its built
 *     `dist`), node_modules mirrored, so ITS imports reach the base version.
 *   - link to head: everything else. Its imports can never reach a from-main
 *     package, so a symlink is exact and free.
 *
 * Node resolves a module from its REAL path, which is why the middle case must
 * be a copy and not a link: a linked head package would resolve its imports
 * from the working tree and silently skip the base version.
 */
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { join, relative } from "node:path";

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

export function readPackage(treeDir: string, dir: string): WorkspacePackage | null {
  const file = join(treeDir, dir, "package.json");
  if (!existsSync(file)) return null;
  const m = JSON.parse(readFileSync(file, "utf-8")) as {
    name?: string;
    scripts?: Record<string, string>;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
  };
  const deps = new Set<string>();
  for (const block of [
    m.dependencies,
    m.devDependencies,
    m.peerDependencies,
    m.optionalDependencies,
  ]) {
    for (const [k, v] of Object.entries(block ?? {})) if (v.startsWith("workspace:")) deps.add(k);
  }
  return { dir, name: m.name ?? dir, deps: [...deps].sort(), scripts: m.scripts ?? {} };
}

/** Every workspace package directory present in `treeDir`. */
export function listWorkspaceDirs(treeDir: string, roots: string[]): string[] {
  const out: string[] = [];
  for (const r of roots) {
    const abs = join(treeDir, r);
    if (!existsSync(abs)) continue;
    for (const e of readdirSync(abs, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
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

/**
 * Recreate `src` (a pnpm `node_modules`) at `dst` so resolution from `dst`'s
 * position lands where the aperture says it should: symlinks are recreated
 * with the SAME target text (relative targets now resolve inside the base
 * tree — `@motebit/sdk -> ../../../sdk` reaches the base tree's sdk), scope
 * directories are recursed, anything else (`.pnpm`, `.bin`, caches) is linked
 * absolutely to the working tree's copy.
 */
export function mirrorNodeModules(src: string, dst: string): void {
  mkdirSync(dst, { recursive: true });
  for (const e of readdirSync(src, { withFileTypes: true })) {
    const s = join(src, e.name);
    const d = join(dst, e.name);
    if (e.isSymbolicLink()) symlinkSync(readlinkSync(s), d);
    else if (e.isDirectory() && e.name.startsWith("@")) mirrorNodeModules(s, d);
    else symlinkSync(s, d);
  }
}

/** Workspace packages reachable from `from` through workspace deps (including `from`). */
export function dependencyClosure(from: string, byDir: Map<string, WorkspacePackage>): Set<string> {
  const byName = new Map([...byDir.values()].map((p) => [p.name, p.dir]));
  const seen = new Set<string>();
  const stack = [from];
  while (stack.length > 0) {
    const d = stack.pop()!;
    if (seen.has(d)) continue;
    seen.add(d);
    for (const dep of byDir.get(d)?.deps ?? []) {
      const dd = byName.get(dep);
      if (dd != null && !seen.has(dd)) stack.push(dd);
    }
  }
  return seen;
}

/** `dirs` ordered so every package follows the workspace deps it has inside `dirs`. */
export function topoOrder(dirs: string[], byDir: Map<string, WorkspacePackage>): string[] {
  const byName = new Map([...byDir.values()].map((p) => [p.name, p.dir]));
  const want = new Set(dirs);
  const out: string[] = [];
  const state = new Map<string, "visiting" | "done">();
  const visit = (d: string) => {
    if (state.get(d) === "done" || state.get(d) === "visiting") return;
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
 * The build command to rebuild a from-main package in the base tree. `tsc -b`
 * becomes `tsc -p tsconfig.json`: build mode walks `references` and would
 * REBUILD a stale referenced package through its symlink — i.e. write into the
 * working tree. `-p` reads the referenced packages' existing declarations and
 * emits only this package.
 */
export function baseBuildCommand(script: string | undefined): string | null {
  if (script == null || /^\s*echo\b/.test(script)) return null;
  return script.replace(/\btsc -b(?=\s*(?:&&|;|$))/g, "tsc -p tsconfig.json");
}

export interface Aperture {
  /** Workspace packages taken from the base ref (present on it). */
  fromMain: string[];
  /** Requested from the base ref but absent there (new on this branch). */
  absentOnBase: string[];
  /** From-main packages rebuilt from base sources, in build order. */
  rebuilt: string[];
  /** Working-tree packages copied so their imports reach from-main packages. */
  materialized: string[];
  /** Working-tree packages linked in unchanged. */
  linkedFromHead: number;
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

function run(cmd: string, cwd: string, extraPath: string[]): void {
  execFileSync("sh", ["-c", cmd], {
    cwd,
    env: { ...process.env, PATH: [...extraPath, process.env.PATH ?? ""].join(":") },
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
}

function runOrExplain(cmd: string, cwd: string, extraPath: string[], what: string): void {
  try {
    run(cmd, cwd, extraPath);
  } catch (err) {
    const e = err as { stdout?: Buffer; stderr?: Buffer };
    const tail = `${String(e.stdout ?? "")}\n${String(e.stderr ?? "")}`
      .split("\n")
      .filter(Boolean)
      .slice(-30)
      .join("\n");
    throw new Error(
      `${what} failed (\`${cmd}\` in ${cwd}):\n${tail}\n` +
        "Fix: the working tree's own builds must exist for every package the base build reads " +
        "(e.g. `pnpm --filter <host package>... build`), and the command must succeed on the base ref.",
      { cause: err },
    );
  }
}

/** The PATH entries a package's scripts expect: its own and the root `.bin`. */
export function binPath(treeDir: string, dir: string): string[] {
  return [join(treeDir, dir, "node_modules", ".bin"), join(treeDir, "node_modules", ".bin")];
}

/** Run a package's `pretest` script if it has one (generated test inputs). */
export function runPretest(treeDir: string, pkg: WorkspacePackage | null): void {
  const cmd = pkg?.scripts.pretest;
  if (cmd == null) return;
  runOrExplain(cmd, join(treeDir, pkg!.dir), binPath(treeDir, pkg!.dir), `pretest for ${pkg!.dir}`);
}

export function buildBaseTree(opts: BuildBaseTreeOptions): Aperture {
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

  // 2. The package graph as the base tree will see it: from-main packages
  //    declare their base deps, everything else its working-tree deps.
  const byDir = new Map<string, WorkspacePackage>();
  for (const d of new Set([...headDirs, ...baseDirs])) {
    const p = fromMain.includes(d) ? readPackage(treeDir, d) : readPackage(root, d);
    if (p != null) byDir.set(d, p);
  }
  const hostClosure = dependencyClosure(host, byDir);
  const reachesFromMain = (d: string) =>
    [...dependencyClosure(d, byDir)].some((x) => x !== d && fromMain.includes(x));
  const materialized = headDirs
    .filter((d) => !fromMainSet.has(d) && hostClosure.has(d) && reachesFromMain(d))
    .sort();

  // 3. Root node_modules, mirrored so root-level workspace links also land in the base tree.
  if (existsSync(join(root, "node_modules"))) {
    mirrorNodeModules(join(root, "node_modules"), join(treeDir, "node_modules"));
  }

  // 4. Every workspace package, per the aperture.
  let linkedFromHead = 0;
  for (const d of new Set([...headDirs, ...baseDirs])) {
    const target = join(treeDir, d);
    const headNm = join(root, d, "node_modules");
    if (fromMain.includes(d)) {
      if (existsSync(headNm)) mirrorNodeModules(headNm, join(target, "node_modules"));
      else
        log(
          `  ! ${d}: no node_modules in the working tree (new on ${base}?) — its imports may not resolve`,
        );
      continue;
    }
    if (!headDirs.includes(d)) continue; // on base only, not requested: left as extracted
    rmSync(target, { recursive: true, force: true });
    if (materialized.includes(d)) {
      cpSync(join(root, d), target, {
        recursive: true,
        filter: (src) => {
          const rel = relative(join(root, d), src);
          return !/^(node_modules|\.turbo|coverage)(\/|$)/.test(rel);
        },
      });
      if (existsSync(headNm)) mirrorNodeModules(headNm, join(target, "node_modules"));
    } else {
      symlinkSync(join(root, d), target);
      linkedFromHead++;
    }
  }

  // 5. Rebuild the from-main packages the probe host can import, deps first.
  //    The host itself is imported by relative path, never through dist.
  const toBuild = topoOrder(
    fromMain.filter((d) => d !== host && hostClosure.has(d)),
    byDir,
  );
  const rebuilt: string[] = [];
  for (const d of toBuild) {
    const cmd = baseBuildCommand(byDir.get(d)?.scripts.build);
    if (cmd == null) continue;
    log(`  building ${d} from ${base}: ${cmd}`);
    runOrExplain(cmd, join(treeDir, d), binPath(treeDir, d), `base build of ${d}`);
    rebuilt.push(d);
  }

  return {
    fromMain,
    absentOnBase,
    rebuilt,
    materialized,
    linkedFromHead,
    rootFrom: base,
  };
}
