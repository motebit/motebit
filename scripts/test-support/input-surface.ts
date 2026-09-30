/**
 * The declared hash surface of a cached test task — what turbo folds into the
 * task hash — and the classifier the runtime input tracer runs every observed
 * input through. Pure functions over the repo's files; no vitest imports, so
 * the gate's self-tests exercise it directly.
 *
 * A package's `test` / `test:coverage` hash covers:
 *   - every git-visible file in the package (`$TURBO_DEFAULT$`), and its own
 *     build outputs;
 *   - every workspace dependency, transitively (`dependsOn: build` → `^build`);
 *   - the lockfile resolution of the package's OWN external closure, of its
 *     workspace dependencies' closures, and of the root package's closure;
 *   - `globalDependencies`, and the task's declared `inputs`;
 *   - the declared `env` / `globalEnv` values.
 *
 * Anything else a test observes is an input outside the hash.
 */
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";

import { classifyEnv, envPatternMatches } from "./env-policy.js";

export const TEST_TASKS = ["test", "test:coverage"] as const;

// ── Config ───────────────────────────────────────────────────────────────

/** turbo.json is JSONC: strip comments outside strings, then trailing commas. */
export function readJsonc<T>(file: string): T {
  const src = readFileSync(file, "utf-8");
  let out = "";
  let inStr = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inStr) {
      out += c;
      if (c === "\\") out += src[++i] ?? "";
      else if (c === '"') inStr = false;
    } else if (c === '"') {
      inStr = true;
      out += c;
    } else if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i++;
    } else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1")) as T;
}

export interface TaskCfg {
  dependsOn?: string[];
  inputs?: string[];
  outputs?: string[];
  env?: string[];
  passThroughEnv?: string[];
  cache?: boolean;
}
export interface TurboCfg {
  globalDependencies?: string[];
  globalEnv?: string[];
  globalPassThroughEnv?: string[];
  envMode?: string;
  tasks?: Record<string, TaskCfg>;
}

