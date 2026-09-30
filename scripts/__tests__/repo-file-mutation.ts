/**
 * Gate self-tests that perturb a REAL repo file and run the real gate over the
 * repo — the only honest way to prove a gate still catches what it names —
 * go through here.
 *
 * Two rules, both learned from a race (a pre-push gauntlet killed by
 * `ENOENT … identity-transparency.ts.gate-test-backup` inside check-deps's
 * self-test while every test passed alone):
 *
 *  1. **The backup never sits in the repo.** `check-spec-routes.test.ts` kept
 *     `<target>.gate-test-backup` beside its target in `services/relay/src`,
 *     so a concurrently running gate's tree walk listed the backup, then
 *     `lstat`ed it after it was deleted. Backups go to a fresh `mkdtemp`
 *     directory outside the tree.
 *  2. **One perturbation of the repo at a time, and no gate run over a
 *     perturbed repo.** Two self-tests running at once (two `test:gates` —
 *     a pre-push hook beside a lane's own run) saw each other's mutated
 *     files, collided on each other's backups, and could "restore" a target
 *     from a backup of an already-mutated file, leaving the repo corrupted.
 *     A cross-process lock (an atomic `mkdir` in the OS temp dir, keyed by
 *     the repo root) serializes every perturb → run → restore and every
 *     clean run in these self-tests.
 *
 * Harness: `scripts/__tests__/gate-test-mutation-race.harness.ts` runs the
 * perturbing self-tests concurrently 10× and requires every run green and
 * the repo byte-identical afterwards.
 */
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const LOCK_DIR = join(
  tmpdir(),
  `motebit-gate-self-test-lock-${createHash("sha256").update(ROOT).digest("hex").slice(0, 12)}`,
);
const OWNER = join(LOCK_DIR, "owner");
/** Longer than any single perturb → gate run → restore under a loaded pre-push. */
const LOCK_WAIT_MS = 10 * 60_000;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function ownerPid(): number | null {
  try {
    const pid = Number(readFileSync(OWNER, "utf8"));
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null; // not written yet (the owner is between mkdir and write) — treat as live
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

let depth = 0;

/** Run `fn` holding the repo-perturbation lock (re-entrant within a process). */
export function withRepoLock<T>(fn: () => T): T {
  if (depth > 0) {
    depth++;
    try {
      return fn();
    } finally {
      depth--;
    }
  }
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      mkdirSync(LOCK_DIR);
      writeFileSync(OWNER, String(process.pid));
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const pid = ownerPid();
      if (pid !== null && !isAlive(pid) && ownerPid() === pid) {
        // A self-test process died holding the lock: break it.
        rmSync(LOCK_DIR, { recursive: true, force: true });
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error(
          `gate self-test lock ${LOCK_DIR} held by pid ${pid ?? "?"} for over ${LOCK_WAIT_MS / 1000}s — ` +
            `if no gate self-test is running, remove the directory and re-run.`,
        );
      }
      sleepSync(50);
    }
  }
  depth = 1;
  try {
    return fn();
  } finally {
    depth = 0;
    rmSync(LOCK_DIR, { recursive: true, force: true });
  }
}

/**
 * Run `fn` with the repo file at `absPath` replaced by `next` (a string, or a
 * function of the original), under the lock; the original is restored
 * byte-for-byte from a backup kept OUTSIDE the repo.
 */
export function withRepoFileReplaced<T>(
  absPath: string,
  next: string | ((original: string) => string),
  fn: () => T,
): T {
  return withRepoLock(() => {
    const dir = mkdtempSync(join(tmpdir(), "motebit-gate-self-test-"));
    const backup = join(dir, basename(absPath));
    cpSync(absPath, backup);
    const original = readFileSync(backup);
    let result: T;
    try {
      writeFileSync(absPath, typeof next === "string" ? next : next(original.toString("utf8")));
      result = fn();
    } finally {
      cpSync(backup, absPath);
      rmSync(dir, { recursive: true, force: true });
    }
    // Guard the guard, still under the lock: the restore is byte-for-byte.
    if (!readFileSync(absPath).equals(original)) {
      throw new Error(`gate self-test failed to restore ${absPath} — git checkout -- it`);
    }
    return result;
  });
}
