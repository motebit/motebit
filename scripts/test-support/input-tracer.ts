/**
 * Runtime input tracer — the law behind cached test results.
 *
 * A cached `test` / `test:coverage` result is valid only if every input that
 * can change its outcome is in the turbo task hash. A static scan of test code
 * can never see every input (template literals, cwd-relative reads, spreads,
 * modules resolved through another package's closure, pass-through env …), so
 * this module WATCHES the test run instead. Registered by vitest.shared.ts as
 * the first setup file of every package (and hashed as a globalDependency), it
 * records, per test file:
 *
 *   - every filesystem read / probe / directory listing (fs and fs/promises);
 *   - every module the worker loads — natively (Node's loaders read through
 *     the patched fs) and vite-transformed (the worker's evaluated-module graph);
 *   - every read of an env var PRESENT in the task environment (a Proxy over
 *     process.env);
 *   - every child process spawned, with its path-shaped arguments.
 *
 * After the file's tests it compares that set with the task's declared hash
 * surface (input-surface.ts) and FAILS the file on anything outside it, with a
 * repair line naming the exact turbo.json entry to add. It also asserts at
 * setup that the runtime the result will be cached for is the runtime running
 * it (MOTEBIT_TEST_RUNTIME, set by scripts/turbo-run.mjs and hashed).
 *
 * Enforced whenever the run is a turbo task (TURBO_HASH is set) of a cached
 * package, or MOTEBIT_INPUT_TRACER=enforce. A bare `vitest run` caches nothing
 * and is only observed. MOTEBIT_TRACER_DEBUG=<VAR> prints the stack of each
 * read of that env var.
 */
import * as fs from "node:fs";
import * as nodeModule from "node:module";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { afterAll } from "vitest";

import { runtimeId } from "./env-policy.js";
import {
  classifyEnvRead,
  classifyPath,
  computeSurface,
  formatViolation,
  type ObsKind,
  type Surface,
} from "./input-surface.js";

interface TracerState {
  installed: boolean;
  recording: boolean;
  paths: Map<string, ObsKind>;
  env: Set<string>;
  initialEnv: Set<string>;
  written: Set<string>;
  surface?: Surface | null;
  surfaceError?: string;
}

const KEY = Symbol.for("motebit.inputTracer");
const DEBUG_ENV = process.env.MOTEBIT_TRACER_DEBUG;
const g = globalThis as unknown as Record<symbol, TracerState | undefined>;
const state: TracerState = (g[KEY] ??= {
  installed: false,
  recording: false,
  paths: new Map(),
  env: new Set(),
  initialEnv: new Set(),
  written: new Set(),
});

const RANK: Record<ObsKind, number> = { probe: 0, module: 1, readdir: 2, exec: 3, read: 4 };

function note(p: unknown, kind: ObsKind, cwd?: string): void {
  if (!state.recording) return;
  let s: string | null = null;
  if (typeof p === "string") s = p;
  else if (p && typeof p === "object" && typeof (p as { href?: unknown }).href === "string") {
    const href = (p as { href: string }).href; // a URL, whichever realm's
    s = href.startsWith("file:") ? href : null;
  } else if (Buffer.isBuffer(p)) s = p.toString();
  if (!s || s.startsWith("data:") || s.startsWith("node:")) return;
  if (s.startsWith("file:")) s = fileURLToPath(s);
  const abs = resolve(cwd ?? process.cwd(), s);
  const prev = state.paths.get(abs);
  if (prev === undefined || RANK[kind] > RANK[prev]) state.paths.set(abs, kind);
}

// ── Installation (once per worker) ───────────────────────────────────────

const FS_READ = [
  "readFileSync",
  "readFile",
  "openSync",
  "open",
  "createReadStream",
  "copyFileSync",
  "copyFile",
  "cpSync",
  "cp",
  "readlinkSync",
  "readlink",
] as const;
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
const PROMISE_READ = ["readFile", "open", "copyFile", "cp", "readlink"] as const;
const PROMISE_DIR = ["readdir", "opendir"] as const;
const PROMISE_PROBE = ["stat", "lstat", "access", "realpath"] as const;

type AnyFn = (...a: unknown[]) => unknown;

/**
 * Replace `obj[name]` with `before(...args)` + the original, keeping every own
 * property of the original (realpathSync.native, util.promisify.custom — the
 * promisified exec/execFile resolve to `{ stdout, stderr }` only through it).
 */
