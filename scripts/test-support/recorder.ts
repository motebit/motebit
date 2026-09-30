/**
 * The observation layer shared by the runtime input tracer (input-tracer.ts,
 * inside each test worker) and the config-phase tracer (config-tracer.ts,
 * inside the vitest main process while the config evaluates).
 *
 * `installRecorder` patches, once per realm, the CJS objects behind `node:fs`,
 * `fs/promises`, `child_process`, `worker_threads` and `cluster` (and syncs the
 * ESM named exports), and replaces `process.env` with a Proxy. While
 * `state.recording` is on it records:
 *
 *   - every filesystem read / probe / listing, with its kind;
 *   - every path the code itself CREATED (mkdtemp, a mkdir that made the
 *     directory, a file opened for writing) — tmp content is an input unless
 *     the test made it;
 *   - every process spawn, Worker construction and cluster fork;
 *   - every read of an env var (get / has / getOwnPropertyDescriptor), present
 *     or not, unless the code wrote the var first;
 *   - every ENUMERATION of process.env (ownKeys) — a spread, Object.keys, a
 *     spawn's default env: the whole env flows somewhere no read is visible.
 */
import * as fs from "node:fs";
import * as nodeModule from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import type { ObsKind } from "./input-surface.js";

export type { ObsKind };

export interface RecorderState {
  installed: boolean;
  recording: boolean;
  paths: Map<string, ObsKind>;
  /** Absolute paths (as given and realpath'd) the code created while recording. */
  created: Set<string>;
  /** Human-readable description of every spawn / Worker / fork while recording. */
  spawns: string[];
  /** Env var name → was it present when read. */
  env: Map<string, boolean>;
  /** How many times process.env was enumerated while recording. */
  enumerations: number;
  written: Set<string>;
  /** Originals, for the tracer's own git / fs work (never recorded). */
  orig: {
    spawnSync?: typeof import("node:child_process").spawnSync;
    readFileSync?: typeof fs.readFileSync;
    readdirSync?: typeof fs.readdirSync;
    existsSync?: typeof fs.existsSync;
    realpathSync?: typeof fs.realpathSync;
    statSync?: typeof fs.statSync;
  };
  env0?: NodeJS.ProcessEnv;
}

export function newState(): RecorderState {
  return {
    installed: false,
    recording: false,
    paths: new Map(),
    created: new Set(),
    spawns: [],
    env: new Map(),
    enumerations: 0,
    written: new Set(),
    orig: {},
  };
}

const RANK: Record<ObsKind, number> = { probe: 0, module: 1, readdir: 2, exec: 3, read: 4 };

function toPath(p: unknown): string | null {
  let s: string | null = null;
  if (typeof p === "string") s = p;
  else if (p && typeof p === "object" && typeof (p as { href?: unknown }).href === "string") {
    const href = (p as { href: string }).href; // a URL, whichever realm's
    s = href.startsWith("file:") ? href : null;
  } else if (Buffer.isBuffer(p)) s = p.toString();
  if (!s || s.startsWith("data:") || s.startsWith("node:")) return null;
  if (s.startsWith("file:")) s = fileURLToPath(s);
  return s;
}

export function note(state: RecorderState, p: unknown, kind: ObsKind, cwd?: string): void {
  if (!state.recording) return;
  const s = toPath(p);
  if (s === null) return;
  const abs = resolve(cwd ?? process.cwd(), s);
  const prev = state.paths.get(abs);
  if (prev === undefined || RANK[kind] > RANK[prev]) state.paths.set(abs, kind);
}

function markCreated(state: RecorderState, p: unknown): void {
  if (!state.recording) return;
  const s = toPath(p);
  if (s === null) return;
  const abs = resolve(s);
  state.created.add(abs);
  try {
    state.created.add(state.orig.realpathSync!(abs));
  } catch {
    try {
      state.created.add(
        resolve(state.orig.realpathSync!(dirname(abs)), abs.slice(dirname(abs).length + 1)),
      );
    } catch {
      /* the parent vanished — the given path is recorded */
    }
  }
}

// ── Patching ─────────────────────────────────────────────────────────────

const FS_READ = [
  "readFileSync",
  "readFile",
  "createReadStream",
  "copyFileSync",
  "copyFile",
  "cpSync",
  "cp",
  "readlinkSync",
  "readlink",
] as const;
const FS_OPEN = ["openSync", "open"] as const;
const FS_DIR = ["readdirSync", "readdir", "opendirSync", "opendir"] as const;
const FS_PROBE = [
  "statSync",
  "stat",
  "lstatSync",
  "lstat",
  "existsSync",
  "exists",
  "accessSync",
  "access",
  "realpathSync",
  "realpath",
] as const;
const FS_WRITE = [
  "writeFileSync",
  "writeFile",
  "createWriteStream",
  "appendFileSync",
  "appendFile",
] as const;
const PROMISE_READ = ["readFile", "copyFile", "cp", "readlink"] as const;
const PROMISE_DIR = ["readdir", "opendir"] as const;
const PROMISE_PROBE = ["stat", "lstat", "access", "realpath"] as const;
const PROMISE_WRITE = ["writeFile", "appendFile"] as const;
const SPAWN = [
  "spawn",
  "spawnSync",
  "execFile",
  "execFileSync",
  "fork",
  "exec",
  "execSync",
] as const;

