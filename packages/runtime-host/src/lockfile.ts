/**
 * Advisory PID lockfile next to the runtime-host socket.
 *
 * The lock never decides the election — the socket bind does. It exists
 * so a process facing a connect-refused socket can distinguish "stale
 * file from a crashed coordinator" (dead PID → take over) from "live
 * coordinator mid-boot" (live PID → retry before takeover).
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface LockfileRecord {
  pid: number;
  bound_at: number;
  protocol_version: number;
}

/** Read + parse the lockfile; null on absence or any malformation. */
export function readLockfile(path: string): LockfileRecord | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object") return null;
    const record = parsed as Record<string, unknown>;
    if (
      typeof record.pid !== "number" ||
      typeof record.bound_at !== "number" ||
      typeof record.protocol_version !== "number"
    ) {
      return null;
    }
    return {
      pid: record.pid,
      bound_at: record.bound_at,
      protocol_version: record.protocol_version,
    };
  } catch {
    return null;
  }
}

/** Write the lockfile (0600), creating `~/.motebit` if needed. */
export function writeLockfile(path: string, record: LockfileRecord): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
}

/**
 * Remove the lockfile, but only if it still names `pid` — a coordinator
 * shutting down must not delete a successor's lock.
 */
export function removeLockfile(path: string, pid: number): void {
  const current = readLockfile(path);
  if (current !== null && current.pid !== pid) return;
  try {
    rmSync(path, { force: true });
  } catch {
    // Best-effort: a stale lock is recoverable by the PID probe.
  }
}

/**
 * Liveness probe via signal 0. EPERM means the PID exists under another
 * user — alive for election purposes (we won't be able to take over its
 * socket anyway; 0600 + the signed handshake own the security story).
 */
export function isPidAlive(
  pid: number,
  kill: (pid: number, signal: number) => void = (p, s) => process.kill(p, s),
): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}