/** Turbo `inputs` glob subset: `**`, `*`, `?`, `!` negation. */
export function globToRegex(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      i++;
      if (glob[i + 1] === "/") {
        i++;
        re += "(?:.*/)?";
      } else re += ".*";
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

/** Absolute, `/`-separated glob for an `inputs` entry of the package at pkgDir. */
export function absGlob(root: string, pkgDir: string, input: string): string {
  const neg = input.startsWith("!");
  const body = neg ? input.slice(1) : input;
  const abs = body.startsWith("$TURBO_ROOT$/")
    ? join(root, body.slice("$TURBO_ROOT$/".length))
    : join(pkgDir, body);
  return (neg ? "!" : "") + abs.split(sep).join("/");
}

/** Do the (absolute) globs cover `target`? A directory is covered by `dir/**`. */
export function covers(globs: string[], target: string, isDir = false): boolean {
  const t = target.split(sep).join("/");
  let hit = false;
  for (const g of globs) {
    const neg = g.startsWith("!");
    const re = globToRegex(neg ? g.slice(1) : g);
    const m = isDir ? re.test(`${t}/__any__/__file__`) && re.test(`${t}/__file__`) : re.test(t);
    if (m) hit = !neg;
  }
  return hit;
}

// ── Workspace ────────────────────────────────────────────────────────────

/** `pnpm-workspace.yaml` → package dirs (repo-relative, `/`-separated). */
export function workspaceDirs(root: string): string[] {
  const yaml = readFileSync(join(root, "pnpm-workspace.yaml"), "utf-8");
  const pats = [...yaml.matchAll(/^\s*-\s*["']?([^"'\n#]+?)["']?\s*$/gm)].map((m) => m[1]);
  const dirs: string[] = [];
  for (const p of pats) {
    if (p.startsWith("!")) continue;
    if (p.endsWith("/*")) {
      const base = join(root, p.slice(0, -2));
      if (!existsSync(base)) continue;
      for (const e of readdirSync(base)) {
        if (existsSync(join(base, e, "package.json"))) dirs.push(`${p.slice(0, -2)}/${e}`);
      }
    } else if (existsSync(join(root, p, "package.json"))) dirs.push(p);
  }
  return dirs;
}

// ── Lockfile closure (pnpm lockfile v9) ─────────────────────────────────

export interface Lockfile {
  /** importer dir ("." / "packages/x") → external ids + workspace links */
  importers: Map<string, { ext: string[]; links: string[] }>;
  /** snapshot id (name@version, peers stripped) → dependency ids */
  snapshots: Map<string, string[]>;
}

const unquote = (s: string) => s.replace(/^['"]|['"]$/g, "");
const stripPeers = (v: string) => v.replace(/\(.*$/, "");

/** `name@version` for a dependency entry (`name: version`), aliases included. */
function depId(name: string, version: string): string | null {
  const v = unquote(version.trim());
  if (v.startsWith("link:") || v.startsWith("file:")) return null;
  // An alias (`string-width-cjs: string-width@4.2.3`) carries its own name.
  if (/^@?[^@(]+@\d/.test(v)) return stripPeers(v);
  return `${unquote(name)}@${stripPeers(v)}`;
}

export function parseLockfile(text: string): Lockfile {
  const importers = new Map<string, { ext: string[]; links: string[] }>();
  const snapshots = new Map<string, string[]>();
  let section = "";
  let key = "";
  let depName = "";
  let inDeps = false;
  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    const indent = raw.length - raw.trimStart().length;
    const line = raw.trim();
    if (indent === 0) {
      section = line.replace(/:$/, "");
      continue;
    }
    if (section === "importers") {
      if (indent === 2) {
        key = unquote(line.replace(/:.*$/, ""));
        importers.set(key, { ext: [], links: [] });
      } else if (indent === 4) {
        inDeps = /^(dependencies|devDependencies|optionalDependencies):/.test(line);
      } else if (indent === 6 && inDeps) {
        depName = unquote(line.replace(/:$/, ""));
      } else if (indent === 8 && inDeps && line.startsWith("version:")) {
        const v = line.slice("version:".length).trim();
        const imp = importers.get(key)!;
        if (v.startsWith("link:")) imp.links.push(v.slice(5));
        else {
          const id = depId(depName, v);
          if (id) imp.ext.push(id);
        }
      }
    } else if (section === "snapshots") {
      if (indent === 2) {
        key = stripPeers(unquote(line.replace(/:( \{\})?$/, "")));
        if (!snapshots.has(key)) snapshots.set(key, []);
      } else if (indent === 4) {
        inDeps = /^(dependencies|optionalDependencies):/.test(line);
      } else if (indent === 6 && inDeps) {
        const m = /^('[^']+'|"[^"]+"|[^:]+):\s*(.+)$/.exec(line);
        if (m) {
          const id = depId(m[1], m[2]);
          if (id) snapshots.get(key)!.push(id);
        }
      }
    }
  }
  return { importers, snapshots };
}

/**
 * Every external `name@version` in the hash of the importer at `dir`: its own
 * closure, its workspace links' closures (transitively), and the root's.
 */
export function lockfileClosure(lock: Lockfile, dir: string): Set<string> {
  const ids = new Set<string>();
  const seenImp = new Set<string>();
  const queue: string[] = [];
  const visitImporter = (d: string) => {
    if (seenImp.has(d)) return;
    seenImp.add(d);
    const imp = lock.importers.get(d);
    if (!imp) return;
    queue.push(...imp.ext);
    for (const l of imp.links) {
      visitImporter(relative(".", join(d, l)).split(sep).join("/") || ".");
    }
  };
  visitImporter(dir);
  visitImporter(".");
  while (queue.length) {
    const id = queue.pop()!;
    if (ids.has(id)) continue;
    ids.add(id);
    queue.push(...(lock.snapshots.get(id) ?? []));
  }
  return ids;
}

/** The workspace package dirs (repo-relative) the importer at `dir` links, transitively. */
export function workspaceClosure(lock: Lockfile, dir: string): Set<string> {
  const out = new Set<string>();
  const visit = (d: string) => {
    for (const l of lock.importers.get(d)?.links ?? []) {
      const t = relative(".", join(d, l)).split(sep).join("/");
      if (!out.has(t)) {
        out.add(t);
        visit(t);
      }
    }
  };
  visit(dir);
  return out;
}

// ── The surface ──────────────────────────────────────────────────────────

export interface Surface {
  root: string;
  pkgDir: string;
  /** repo-relative, `/`-separated */
  pkgRel: string;
  pkgName: string;
  /** false when both test tasks are `cache: false` — nothing to enforce. */
  cached: boolean;
  /** absolute globs covered by BOTH test tasks' inputs, plus globalDependencies. */
  inputGlobs: string[];
  globalGlobs: string[];
  /** hashed env var names / `*` patterns (both tasks + globalEnv) */
  hashedEnv: string[];
  depDirs: string[];
  extIds: Set<string>;
  /** `$TURBO_ROOT$/pnpm-lock.yaml` declared: every lockfile resolution is hashed. */
  lockfileDeclared: boolean;
  turboFile: string;
}

function taskCfg(root: TurboCfg, pkg: TurboCfg | null, t: string): TaskCfg {
  return { ...(root.tasks?.[t] ?? {}), ...(pkg?.tasks?.[t] ?? {}) };
}

export function computeSurface(root: string, pkgDir: string): Surface {
  const rootCfg = readJsonc<TurboCfg>(join(root, "turbo.json"));
  const pkgTurbo = join(pkgDir, "turbo.json");
  const pkgCfg = existsSync(pkgTurbo) ? readJsonc<TurboCfg>(pkgTurbo) : null;
  const pkgRel = relative(root, pkgDir).split(sep).join("/");
  const pkgName = (
    JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf-8")) as { name: string }
  ).name;
  const tasks = TEST_TASKS.map((t) => taskCfg(rootCfg, pkgCfg, t));
  const cached = tasks.some((t) => t.cache !== false);
  const perTask = tasks.map((t) =>
    (t.inputs ?? ["$TURBO_DEFAULT$"])
      .filter((i) => i !== "$TURBO_DEFAULT$")
      .map((i) => absGlob(root, pkgDir, i)),
  );
  // An input counts only when BOTH test tasks declare it.
  const inputGlobs = perTask[0].filter((g) => perTask[1].includes(g));
  const globalGlobs = (rootCfg.globalDependencies ?? []).map((g) => absGlob(root, root, g));
  const envPerTask = tasks.map((t) => t.env ?? []);
  const hashedEnv = [
    ...(rootCfg.globalEnv ?? []),
    ...envPerTask[0].filter((e) => envPerTask[1].includes(e)),
  ];
  let extIds = new Set<string>();
  let depDirs: string[] = [];
  const lockPath = join(root, "pnpm-lock.yaml");
  if (existsSync(lockPath)) {
    const lock = parseLockfile(readFileSync(lockPath, "utf-8"));
    extIds = lockfileClosure(lock, pkgRel);
    depDirs = [...workspaceClosure(lock, pkgRel)].map((d) => join(root, d));
  }
  const lockfileDeclared = covers(inputGlobs, lockPath) || covers(globalGlobs, lockPath);
  return {
    root,
    pkgDir,
    pkgRel,
    pkgName,
    cached,
    inputGlobs,
    globalGlobs,
    hashedEnv,
    depDirs,
    extIds,
    lockfileDeclared,
    turboFile: pkgRel ? `${pkgRel}/turbo.json` : "turbo.json",
  };
}

// ── Classification ───────────────────────────────────────────────────────

export type ObsKind = "read" | "probe" | "module" | "exec" | "readdir";

export interface Violation {
  what: string;
  why: string;
  repair: string;
  repairJson: { file: string; tasks: string[]; key: "inputs" | "env"; add: string };
}

const realCache = new Map<string, string | null>();
function real(p: string): string | null {
  let r = realCache.get(p);
  if (r === undefined) {
    try {
      r = realpathSync(p);
    } catch {
      r = null;
    }
    realCache.set(p, r);
  }
  return r;
}

function inside(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

const versionCache = new Map<string, string | null>();
/** `name@version` of the pnpm-store package a file belongs to, or null. */
export function storeIdOf(file: string): string | null {
  const m =
    /[/\\]node_modules[/\\]\.pnpm[/\\][^/\\]+[/\\]node_modules[/\\]((?:@[^/\\]+[/\\])?[^/\\]+)/.exec(
      file,
    );
  if (!m) return null;
  const pkgRoot = file.slice(0, m.index + m[0].length);
  let v = versionCache.get(pkgRoot);
  if (v === undefined) {
    try {
      v = (JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf-8")) as { version: string })
        .version;
    } catch {
      v = null;
    }
    versionCache.set(pkgRoot, v);
  }
  return v ? `${m[1].split(sep).join("/")}@${v}` : null;
}

const RUNTIME_DIR = dirname(dirname(process.execPath));

function inputRepair(s: Surface, add: string, what: string, why: string): Violation {
  return {
    what,
    why,
    repair:
      `add "${add}" to "inputs" of BOTH "test" and "test:coverage" in ${s.turboFile} ` +
      `(keep "$TURBO_DEFAULT$" first)`,
    repairJson: { file: s.turboFile, tasks: [...TEST_TASKS], key: "inputs", add },
  };
}

/**
 * Classify one observed filesystem input. Returns null when the hash covers
 * it, else the violation with its repair.
 */
export function classifyPath(s: Surface, path: string, kind: ObsKind): Violation | null {
  const abs = resolve(path);
  const r = real(abs) ?? abs;
  const root = real(s.root) ?? s.root;
  const tmp = real(tmpdir()) ?? tmpdir();
  if (!inside(r, root) && !inside(abs, s.root)) {
    // Outside the repo: temp files the test made, the Node install, and the
    // system are the runtime (hashed as MOTEBIT_TEST_RUNTIME). User state is not.
    const home = real(homedir()) ?? homedir();
    if (inside(r, tmp) || inside(r, RUNTIME_DIR) || /[/\\]node_modules[/\\]/.test(r)) return null;
    if (home !== sep && inside(r, home)) {
      return {
        what: `${kind} ${abs}`,
        why: "user state under $HOME — no hash can carry it",
        repair:
          "redirect it to an mkdtemp dir (or HOME/MOTEBIT_CONFIG_DIR at a tmp dir), or mark the package UNCACHED",
        repairJson: { file: s.turboFile, tasks: [...TEST_TASKS], key: "inputs", add: abs },
      };
    }
    return null;
  }
  const rr = relative(root, r).split(sep).join("/");
  const relAbs = join(s.root, rr);
  // The package itself (and its build outputs / caches).
  const pkgReal = real(s.pkgDir) ?? s.pkgDir;
  if (inside(r, pkgReal) && !/[/\\]node_modules[/\\]\.pnpm[/\\]/.test(r)) return null;
  // Ancestors of the package: a probe of a directory on the way up (config
  // discovery) observes nothing but that the directory exists.
  if (kind === "probe" && inside(pkgReal, r)) return null;
  // External packages.
  if (/[/\\]node_modules[/\\]/.test(r)) {
    if (s.lockfileDeclared) return null;
    const seg = /[/\\]node_modules[/\\]([^/\\]+)/.exec(r)![1];
    if (seg.startsWith(".") && seg !== ".pnpm") return null; // .vite / .cache: derived caches
    const id = storeIdOf(r);
    if (id && s.extIds.has(id)) return null;
    return inputRepair(
      s,
      "$TURBO_ROOT$/pnpm-lock.yaml",
      `${kind} ${rr}${id ? ` (${id})` : ""}`,
      id
        ? `${id} is outside ${s.pkgName}'s lockfile closure — it was resolved through another ` +
            `package's dependencies, so a lockfile change to it does not change this task's hash ` +
            `(or declare it as a dependency of ${s.pkgName})`
        : "a node_modules path outside the pnpm store layout",
    );
  }
  const isDir = kind === "readdir" || (existsSync(r) && statSync(r).isDirectory());
  if (covers(s.globalGlobs, relAbs, isDir) || covers(s.inputGlobs, relAbs, isDir)) return null;
  for (const d of s.depDirs) {
    const dr = real(d) ?? d;
    if (inside(r, dr)) return null;
  }
  const add = rr ? `$TURBO_ROOT$/${rr}${isDir ? "/**" : ""}` : "$TURBO_ROOT$/**";
  return inputRepair(
    s,
    add,
    `${kind} ${rr || "."}`,
    "not in the package, a workspace dependency, globalDependencies, or the declared inputs",
  );
}

/**
 * Classify one env read of a var PRESENT in the task's environment. Returns
 * null when it is hashed or reviewed-benign.
 */
export function classifyEnvRead(s: Surface, name: string): Violation | null {
  if (s.hashedEnv.some((p) => envPatternMatches(p, name))) return null;
  const rule = classifyEnv(name);
  if (rule?.class === "benign") return null;
  return {
    what: `env ${name}`,
    why:
      rule?.class === "hash"
        ? "it changes outcomes and must be hashed, but this task does not hash it"
        : "it reaches the task unhashed (turbo pass-through), so a change to it replays the cached result",
    repair: `add "${name}" to "env" of BOTH "test" and "test:coverage" in turbo.json`,
    repairJson: { file: "turbo.json", tasks: [...TEST_TASKS], key: "env", add: name },
  };
}

export function formatViolation(pkg: string, file: string, v: Violation): string {
  return (
    `[input-tracer] ${pkg} ${file}: ${v.what} — outside the turbo task hash: ${v.why}.\n` +
    `  Repair: ${v.repair}.\n` +
    `  REPAIR-JSON ${JSON.stringify(v.repairJson)}`
  );
}