function patch(obj: Record<string, unknown>, name: string, before: (a: unknown[]) => void): void {
  const orig = obj[name] as AnyFn | undefined;
  if (typeof orig !== "function" || (orig as { __traced?: boolean }).__traced) return;
  const w = function (this: unknown, ...a: unknown[]) {
    before(a);
    return orig.apply(this, a);
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

function wrap(obj: Record<string, unknown>, names: readonly string[], kind: ObsKind): void {
  for (const n of names) patch(obj, n, (a) => note(a[0], kind));
}

const SPAWN = ["spawn", "spawnSync", "execFile", "execFileSync", "fork"] as const;
const EXEC = ["exec", "execSync"] as const;

function noteExec(cmd: unknown, args: unknown, opts: unknown): void {
  if (!state.recording) return;
  const cwd =
    opts && typeof opts === "object" && typeof (opts as { cwd?: unknown }).cwd === "string"
      ? (opts as { cwd: string }).cwd
      : undefined;
  const tokens: string[] = [];
  if (typeof cmd === "string") tokens.push(cmd);
  if (Array.isArray(args)) for (const a of args) if (typeof a === "string") tokens.push(a);
  for (const t of tokens) {
    // Path-shaped arguments only: a bare command name is PATH lookup.
    if (!/[/\\]/.test(t) || t === process.execPath) continue;
    const abs = resolve(cwd ?? process.cwd(), t);
    if (fs.existsSync(abs)) note(abs, "exec");
  }
}

function install(): void {
  if (state.installed) return;
  state.installed = true;
  const fsObj = fs as unknown as Record<string, unknown>;
  // `import * as fs` is the ESM namespace; patch the CJS object behind it.
  const cjsFs = nodeModule.createRequire(import.meta.url)("node:fs") as Record<string, unknown>;
  for (const o of [cjsFs, fsObj]) {
    try {
      wrap(o, FS_READ, "read");
      wrap(o, FS_DIR, "readdir");
      wrap(o, FS_PROBE, "probe");
    } catch {
      /* the ESM namespace is read-only — the CJS object is what matters */
    }
  }
  const promises = cjsFs.promises as Record<string, unknown>;
  wrap(promises, PROMISE_READ, "read");
  wrap(promises, PROMISE_DIR, "readdir");
  wrap(promises, PROMISE_PROBE, "probe");
  const cp = nodeModule.createRequire(import.meta.url)("node:child_process") as Record<
    string,
    unknown
  >;
  for (const n of SPAWN) {
    patch(cp, n, (a) =>
      noteExec(a[0], Array.isArray(a[1]) ? a[1] : [], Array.isArray(a[1]) ? a[2] : a[1]),
    );
  }
  for (const n of EXEC) {
    patch(cp, n, (a) => noteExec(null, typeof a[0] === "string" ? a[0].split(/\s+/) : [], a[1]));
  }
  nodeModule.syncBuiltinESMExports();

  // Natively loaded modules (externals, createRequire, require.resolve, native
  // ESM imports) need no hook of their own: on the pinned runtime (.node-version)
  // Node's CJS and ESM loaders read and realpath through the public `fs`
  // patched above, so every one is recorded as a read/probe. A resolve hook
  // (module.registerHooks) was measured to be an equivalent mutant and removed;
  // the stale-cache harness's C5 case goes red if a Node upgrade breaks this.

  // Env: record reads of vars that were PRESENT when the task started.
  for (const k of Object.keys(process.env)) state.initialEnv.add(k);
  // A whole-env copy (`{ ...process.env }`, or spawn's default env) enumerates
  // and then gets every key in the same synchronous turn: that forwards the
  // env, it does not read a var. Reads inside an enumeration turn are skipped.
  let enumerating = false;
  const noteEnv = (k: string | symbol): void => {
    if (typeof k !== "string" || !state.recording || enumerating) return;
    if (!state.initialEnv.has(k) || state.written.has(k)) return;
    state.env.add(k);
    if (DEBUG_ENV === k) console.error(new Error(`[input-tracer] env read ${k}`).stack);
  };
  const target = process.env;
  process.env = new Proxy(target, {
    get(t, k, r) {
      noteEnv(k);
      return Reflect.get(t, k, r);
    },
    has(t, k) {
      noteEnv(k);
      return Reflect.has(t, k);
    },
    ownKeys(t) {
      if (!enumerating) {
        enumerating = true;
        queueMicrotask(() => (enumerating = false));
      }
      return Reflect.ownKeys(t);
    },
    set(t, k, v) {
      if (typeof k === "string") state.written.add(k);
      return Reflect.set(t, k, v);
    },
    deleteProperty(t, k) {
      if (typeof k === "string") state.written.add(k);
      return Reflect.deleteProperty(t, k);
    },
  });
}

// ── Per test file ────────────────────────────────────────────────────────

// Under turbo there is no off switch: TURBO_HASH is set for every task, and an
// undeclared MOTEBIT_* var never reaches the task (strict env mode).
const enforce =
  process.env.TURBO_HASH !== undefined || process.env.MOTEBIT_INPUT_TRACER === "enforce";

const worker = (globalThis as { __vitest_worker__?: WorkerState }).__vitest_worker__;
interface WorkerState {
  config?: { root?: string; env?: Record<string, unknown> };
  filepath?: string;
  evaluatedModules?: { fileToModulesMap?: Map<string, unknown> };
}

// scripts/test-support/ → repo root.
// String-only URL handling: a DOM environment (jsdom, happy-dom) replaces the
// global URL with one Node's fileURLToPath rejects.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PKG = worker?.config?.root ?? process.cwd();

function surface(): Surface | null {
  if (state.surface === undefined) {
    try {
      state.surface = computeSurface(ROOT, PKG);
    } catch (err) {
      state.surface = null;
      state.surfaceError = err instanceof Error ? err.message : String(err);
    }
  }
  return state.surface;
}

if (enforce) {
  const s = surface();
  if (!s) {
    throw new Error(
      `[input-tracer] cannot compute the hash surface of ${PKG}: ${state.surfaceError}. ` +
        `A cached test task must be able to prove its inputs.`,
    );
  }
  if (s.cached) {
    // C1: the runtime this result will be cached under must be the one running it.
    const declared = process.env.MOTEBIT_TEST_RUNTIME;
    if (declared !== runtimeId()) {
      throw new Error(
        `[input-tracer] ${s.pkgName}: MOTEBIT_TEST_RUNTIME is ${declared === undefined ? "unset" : `"${declared}"`} ` +
          `but this run is ${runtimeId()} — the cached result would be replayed for a runtime it never ran on.\n` +
          `  Repair: run tests through the repo entry point (\`pnpm test\`, \`pnpm test:coverage\`, or ` +
          `\`node scripts/turbo-run.mjs run <task>\`), which hashes the running runtime.`,
      );
    }
    // NODE_OPTIONS is consumed at startup, never read — it must be hashed.
    if (process.env.NODE_OPTIONS && !s.hashedEnv.includes("NODE_OPTIONS")) {
      throw new Error(
        `[input-tracer] ${s.pkgName}: NODE_OPTIONS is set but not in the test task hash.\n` +
          `  Repair: add "NODE_OPTIONS" to "env" of BOTH "test" and "test:coverage" in turbo.json.\n` +
          `  REPAIR-JSON ${JSON.stringify({ file: "turbo.json", tasks: ["test", "test:coverage"], key: "env", add: "NODE_OPTIONS" })}`,
      );
    }
  }
}

install();
state.paths.clear();
state.env.clear();
state.recording = true;

afterAll(() => {
  state.recording = false;
  const s = enforce ? surface() : null;
  if (!s || !s.cached) return;
  for (const f of worker?.evaluatedModules?.fileToModulesMap?.keys() ?? []) {
    if (f.startsWith("/") && !state.paths.has(f)) state.paths.set(f, "module");
  }
  const lines: string[] = [];
  const file = worker?.filepath ? worker.filepath.replace(`${PKG}/`, "") : "(setup)";
  for (const [p, kind] of state.paths) {
    const v = classifyPath(s, p, kind);
    if (v) lines.push(formatViolation(s.pkgName, file, v));
  }
  // `test.env` in the package's vitest config sets these — the config is hashed.
  const configEnv = new Set(Object.keys(worker?.config?.env ?? {}));
  for (const k of state.env) {
    if (configEnv.has(k)) continue;
    const v = classifyEnvRead(s, k);
    if (v) lines.push(formatViolation(s.pkgName, file, v));
  }
  if (lines.length) {
    throw new Error(
      `${lines.length} input(s) of this cached test are outside its turbo task hash — a change to ` +
        `any of them would replay a stale result.\n${[...new Set(lines)].join("\n")}\n` +
        `(docs/ops/RUNBOOK.md § "Test results are cached too")`,
    );
  }
});
