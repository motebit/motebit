/**
 * Canonical endpoint paths for the runtime-host election (node hosts).
 *
 * One endpoint per machine per home directory: a unix domain socket at
 * `~/.motebit/runtime.sock` (mode 0600), or a named pipe on Windows
 * (no filesystem entry; the pipe name is derived from the home dir so
 * two Windows users never collide). The PID lockfile sits next to the
 * socket as advisory metadata — the bind is the truth, the lock only
 * speeds up stale-socket detection.
 *
 * Node-only (homedir + hashing); non-node hosts construct the same
 * shape from their platform's home directory (the desktop's Rust side
 * reports it).
 */
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import type { RuntimeHostPaths } from "./paths-shared.js";

/**
 * Practical `sun_path` ceiling for unix domain sockets. macOS caps at 104
 * bytes, Linux at 108; binding beyond it truncates or fails with errors
 * that blame the wrong thing (witnessed 2026-07-31, #512: a deep
 * `MOTEBIT_CONFIG_DIR` produced a truncated bind followed by a chmod
 * ENOENT that surfaced as "incompatible build"). Fail LOUD at path
 * construction instead.
 */
const MAX_UNIX_SOCKET_PATH = 100;

/**
 * Resolve the runtime-host endpoint for an explicit config-root directory
 * (#512). The config root and the election root are ONE concept: a
 * process whose identity/config lives in `<dir>` must elect on
 * `<dir>/runtime.sock` — deriving the socket from `homedir()` while the
 * config dir was overridden attached a DIFFERENT sovereign's sandbox to
 * the user's live coordinator (an identity category error, not a
 * convenience bug). Callers with a `MOTEBIT_CONFIG_DIR`-style override
 * pass it here; `defaultRuntimeHostPaths` delegates with the default
 * root.
 *
 * Throws on unix socket paths beyond the OS `sun_path` limit — the
 * repair is a shorter config dir, and the error says so.
 */
export function runtimeHostPathsForDir(
  dir: string,
  platform: NodeJS.Platform = process.platform,
): RuntimeHostPaths {
  if (platform === "win32") {
    const tag = createHash("sha256").update(dir).digest("hex").slice(0, 16);
    return {
      socketPath: `\\\\.\\pipe\\motebit-runtime-${tag}`,
      lockfilePath: join(dir, "runtime.lock"),
    };
  }
  const socketPath = join(dir, "runtime.sock");
  if (socketPath.length > MAX_UNIX_SOCKET_PATH) {
    throw new Error(
      `runtime-host socket path is ${socketPath.length} chars — over the OS unix-socket limit (~104). ` +
        `The config directory is too deep for a socket: use a shorter MOTEBIT_CONFIG_DIR (e.g. under /tmp). ` +
        `Path: ${socketPath}`,
    );
  }
  return {
    socketPath,
    lockfilePath: join(dir, "runtime.lock"),
  };
}

/**
 * Resolve the canonical endpoint for a home directory. Both arguments
 * are injectable for tests; production callers pass nothing.
 */
export function defaultRuntimeHostPaths(
  home: string = homedir(),
  platform: NodeJS.Platform = process.platform,
): RuntimeHostPaths {
  return runtimeHostPathsForDir(join(home, ".motebit"), platform);
}