type AnyFn = (...a: unknown[]) => unknown;

/**
 * Replace `obj[name]` with `before(args)` + the original (+ `after(result,
 * args)`), keeping every own property of the original (realpathSync.native,
 * util.promisify.custom — the promisified exec/execFile resolve to
 * `{ stdout, stderr }` only through it).
 */
export function patch(
  obj: Record<string, unknown>,
  name: string,
  before: (a: unknown[]) => void,
  after?: (r: unknown, a: unknown[]) => void,
): void {
  const orig = obj[name] as AnyFn | undefined;
  if (typeof orig !== "function" || (orig as { __traced?: boolean }).__traced) return;
  const w = function (this: unknown, ...a: unknown[]) {
    before(a);
    const r = orig.apply(this, a);
    if (after) after(r, a);
    return r;
  };
  for (const key of Reflect.ownKeys(orig)) {
    if (key === "length" || key === "name" || key === "prototype") continue;
    const d = Object.getOwnPropertyDescriptor(orig, key)!;
    if (key === promisify.custom && typeof d.value === "function") {
      const custom = d.value as AnyFn;
      d.value = function (this: unknown, ...a: unknown[]) {
        before(a);
        return custom.apply(this, a);
      };
    }
    Object.defineProperty(w, key, d);
  }
  Object.defineProperty(w, "__traced", { value: true });
  obj[name] = w;
}

const isWriteFlag = (f: unknown): boolean =>
  typeof f === "string" ? /[wax]/.test(f) : typeof f === "number" && (f & 3) !== 0;

function describeSpawn(name: string, a: unknown[]): string {
  const parts = [a[0], ...(Array.isArray(a[1]) ? a[1] : [])]
    .filter((x) => typeof x === "string")
    .map((x) => (x as string).slice(0, 80));
  return `${name}(${parts.join(" ")})`;
}

export interface InstallOpts {
  /** Replace process.env with the recording Proxy. */
  env: boolean;
}

