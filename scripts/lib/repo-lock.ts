/**
 * repo-lock — a waiting, per-worktree mutex for a gate that writes transient
 * files into the working tree (check-tests-typechecked's canaries): a second
 * run WAITS (async, bounded) instead of racing it.
 *
 * Why: two concurrent check-tests-typechecked runs corrupted each other — run
 * A's tsc globbed run B's canary, B deleted it before A's tsc read it, and
 * A's `&&` chain stopped on TS6053 before A's own canaries were reported (a
 * false RED, 2026-09-30 round-5 review).
 *
 * Mechanics: `mkdir` of `<git-dir>/<name>.lock` is the atomic acquire; the
 * holder writes `owner.json` { pid, host, run } (run = a random token) and
 * then keeps a heartbeat file `beat` = "<run> <counter>", rewritten every
 * `heartbeatMs` with the counter incremented.
 *
 * Liveness is decided from the holder's token and heartbeat, never from a
 * clock comparison (no process start-time window, no wall-clock age):
 *
 * - a holder on this host whose pid is dead is stale at once;
 * - otherwise the waiter watches the (token, beat) signature on its OWN
 *   monotonic clock: a holder is live while that signature keeps changing,
 *   and stale once it has not changed for `staleMs`. A reused pid (alive, but
 *   not the holder) never beats, so it goes stale; a wall-clock jump on
 *   either side changes nothing, since no timestamp is compared; a holder on
 *   another host is judged by its beat alone.
 * - a lock dir with no owner.json yet (a holder mid-acquire) is judged the
 *   same way: stale only if it stays ownerless for `staleMs`.
 *
 * Reclaim is serialised by a second `mkdir` (`.reclaim`) and removes the lock
 * only if, re-read under it, the signature is still the one judged stale — so
 * two waiters never both delete a fresh lock. Released in `finally` and on
 * exit (the caller's signal handlers reach it through `process.exit`);
 * release removes only a lock whose owner.json still carries this run's token.
 *
 * Duplication, noted for consolidation: scripts/lib/probe-lock.ts is the
 * repo's other lock (O_EXCL file, refuses rather than waits, pid-only
 * staleness), and branch fix/relay-test-x402-teardown carries a third
 * (scripts/__tests__/repo-file-mutation.ts). One waiting lock helper should
 * replace all three once that branch lands.
 */

import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join, resolve } from "node:path";

export interface LockOwner {
  pid: number;
  host: string;
  /** Random per-acquire token; the heartbeat carries it. */
  run: string;
}

export interface LockOptions {
  /** How long to wait for another holder before giving up. */
  budgetMs: number;
  /** A holder whose (token, beat) signature has not changed for this long is stale. */
  staleMs?: number;
  /** How often the holder beats. Must be well below staleMs. */
  heartbeatMs?: number;
  /** Poll interval (jittered ±50%). */
  pollMs?: number;
  /** The waiter's monotonic clock, ms (tests inject one). */
  now?: () => number;
}

const SELF_HOST = hostname();

