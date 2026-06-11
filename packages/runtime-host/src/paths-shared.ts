/** Endpoint path types shared by every platform (no node imports). */

export interface RuntimeHostPaths {
  /** Unix domain socket path, or `\\.\pipe\...` name on Windows. */
  socketPath: string;
  /** Advisory PID lockfile; always a real file, also on Windows. */
  lockfilePath: string;
}

export function isWindowsPipePath(path: string): boolean {
  return path.startsWith("\\\\.\\pipe\\");
}
