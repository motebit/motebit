// Tauri implementation of the runtime-host platform seam. The webview
// has no Node APIs, so the Rust side (src-tauri/src/runtime_host.rs)
// owns the unix socket as a dumb newline-frame pipe; ALL protocol,
// authentication, and election logic stays in TS — the same single
// implementation the node hosts run
// (docs/doctrine/daemon-desktop-unification.md).

import type { FrameConnection, FrameListener, RuntimeHostPlatform } from "@motebit/runtime-host";
import type { InvokeFn } from "./tauri-storage.js";

type PipeEvent =
  | { type: "data"; conn_id: number; data: string }
  | { type: "close"; conn_id: number }
  | { type: "connection"; conn_id: number };

interface TauriChannel<T> {
  onmessage: (message: T) => void;
}

interface TauriChannelCtor {
  new <T>(): TauriChannel<T>;
}

async function loadChannelCtor(): Promise<TauriChannelCtor> {
  const mod = (await import("@tauri-apps/api/core")) as { Channel: TauriChannelCtor };
  return mod.Channel;
}

/**
 * Wrap one Rust-side connection id as a FrameConnection. Writes are
 * serialized through a per-connection promise chain — Tauri invokes
 * carry no ordering guarantee, and reordered frames would corrupt the
 * protocol stream.
 */
function wrapConn(
  invoke: InvokeFn,
  connId: number,
  registerHandlers: (h: { data: (d: string) => void; close: () => void }) => void,
): FrameConnection {
  let destroyed = false;
  let dataCb: ((data: string | Uint8Array) => void) | null = null;
  let closeCb: (() => void) | null = null;
  let writeChain: Promise<unknown> = Promise.resolve();

  registerHandlers({
    data: (d) => dataCb?.(d),
    close: () => {
      destroyed = true;
      closeCb?.();
    },
  });

  return {
    send: (data) => {
      if (destroyed) return;
      writeChain = writeChain.then(() =>
        invoke("runtime_host_send", { connId, data }).catch(() => {
          destroyed = true;
          closeCb?.();
        }),
      );
    },
    onData: (cb) => {
      dataCb = cb;
    },
    onClose: (cb) => {
      closeCb = cb;
    },
    end: () => {
      // Flush the write chain, then close gracefully.
      writeChain = writeChain.then(() => invoke("runtime_host_close", { connId }).catch(() => {}));
    },
    destroy: () => {
      if (destroyed) return;
      destroyed = true;
      void invoke("runtime_host_close", { connId }).catch(() => {});
    },
    get destroyed() {
      return destroyed;
    },
  };
}

export interface TauriRuntimeHost {
  platform: RuntimeHostPlatform;
  /** The machine home dir (from Rust) — for canonical path construction. */
  home: string;
}

export async function createTauriRuntimeHostPlatform(invoke: InvokeFn): Promise<TauriRuntimeHost> {
  const meta = await invoke<{ pid: number; home: string }>("runtime_host_meta");
  const Channel = await loadChannelCtor();

  const platform: RuntimeHostPlatform = {
    pid: meta.pid,

    async connect(socketPath) {
      const channel = new Channel<PipeEvent>();
      let handlers: { data: (d: string) => void; close: () => void } | null = null;
      const buffered: PipeEvent[] = [];
      channel.onmessage = (event) => {
        if (handlers === null) {
          buffered.push(event);
          return;
        }
        if (event.type === "data") handlers.data(event.data);
        else if (event.type === "close") handlers.close();
      };
      let connId: number;
      try {
        connId = await invoke<number>("runtime_host_connect", {
          socketPath,
          onEvent: channel,
        });
      } catch {
        return null; // unreachable — the election's null signal
      }
      return wrapConn(invoke, connId, (h) => {
        handlers = h;
        for (const event of buffered.splice(0)) {
          if (event.type === "data") h.data(event.data);
          else if (event.type === "close") h.close();
        }
      });
    },

    async bind(socketPath) {
      const channel = new Channel<PipeEvent>();
      const connections = new Map<number, { data: (d: string) => void; close: () => void }>();
      let onConnectionCb: ((conn: FrameConnection) => void) | null = null;
      channel.onmessage = (event) => {
        if (event.type === "connection") {
          const conn = wrapConn(invoke, event.conn_id, (h) => {
            connections.set(event.conn_id, h);
          });
          onConnectionCb?.(conn);
          return;
        }
        const handler = connections.get(event.conn_id);
        if (handler === undefined) return;
        if (event.type === "data") handler.data(event.data);
        else {
          connections.delete(event.conn_id);
          handler.close();
        }
      };
      const outcome = await invoke<string>("runtime_host_bind", {
        socketPath,
        onEvent: channel,
      });
      if (outcome === "in_use") return "in_use";
      const listener: FrameListener = {
        onConnection: (cb) => {
          onConnectionCb = cb;
        },
        close: async () => {
          await invoke("runtime_host_unbind").catch(() => {});
        },
      };
      return listener;
    },

    async removeSocketFile(socketPath) {
      await invoke("runtime_host_remove_file", { path: socketPath }).catch(() => {});
    },

    async readFile(path) {
      try {
        return await invoke<string | null>("runtime_host_read_file", { path });
      } catch {
        return null;
      }
    },

    async writeFile(path, content) {
      await invoke("runtime_host_write_file", { path, content });
    },

    async removeFile(path) {
      await invoke("runtime_host_remove_file", { path }).catch(() => {});
    },

    async mkdirExclusive(path) {
      const outcome = await invoke<string>("runtime_host_mkdir_exclusive", { path });
      return outcome === "created" ? "created" : "exists";
    },

    async removeDir(path) {
      await invoke("runtime_host_remove_dir", { path }).catch(() => {});
    },

    async isPidAlive(pid) {
      try {
        return await invoke<boolean>("runtime_host_pid_alive", { pid });
      } catch {
        return false;
      }
    },
  };

  return { platform, home: meta.home };
}