/** The lock directory for `root`: in its git dir, else in tmpdir keyed by the path. */
export function lockPath(root: string, name: string): string {
  const r = spawnSync("git", ["rev-parse", "--absolute-git-dir"], { cwd: root, encoding: "utf-8" });
  if (r.status === 0 && r.stdout.trim()) return join(r.stdout.trim(), `${name}.lock`);
  const h = createHash("sha256").update(resolve(root)).digest("hex").slice(0, 16);
  return join(tmpdir(), `${name}-${h}.lock`);
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function readOwner(dir: string): LockOwner | null {
  try {
    return JSON.parse(readFileSync(join(dir, "owner.json"), "utf-8")) as LockOwner;
  } catch {
    return null;
  }
}

function readBeat(dir: string): string | null {
  try {
    return readFileSync(join(dir, "beat"), "utf-8");
  } catch {
    return null;
  }
}

function exists(p: string): boolean {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
}

/** What a waiter remembers about the holder it is watching. */
export interface Observation {
  sig: string | null;
  since: number;
}

/**
 * Judge the lock at `dir` (pure in its inputs: the owner record, the beat, a
 * pid probe and the waiter's monotonic `now`). Updates `obs`; returns the
 * signature judged and whether it is stale.
 */
export function assess(
  owner: LockOwner | null,
  beat: string | null,
  obs: Observation,
  now: number,
  staleMs: number,
  alive: (pid: number) => boolean = pidAlive,
): { sig: string; stale: boolean } {
  const sig = JSON.stringify([owner, beat]);
  if (owner && owner.host === SELF_HOST && !alive(owner.pid)) return { sig, stale: true };
  if (sig !== obs.sig) {
    obs.sig = sig;
    obs.since = now;
    return { sig, stale: false };
  }
  return { sig, stale: now - obs.since >= staleMs };
}

/** Remove `dir` if, re-read under the reclaim mutex, its signature is still `judged`. */
function reclaim(dir: string, judged: string): void {
  const guard = `${dir}.reclaim`;
  try {
    mkdirSync(guard);
  } catch {
    // Another waiter is reclaiming; if its guard outlives a crash, the
    // guard's own (wall-clock) age is the only signal left — an hour.
    try {
      if (Date.now() - statSync(guard).mtimeMs > 60 * 60 * 1000) {
        rmSync(guard, { recursive: true, force: true });
      }
    } catch {
      /* gone */
    }
    return;
  }
  try {
    if (exists(dir) && JSON.stringify([readOwner(dir), readBeat(dir)]) === judged) {
      rmSync(dir, { recursive: true, force: true });
    }
  } finally {
    rmSync(guard, { recursive: true, force: true });
  }
}

/**
 * Acquire the lock at `dir`, waiting up to `budgetMs`; returns the release
 * function. Throws (naming the holder) when the budget runs out.
 */
export async function acquireRepoLock(dir: string, opts: LockOptions): Promise<() => void> {
  const staleMs = opts.staleMs ?? 15_000;
  const heartbeatMs = opts.heartbeatMs ?? 1_000;
  const pollMs = opts.pollMs ?? 200;
  const now = opts.now ?? (() => performance.now());
  const deadline = now() + opts.budgetMs;
  const obs: Observation = { sig: null, since: now() };
  for (;;) {
    try {
      mkdirSync(dir);
      const me: LockOwner = {
        pid: process.pid,
        host: SELF_HOST,
        run: randomBytes(8).toString("hex"),
      };
      writeFileSync(join(dir, "owner.json"), JSON.stringify(me));
      let counter = 0;
      const beat = (): void => {
        if (readOwner(dir)?.run !== me.run) return; // reclaimed from under us: never beat for another
        const tmp = join(dir, `beat.${me.run}`);
        try {
          writeFileSync(tmp, `${me.run} ${++counter}`);
          renameSync(tmp, join(dir, "beat"));
        } catch {
          /* the lock dir is gone */
        }
      };
      beat();
      const timer = setInterval(beat, heartbeatMs);
      timer.unref();
      let released = false;
      const release = (): void => {
        if (released) return;
        released = true;
        clearInterval(timer);
        process.off("exit", release);
        // only our own lock: never remove one a reclaimer handed to another run
        if (readOwner(dir)?.run === me.run) rmSync(dir, { recursive: true, force: true });
      };
      process.on("exit", release);
      return release;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    const owner = readOwner(dir);
    const { sig, stale } = assess(owner, readBeat(dir), obs, now(), staleMs);
    if (stale) {
      reclaim(dir, sig);
      obs.sig = null;
      obs.since = now();
      continue;
    }
    if (now() >= deadline) {
      throw new Error(
        `${dir} is held by ${owner ? `pid ${owner.pid} on ${owner.host} (run ${owner.run}, heartbeat live)` : "a run still writing its owner record"} and was not released within ${opts.budgetMs}ms`,
      );
    }
    await new Promise((r) => setTimeout(r, pollMs * (0.5 + Math.random())));
  }
}
