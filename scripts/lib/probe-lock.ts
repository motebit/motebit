/**
 * probe-lock — mutual exclusion between anything that PERTURBS the working
 * tree (check-gates-effective, check-activation-effective: they write probe
 * fixtures and rewrite real files such as coverage-graduation.json for the
 * duration of a probe) and anything that READS it as truth (`pnpm check`).
 *
 * Why a lock and not a note: on 2026-09-15 `pnpm check` and
 * `check-gates-effective` were run concurrently; the coverage-graduation
 * probe back-dated `@motebit/verify`'s target to 2020-01-01 for a few
 * seconds and the parallel suite reported a phantom "2449d overdue"
 * commitment. Cleanup was correct; isolation was not. A process that reads
 * files a probe may be mutating must not be able to start while the probe
 * runs, and vice versa — and that has to be enforced, not remembered.
 *
 * Mechanics: one lock file at the repo root, created with O_EXCL so
 * acquisition is atomic; contents name the holder and its pid. A lock
 * whose pid is gone is stale and reclaimed. Children spawned by the holder
 * inherit `MOTEBIT_GATE_LOCK_PID` and skip acquisition (the gate runner
 * spawns one process per gate). Released on normal exit and on
 * SIGINT/SIGTERM.
 */

import { existsSync, openSync, writeSync, closeSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";

export const GATE_LOCK_FILE = ".motebit-gate.lock";
export const GATE_LOCK_ENV = "MOTEBIT_GATE_LOCK_PID";

interface LockRecord {
  pid: number;
  holder: string;
  startedAt: string;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readRecord(path: string): LockRecord | null {
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as LockRecord;
  } catch {
    return null;
  }
}

/**
 * Acquire the repo-wide gate lock or exit 2 with a repair instruction naming
 * the current holder. Returns a release function; also releases on exit
 * and on SIGINT/SIGTERM. Re-entrant through `MOTEBIT_GATE_LOCK_PID` for
 * processes the holder spawns.
 */
export function acquireGateLock(root: string, holder: string): () => void {
  const inherited = process.env[GATE_LOCK_ENV];
  if (inherited != null && inherited !== "") return () => {};
  const path = join(root, GATE_LOCK_FILE);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, "wx");
      const record: LockRecord = { pid: process.pid, holder, startedAt: new Date().toISOString() };
      writeSync(fd, JSON.stringify(record));
      closeSync(fd);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const existing = readRecord(path);
      if (existing != null && pidAlive(existing.pid)) {
        process.stderr.write(
          `✗ ${holder}: refusing to start — \`${existing.holder}\` (pid ${existing.pid}, since ${existing.startedAt}) holds ${GATE_LOCK_FILE}.\n` +
            `  Effectiveness probes MUTATE real files (probe fixtures, coverage-graduation.json, …) while they run;\n` +
            `  a concurrent reader would judge a planted violation as real (2026-09-15: a phantom overdue commitment).\n` +
            `  Fix: wait for that run to finish, or stop it — never delete the lock while its pid is alive.\n` +
            `  If the pid is dead the lock is stale and is reclaimed automatically on the next start.\n`,
        );
        process.exit(2);
      }
      // Stale: holder is gone. Reclaim and retry once.
      try {
        unlinkSync(path);
      } catch {
        /* raced with another reclaimer */
      }
    }
  }
  process.env[GATE_LOCK_ENV] = String(process.pid);
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    const current = readRecord(path);
    if (current?.pid === process.pid && existsSync(path)) {
      try {
        unlinkSync(path);
      } catch {
        /* best-effort */
      }
    }
  };
  process.on("exit", release);
  process.on("SIGINT", () => {
    release();
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    release();
    process.exit(143);
  });
  return release;
}