export function installRecorder(state: RecorderState, opts: InstallOpts): void {
  if (state.installed) return;
  state.installed = true;
  const req = nodeModule.createRequire(import.meta.url);
  const cjsFs = req("node:fs") as Record<string, unknown>;
  state.orig = {
    readFileSync: cjsFs.readFileSync as typeof fs.readFileSync,
    readdirSync: cjsFs.readdirSync as typeof fs.readdirSync,
    existsSync: cjsFs.existsSync as typeof fs.existsSync,
    realpathSync: cjsFs.realpathSync as typeof fs.realpathSync,
    statSync: cjsFs.statSync as typeof fs.statSync,
  };
  const wrap = (o: Record<string, unknown>, names: readonly string[], kind: ObsKind) => {
    for (const n of names) patch(o, n, (a) => note(state, a[0], kind));
  };
  const wrapWrite = (o: Record<string, unknown>, names: readonly string[]) => {
    for (const n of names)
      patch(
        o,
        n,
        () => undefined,
        (_r, a) => markCreated(state, a[0]),
      );
  };
  const wrapOpen = (o: Record<string, unknown>, names: readonly string[]) => {
    for (const n of names)
      patch(
        o,
        n,
        (a) => {
          if (!isWriteFlag(a[1])) note(state, a[0], "read");
        },
        (_r, a) => {
          if (isWriteFlag(a[1])) markCreated(state, a[0]);
        },
      );
  };
  // mkdtemp: the returned directory is the test's own.
  const wrapMkdtemp = (
    o: Record<string, unknown>,
    name: string,
    kind: "sync" | "cb" | "promise",
  ) => {
    const orig = o[name] as AnyFn | undefined;
    if (typeof orig !== "function" || (orig as { __traced?: boolean }).__traced) return;
    let w: AnyFn;
    if (kind === "sync")
      w = function (this: unknown, ...a: unknown[]) {
        const r = orig.apply(this, a);
        markCreated(state, r);
        return r;
      };
    else if (kind === "promise")
      w = function (this: unknown, ...a: unknown[]) {
        return (orig.apply(this, a) as Promise<string>).then((r) => {
          markCreated(state, r);
          return r;
        });
      };
    else
      w = function (this: unknown, ...a: unknown[]) {
        const cb = a[a.length - 1];
        if (typeof cb === "function")
          a[a.length - 1] = (err: unknown, dir: string) => {
            if (!err) markCreated(state, dir);
            (cb as AnyFn)(err, dir);
          };
        return orig.apply(this, a);
      };
    Object.defineProperty(w, "__traced", { value: true });
    o[name] = w;
  };
  // mkdir: recursive returns the FIRST directory it created (undefined when
  // it created none); non-recursive succeeds only by creating it.
  const wrapMkdir = (o: Record<string, unknown>, name: string, promise: boolean) =>
    patch(
      o,
      name,
      () => undefined,
      (r, a) => {
        const recursive =
          typeof a[1] === "object" && a[1] !== null && (a[1] as { recursive?: boolean }).recursive;
        const mark = (first: unknown) => {
          // Recursive: everything under the first directory it created is new.
          if (recursive) {
            if (typeof first === "string") markCreated(state, first);
          } else markCreated(state, a[0]);
        };
        if (promise) void (r as Promise<unknown>).then(mark, () => undefined);
        else if (name === "mkdirSync") mark(r);
      },
    );

  for (const o of [cjsFs]) {
    wrap(o, FS_READ, "read");
    wrapOpen(o, FS_OPEN);
    wrap(o, FS_DIR, "readdir");
    wrap(o, FS_PROBE, "probe");
    wrapWrite(o, FS_WRITE);
    wrapMkdtemp(o, "mkdtempSync", "sync");
    wrapMkdtemp(o, "mkdtemp", "cb");
    wrapMkdir(o, "mkdirSync", false);
  }
  const promises = cjsFs.promises as Record<string, unknown>;
  wrap(promises, PROMISE_READ, "read");
  wrap(promises, PROMISE_DIR, "readdir");
  wrap(promises, PROMISE_PROBE, "probe");
  wrapOpen(promises, ["open"]);
  wrapWrite(promises, PROMISE_WRITE);
  wrapMkdtemp(promises, "mkdtemp", "promise");
  wrapMkdir(promises, "mkdir", true);

  // Processes, threads, forks: every one is recorded — its reads and its env
  // are outside every hash, whatever its arguments look like.
  const cp = req("node:child_process") as Record<string, unknown>;
  state.orig.spawnSync = cp.spawnSync as typeof import("node:child_process").spawnSync;
  for (const n of SPAWN) {
    patch(cp, n, (a) => {
      if (!state.recording) return;
      state.spawns.push(describeSpawn(n, a));
      // Path-shaped arguments are still recorded as inputs (the repair names them).
      const args = [a[0], ...(Array.isArray(a[1]) ? a[1] : [])];
      const o = (Array.isArray(a[1]) ? a[2] : a[1]) as { cwd?: string } | undefined;
      for (const t of args)
        if (typeof t === "string" && /[/\\]/.test(t) && t !== process.execPath)
          note(state, t, "exec", typeof o?.cwd === "string" ? o.cwd : undefined);
    });
  }
  const wt = req("node:worker_threads") as Record<string, unknown>;
  const OrigWorker = wt.Worker as new (...a: unknown[]) => object;
  if (!(OrigWorker as { __traced?: boolean }).__traced) {
    const Traced = class extends (OrigWorker as new (...a: unknown[]) => object) {
      constructor(...a: unknown[]) {
        if (state.recording)
          state.spawns.push(
            `new Worker(${typeof a[0] === "string" ? a[0].slice(0, 80) : String(a[0])})`,
          );
        super(...a);
      }
    };
    Object.defineProperty(Traced, "__traced", { value: true });
    Object.defineProperty(Traced, "name", { value: "Worker" });
    wt.Worker = Traced;
  }
  const cluster = req("node:cluster") as Record<string, unknown>;
  patch(cluster, "fork", () => {
    if (state.recording) state.spawns.push("cluster.fork()");
  });
  nodeModule.syncBuiltinESMExports();

  if (!opts.env) return;
  // Env: every named read (present or absent) unless written first; every
  // enumeration. There is no "enumerating" skip: a whole-env copy moves every
  // var somewhere a later read cannot be seen.
  const noteEnv = (t: NodeJS.ProcessEnv, k: string | symbol): void => {
    if (typeof k !== "string" || !state.recording || state.written.has(k)) return;
    if (!state.env.has(k)) state.env.set(k, Reflect.has(t, k));
    if (debugVar === k) console.error(new Error(`[input-tracer] env read ${k}`).stack);
  };
  const target = process.env;
  const debugVar = target.MOTEBIT_TRACER_DEBUG;
  state.env0 = target;
  process.env = new Proxy(target, {
    get(t, k, r) {
      noteEnv(t, k);
      return Reflect.get(t, k, r);
    },
    has(t, k) {
      noteEnv(t, k);
      return Reflect.has(t, k);
    },
    getOwnPropertyDescriptor(t, k) {
      noteEnv(t, k);
      return Reflect.getOwnPropertyDescriptor(t, k);
    },
    ownKeys(t) {
      if (state.recording) state.enumerations++;
      return Reflect.ownKeys(t);
    },
    set(t, k, v) {
      if (typeof k === "string") state.written.add(k);
      return Reflect.set(t, k, v);
    },
    defineProperty(t, k, d) {
      if (typeof k === "string") state.written.add(k);
      return Reflect.defineProperty(t, k, d);
    },
    deleteProperty(t, k) {
      if (typeof k === "string") state.written.add(k);
      return Reflect.deleteProperty(t, k);
    },
  });
}

/** Is `p` (absolute) one of — or under one of — the paths the code created? */
export function isCreated(state: RecorderState, p: string, real?: string | null): boolean {
  for (const c of state.created) {
    for (const x of [p, real]) {
      if (!x) continue;
      if (x === c || x.startsWith(c.endsWith("/") ? c : c + "/")) return true;
    }
  }
  return false;
}
