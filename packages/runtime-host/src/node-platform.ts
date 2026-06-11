/**
 * Node implementation of the runtime-host platform: unix domain
 * sockets (Windows: named pipes) via node:net, lockfile + takeover
 * mutex via node:fs. Exported from `@motebit/runtime-host/node` —
 * NEVER from the package root, which must stay loadable in
 * environments without Node APIs (the desktop webview).
 */
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import type { FrameConnection, FrameListener, RuntimeHostPlatform } from "./transport.js";

function isWindowsPipe(path: string): boolean {
  return path.startsWith("\\\\.\\pipe\\");
}

function wrapSocket(socket: Socket): FrameConnection {
  return {
    send: (data) => {
      if (!socket.destroyed) socket.write(data);
    },
    onData: (cb) => {
      socket.on("data", cb);
    },
    onClose: (cb) => {
      socket.on("close", cb);
      socket.on("error", () => socket.destroy());
    },
    end: () => socket.end(),
    destroy: () => socket.destroy(),
    get destroyed() {
      return socket.destroyed;
    },
  };
}

class NodeFrameListener implements FrameListener {
  constructor(private readonly server: Server) {}

  onConnection(cb: (conn: FrameConnection) => void): void {
    this.server.on("connection", (socket) => cb(wrapSocket(socket)));
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      this.server.close(() => resolve());
    });
  }
}

/** Build the node platform. `pid` is injectable for tests. */
export function nodePlatform(overrides: { pid?: number } = {}): RuntimeHostPlatform {
  return {
    pid: overrides.pid ?? process.pid,

    connect(socketPath, timeoutMs) {
      return new Promise((resolve) => {
        const socket = connect(socketPath);
        const timer = setTimeout(() => {
          socket.destroy();
          resolve(null);
        }, timeoutMs);
        socket.once("connect", () => {
          clearTimeout(timer);
          resolve(wrapSocket(socket));
        });
        socket.once("error", () => {
          clearTimeout(timer);
          resolve(null);
        });
      });
    },

    bind(socketPath) {
      return new Promise((resolve, reject) => {
        const server = createServer();
        const onError = (err: NodeJS.ErrnoException): void => {
          server.removeListener("listening", onListening);
          if (err.code === "EADDRINUSE") resolve("in_use");
          else reject(new Error(`runtime-host bind failed: ${err.message}`, { cause: err }));
        };
        const onListening = (): void => {
          server.removeListener("error", onError);
          if (!isWindowsPipe(socketPath)) {
            try {
              chmodSync(socketPath, 0o600);
            } catch (err) {
              server.close();
              reject(
                new Error(
                  `runtime-host bind failed: could not restrict socket permissions: ${
                    err instanceof Error ? err.message : String(err)
                  }`,
                  { cause: err },
                ),
              );
              return;
            }
          }
          resolve(new NodeFrameListener(server));
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(socketPath);
      });
    },

    // eslint-disable-next-line @typescript-eslint/require-await
    async removeSocketFile(socketPath) {
      if (isWindowsPipe(socketPath)) return;
      try {
        rmSync(socketPath, { force: true });
      } catch {
        // The bind will tell the truth either way.
      }
    },

    // eslint-disable-next-line @typescript-eslint/require-await
    async readFile(path) {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return null;
      }
    },

    // eslint-disable-next-line @typescript-eslint/require-await
    async writeFile(path, content) {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeFileSync(path, content, { mode: 0o600 });
    },

    // eslint-disable-next-line @typescript-eslint/require-await
    async removeFile(path) {
      rmSync(path, { force: true });
    },

    // eslint-disable-next-line @typescript-eslint/require-await
    async mkdirExclusive(path) {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      try {
        mkdirSync(path);
        return "created";
      } catch {
        return "exists";
      }
    },

    // eslint-disable-next-line @typescript-eslint/require-await
    async removeDir(path) {
      try {
        rmSync(path, { recursive: true, force: true });
      } catch {
        // A stale mutex is recovered by the PID probe on the next election.
      }
    },

    // eslint-disable-next-line @typescript-eslint/require-await
    async isPidAlive(pid) {
      if (!Number.isInteger(pid) || pid <= 0) return false;
      try {
        process.kill(pid, 0);
        return true;
      } catch (err) {
        return (err as NodeJS.ErrnoException).code === "EPERM";
      }
    },
  };
}
