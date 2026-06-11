/**
 * Advisory PID lockfile next to the runtime-host socket.
 *
 * The lock never decides the election — the socket bind does. It exists
 * so a process facing a connect-refused socket can distinguish "stale
 * file from a crashed coordinator" (dead PID → take over) from "live
 * coordinator mid-boot" (live PID → retry before takeover).
 *
 * All I/O goes through the injected `RuntimeHostPlatform` so this logic
 * runs identically under node and the desktop's Tauri bridge.
 */
import type { RuntimeHostPlatform } from "./transport.js";

export interface LockfileRecord {
  pid: number;
  bound_at: number;
  protocol_version: number;
}

/** Read + parse the lockfile; null on absence or any malformation. */
export async function readLockfile(
  platform: RuntimeHostPlatform,
  path: string,
): Promise<LockfileRecord | null> {
  const raw = await platform.readFile(path);
  if (raw === null) return null;
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

/** Write the lockfile (0600 via the platform). */
export async function writeLockfile(
  platform: RuntimeHostPlatform,
  path: string,
  record: LockfileRecord,
): Promise<void> {
  await platform.writeFile(path, `${JSON.stringify(record)}\n`);
}

/**
 * Remove the lockfile, but only if it still names `pid` — a coordinator
 * shutting down must not delete a successor's lock.
 */
export async function removeLockfile(
  platform: RuntimeHostPlatform,
  path: string,
  pid: number,
): Promise<void> {
  const current = await readLockfile(platform, path);
  if (current !== null && current.pid !== pid) return;
  try {
    await platform.removeFile(path);
  } catch {
    // Best-effort: a stale lock is recoverable by the PID probe.
  }
}
