/**
 * Config-phase input tracer — L2 for what runs in the vitest MAIN process.
 *
 * The worker tracer (input-tracer.ts) sees only the test worker. A package's
 * vitest config evaluates in the main process (a root file read into `define`,
 * an env var folded into the config), and so do `globalSetup` files (whose
 * results reach tests through `provide` / `inject`). None of that is ever in a
 * worker, so the worker tracer cannot see it.
 *
 * vitest.shared.ts calls `startConfigTrace()` as it is imported — before the
 * importing config's body runs — and `defineMotebitTest` registers
 * `configTracePlugin()`, whose `configResolved` hook ends the trace. Under
 * turbo, for a CACHED package, the run then fails (vitest never starts) on:
 *
 *   - any file read / probe / listing outside the task hash while the config
 *     evaluated (the same classifier as the worker tracer, git-ignored
 *     in-package files included);
 *   - any process spawn or Worker started while it evaluated;
 *   - a `globalSetup` or `provide` in the resolved config.
 *
 * NOT traced here: env. vite and vitest copy the whole of process.env in the
 * main process on every run (an enumeration followed by a read of every
 * key), so a config's own env read is indistinguishable from that plumbing
 * without the "enumerating" skip the worker tracer refuses. Config-time env
 * is therefore L1-only: check-test-hermeticity forbids any env use in a cached
 * package's vitest config (rule config-io).
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  classifyPath,
  computeSurface,
  formatViolation,
  gitIgnored,
  uncacheRepair,
  type Violation,
} from "./input-surface.js";
import { installRecorder, isCreated, newState, type RecorderState } from "./recorder.js";

const KEY = Symbol.for("motebit.configTracer");
const g = globalThis as unknown as Record<symbol, RecorderState | undefined>;
const state: RecorderState = (g[KEY] ??= newState());
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Begin recording (idempotent while recording). */
export function startConfigTrace(): void {
  installRecorder(state, { env: false });
  if (state.recording) return;
  state.paths.clear();
  state.env.clear();
  state.created.clear();
  state.spawns.length = 0;
  state.written.clear();
  state.recording = true;
}

interface ResolvedLike {
  root: string;
  test?: { globalSetup?: string | string[]; provide?: Record<string, unknown> };
}

export function finishConfigTrace(config: ResolvedLike): void {
  const wasRecording = state.recording;
  state.recording = false;
  if (!wasRecording) return;
  const enforce =
    process.env.TURBO_HASH !== undefined || process.env.MOTEBIT_INPUT_TRACER === "enforce";
  if (!enforce) return;
  const s = computeSurface(ROOT, config.root);
  if (!s.cached) return;
  const lines: string[] = [];
  const push = (v: Violation) => lines.push(formatViolation(s.pkgName, "(vitest config)", v));
  const created = (abs: string, real: string | null) => isCreated(state, abs, real);
  for (const [p, kind] of state.paths) {
    const v = classifyPath(s, p, kind, { created });
    if (v) push(v);
  }
  for (const p of gitIgnored(s, state.paths, state.orig))
    push(
      uncacheRepair(
        s,
        `${state.paths.get(p) ?? "list"} ${p}`,
        "a git-IGNORED file inside the package, read while the vitest config evaluated",
      ),
    );
  for (const sp of new Set(state.spawns))
    push(uncacheRepair(s, `spawn ${sp}`, "a process started while the vitest config evaluated"));
  const setup = config.test?.globalSetup;
  if (
    (Array.isArray(setup) ? setup.length : setup) ||
    Object.keys(config.test?.provide ?? {}).length
  )
    push(
      uncacheRepair(
        s,
        "vitest globalSetup / provide",
        "globalSetup runs in the main process, outside every tracer, and its result reaches tests through inject()",
      ),
    );
  if (lines.length)
    throw new Error(
      `${lines.length} input(s) observed while the vitest config of cached ${s.pkgName} evaluated are ` +
        `outside its turbo task hash — a change to any of them would replay a stale result.\n` +
        `${[...new Set(lines)].join("\n")}\n(docs/ops/RUNBOOK.md § "Test results are cached too")`,
    );
}

/** The vite plugin whose `configResolved` ends the config-phase trace. */
export function configTracePlugin(): { name: string; configResolved: (c: ResolvedLike) => void } {
  return { name: "motebit:config-input-tracer", configResolved: finishConfigTrace };
}
