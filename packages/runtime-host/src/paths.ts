/**
 * Canonical endpoint paths for the runtime-host election.
 *
 * One endpoint per machine per home directory: a unix domain socket at
 * `~/.motebit/runtime.sock` (mode 0600), or a named pipe on Windows
 * (no filesystem entry; the pipe name is derived from the home dir so
 * two Windows users never collide). The PID lockfile sits next to the
 * socket as advisory metadata — the bind is the truth, the lock only
 * speeds up stale-socket detection.
 */
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

export interface RuntimeHostPaths {
  /** Unix domain socket path, or `\\.\pipe\...` name on Windows. */
  socketPath: string;
  /** Advisory PID lockfile; always a real file, also on Windows. */
  lockfilePath: string;
}

/**
 * Resolve the canonical endpoint for a home directory. Both arguments
 * are injectable for tests; production callers pass nothing.
 */
export function defaultRuntimeHostPaths(
  home: string = homedir(),
  platform: NodeJS.Platform = process.platform,
): RuntimeHostPaths {
  const dir = join(home, ".motebit");
  if (platform === "win32") {
    const tag = createHash("sha256").update(dir).digest("hex").slice(0, 16);
    return {
      socketPath: `\\\\.\\pipe\\motebit-runtime-${tag}`,
      lockfilePath: join(dir, "runtime.lock"),
    };
  }
  return {
    socketPath: join(dir, "runtime.sock"),
    lockfilePath: join(dir, "runtime.lock"),
  };
}
