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
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll } from "vitest";

import { runtimeId } from "./env-policy.js";
import {
  classifyEnvRead,
  classifyPath,
  computeSurface,
  formatViolation,
  gitIgnored,
  uncacheRepair,
  type Surface,
  type Violation,
} from "./input-surface.js";
import { installRecorder, isCreated, newState, type RecorderState } from "./recorder.js";

interface TracerState extends RecorderState {
  surface?: Surface | null;
  surfaceError?: string;
  /** file → does its source use import.meta.glob (cached per worker) */
  globSrc: Map<string, boolean>;
}

const KEY = Symbol.for("motebit.inputTracer");
const g = globalThis as unknown as Record<symbol, TracerState | undefined>;
const state: TracerState = (g[KEY] ??= { ...newState(), globSrc: new Map() });

// ── Per test file ────────────────────────────────────────────────────────

// Under turbo there is no off switch: TURBO_HASH is set for every task, and an
// undeclared MOTEBIT_* var never reaches the task (strict env mode).
const enforce =
  process.env.TURBO_HASH !== undefined || process.env.MOTEBIT_INPUT_TRACER === "enforce";

const worker = (globalThis as { __vitest_worker__?: WorkerState }).__vitest_worker__;
interface WorkerState {
  config?: { root?: string; env?: Record<string, unknown>; globalSetup?: string | string[] };
  providedContext?: unknown;
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

installRecorder(state, { env: true });
state.paths.clear();
state.env.clear();
state.created.clear();
state.spawns.length = 0;
state.enumerations = 0;
state.recording = true;

/** In-repo modules this file evaluated whose SOURCE uses import.meta.glob. */
function globbers(s: Surface, modules: string[]): string[] {
  const out: string[] = [];
  for (const f of modules) {
    if (!f.startsWith(s.root + sep) || /[/\\]node_modules[/\\]/.test(f)) continue;
    if (f.startsWith(join(s.root, "scripts", "test-support") + sep)) continue; // the tracer itself
    let hit = state.globSrc.get(f);
    if (hit === undefined) {
      try {
        hit = /\bimport\.meta\.glob(?:Eager)?\b/.test(
          state.orig.readFileSync!(f, "utf-8") as string,
        );
      } catch {
        hit = false;
      }
      state.globSrc.set(f, hit);
    }
    if (hit) out.push(f);
  }
  return out;
}

afterAll(() => {
  state.recording = false;
  const s = enforce ? surface() : null;
  if (!s || !s.cached) return;
  const modules = [...(worker?.evaluatedModules?.fileToModulesMap?.keys() ?? [])].filter((f) =>
    f.startsWith("/"),
  );
  for (const f of modules) if (!state.paths.has(f)) state.paths.set(f, "module");
  const lines: string[] = [];
  const file = worker?.filepath ? worker.filepath.replace(`${PKG}/`, "") : "(setup)";
  const push = (v: Violation) => lines.push(formatViolation(s.pkgName, file, v));
  const created = (abs: string, real: string | null) => isCreated(state, abs, real);
  for (const [p, kind] of state.paths) {
    const v = classifyPath(s, p, kind, { created });
    if (v) push(v);
  }
  for (const p of gitIgnored(s, state.paths, state.orig))
    push(
      uncacheRepair(
        s,
        `${state.paths.get(p) ?? "list"} ${relative(s.root, p)}`,
        "a git-IGNORED file inside the package — $TURBO_DEFAULT$ hashes only git-visible files; commit it, or generate it in an mkdtemp dir",
      ),
    );
  for (const sp of new Set(state.spawns))
    push(
      uncacheRepair(
        s,
        `spawn ${sp}`,
        "a process / worker thread / fork — its reads, env and binary are outside every hash",
      ),
    );
  if (state.enumerations > 0)
    push(
      uncacheRepair(
        s,
        `process.env enumerated ${state.enumerations}x (spread / Object.keys / entries / assign / a spawn's default env)`,
        "the whole env flows somewhere no read is visible — read vars by name (process.env.NAME)",
      ),
    );
  for (const f of globbers(s, modules))
    push(
      uncacheRepair(
        s,
        `import.meta.glob in ${relative(s.root, f)}`,
        "the set of files a glob matches is not a hashed file — adding one never changes the hash",
      ),
    );
  const setup = worker?.config?.globalSetup;
  if ((Array.isArray(setup) ? setup.length : setup) || Object.keys(provided()).length > 0)
    push(
      uncacheRepair(
        s,
        "vitest globalSetup / provide",
        "globalSetup runs in the main process, where no tracer sees what it reads",
      ),
    );
  // `test.env` in the package's vitest config sets these — the config is hashed.
  const configEnv = new Set(Object.keys(worker?.config?.env ?? {}));
  for (const [k, present] of state.env) {
    if (configEnv.has(k)) continue;
    const v = classifyEnvRead(s, k, present);
    if (v) push(v);
  }
  if (lines.length) {
    throw new Error(
      `${lines.length} input(s) of this cached test are outside its turbo task hash — a change to ` +
        `any of them would replay a stale result.\n${[...new Set(lines)].join("\n")}\n` +
        `(docs/ops/RUNBOOK.md § "Test results are cached too")`,
    );
  }
});

function provided(): Record<string, unknown> {
  const pc = worker?.providedContext;
  if (!pc) return {};
  if (typeof pc === "string") {
    try {
      const v = JSON.parse(pc) as unknown;
      return Array.isArray(v) && v[0] && typeof v[0] === "object"
        ? (v[0] as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  return pc as Record<string, unknown>;
}
