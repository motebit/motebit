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
 * holder writes `owner.json` { pid, host, start (process start, ms), run }.
 * A lock is stale — and reclaimed — when its owner on this host is dead, or
 * its pid now belongs to a process that started at another time (pid reuse),
 * or it is older than `maxAgeMs`; a lock from another host is only reclaimed
 * by age. Reclaim is serialised by a second `mkdir` (`.reclaim`) and re-reads
 * the owner under it, so two waiters never both delete a fresh lock.
 * Released in `finally`, on exit and on SIGINT/SIGTERM/SIGHUP (via the exit
 * handler the caller's signal handlers reach through `process.exit`).
 *
 * Duplication, noted for consolidation: scripts/lib/probe-lock.ts is the
 * repo's other lock (O_EXCL file, refuses rather than waits, pid-only
 * staleness), and branch fix/relay-test-x402-teardown carries a third
 * (scripts/__tests__/repo-file-mutation.ts). One waiting lock helper should
 * replace all three once that branch lands.
 */

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";

export interface LockOwner {
  pid: number;
  host: string;
  /** Process start time, epoch ms. */
  start: number;
  run: string;
}

export interface LockOptions {
  /** How long to wait for another holder before giving up. */
  budgetMs: number;
  /** A lock older than this is stale whatever its owner says. */
  maxAgeMs?: number;
  /** Poll interval (jittered ±50%). */
  pollMs?: number;
}

const SELF: LockOwner = {
  pid: process.pid,
  host: hostname(),
  start: Math.round(performance.timeOrigin),
  run: randomBytes(8).toString("hex"),
};

/** The lock directory for `root`: in its git dir, else in tmpdir keyed by the path. */
export function lockPath(root: string, name: string): string {
  const r = spawnSync("git", ["rev-parse", "--absolute-git-dir"], { cwd: root, encoding: "utf-8" });
  if (r.status === 0 && r.stdout.trim()) return join(r.stdout.trim(), `${name}.lock`);
  const h = createHash("sha256").update(resolve(root)).digest("hex").slice(0, 16);
  return join(tmpdir(), `${name}-${h}.lock`);
}

/** Start time (epoch ms, second resolution) of a live pid, or null when unknown. */
function pidStart(pid: number): number | null {
  const r = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf-8" });
  if (r.status !== 0) return null;
  const t = Date.parse(r.stdout.trim());
  return Number.isFinite(t) ? t : null;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Whether the lock `owner` holds (dir mtime `mtimeMs`) may still be in use. */
export function ownerLive(
  owner: LockOwner | null,
  mtimeMs: number,
  maxAgeMs: number,
  now = Date.now(),
): boolean {
  if (now - mtimeMs > maxAgeMs) return false;
  // mkdir happened but owner.json is not written yet (or unreadable): a
  // holder mid-acquire. Live while young.
  if (owner === null) return now - mtimeMs < 10_000;
  if (owner.host !== SELF.host) return true;
  if (!pidAlive(owner.pid)) return false;
  const started = pidStart(owner.pid);
  // ps unavailable: trust the pid. Otherwise the pid must be the same process
  // (lstart has one-second resolution).
  return started === null || Math.abs(started - owner.start) < 3_000;
}

function readOwner(dir: string): LockOwner | null {
  try {
    return JSON.parse(readFileSync(join(dir, "owner.json"), "utf-8")) as LockOwner;
  } catch {
    return null;
  }
}

function mtimeOf(p: string): number | null {
  try {
    return statSync(p).mtimeMs;
  } catch {
    return null;
  }
}

/** Remove `dir` if (re-read under the reclaim mutex) its holder is still not live. */
function reclaim(dir: string, maxAgeMs: number): void {
  const guard = `${dir}.reclaim`;
  try {
    mkdirSync(guard);
  } catch {
    const m = mtimeOf(guard);
    if (m !== null && Date.now() - m > 10_000) rmSync(guard, { recursive: true, force: true });
    return;
  }
  try {
    const m = mtimeOf(dir);
    if (m !== null && !ownerLive(readOwner(dir), m, maxAgeMs)) {
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
  const maxAgeMs = opts.maxAgeMs ?? 60 * 60 * 1000;
  const pollMs = opts.pollMs ?? 200;
  const deadline = Date.now() + opts.budgetMs;
  for (;;) {
    try {
      mkdirSync(dir);
      writeFileSync(join(dir, "owner.json"), JSON.stringify(SELF));
      let released = false;
      const release = (): void => {
        if (released) return;
        released = true;
        process.off("exit", release);
        // only our own lock: never remove one a reclaimer handed to another run
        if (readOwner(dir)?.run === SELF.run) rmSync(dir, { recursive: true, force: true });
      };
      process.on("exit", release);
      return release;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    const m = mtimeOf(dir);
    if (m !== null && !ownerLive(readOwner(dir), m, maxAgeMs)) {
      reclaim(dir, maxAgeMs);
      continue;
    }
    if (Date.now() >= deadline) {
      const o = readOwner(dir);
      throw new Error(
        `${dir} is held by ${o ? `pid ${o.pid} on ${o.host} (run ${o.run}, started ${new Date(o.start).toISOString()})` : "a run still writing its owner record"} and was not released within ${opts.budgetMs}ms`,
      );
    }
    await new Promise((r) => setTimeout(r, pollMs * (0.5 + Math.random())));
  }
}
