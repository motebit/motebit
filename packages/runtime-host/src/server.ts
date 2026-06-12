/**
 * Coordinator side of the runtime-host protocol.
 *
 * The first motebit process to bind the canonical socket IS the
 * coordinator (`docs/doctrine/daemon-desktop-unification.md`). This
 * server owns the endpoint: it verifies attach handshakes fail-closed,
 * proxies typed capability invocations into the hosting process's
 * runtime, streams events to attached frontends, and dispatches
 * bridged invocations to the frontends that contributed the organ.
 * It never decides policy itself — it is transport plus the
 * authentication boundary.
 *
 * All OS access goes through the injected `RuntimeHostPlatform`, so
 * this logic runs identically under node and the desktop webview.
 */
import { fromBase64Url, verifySignedToken } from "@motebit/crypto";
import { RUNTIME_ATTACH_AUDIENCE } from "@motebit/protocol";
import { removeLockfile, writeLockfile } from "./lockfile.js";
import {
  encodeFrame,
  JsonLineDecoder,
  RUNTIME_HOST_PROTOCOL_VERSION,
  type AttachRefusalReason,
  type ClientMessage,
  type ServerMessage,
} from "./protocol.js";
import type { FrameConnection, FrameListener, RuntimeHostPlatform } from "./transport.js";

/** Thrown by `RuntimeHostServer.bind` when another process holds the socket. */
export class CoordinatorAlreadyBoundError extends Error {
  constructor(socketPath: string) {
    super(`another process already binds ${socketPath}`);
    this.name = "CoordinatorAlreadyBoundError";
  }
}

export interface RuntimeHostLogger {
  warn(message: string, context?: Record<string, unknown>): void;
}

/**
 * The capability execution seam. The hosting process (CLI daemon,
 * desktop) wires this to its runtime's typed `invokeCapability` — never
 * to a constructed prompt (`docs/doctrine/surface-determinism.md`).
 * `signal` aborts when the requesting frontend disconnects.
 */
export type InvokeHandler = (
  capability: string,
  prompt: string,
  options: Record<string, unknown> | undefined,
  ctx: { signal: AbortSignal },
) => AsyncIterable<unknown>;

/**
 * The conversational seam — wired to the runtime's
 * `sendMessageStreaming`. Distinct from `InvokeHandler` by doctrine:
 * chat is the AI loop, invoke is a deterministic affordance.
 */
export type ChatHandler = (
  text: string,
  options: Record<string, unknown> | undefined,
  ctx: { signal: AbortSignal },
) => AsyncIterable<unknown>;

/**
 * The approval-resolution seam — wired to the runtime's
 * `resolveApprovalVote`. Streams the continuation turn's chunks.
 */
export type ResolveApprovalHandler = (
  approved: boolean,
  approverId: string,
  ctx: { signal: AbortSignal },
) => AsyncIterable<unknown>;

export interface RuntimeHostServerOptions {
  /** The OS seam — node sockets or the desktop's Tauri pipe. */
  platform: RuntimeHostPlatform;
  socketPath: string;
  lockfilePath: string;
  /** The machine identity every attacher must prove membership of. */
  motebitId: string;
  /**
   * Device-key resolution port. Returns the Ed25519 public key for a
   * device id of this motebit, or null for unknown devices (refused).
   * Injected so this package never binds to a storage layer.
   */
  resolveDevicePublicKey: (deviceId: string) => Uint8Array | null | Promise<Uint8Array | null>;
  onInvoke: InvokeHandler;
  /** Absent ⇒ chat frames answer `invoke_error` ("not supported"), never silently drop. */
  onChat?: ChatHandler;
  /** Absent ⇒ resolve_approval frames answer `invoke_error`, never silently drop. */
  onResolveApproval?: ResolveApprovalHandler;
  logger?: RuntimeHostLogger;
  /** Injectable for tests. Defaults to `platform.pid`. */
  pid?: number;
  now?: () => number;
  /** How long a fresh connection may sit silent before `hello`. */
  handshakeTimeoutMs?: number;
}

interface Connection {
  conn: FrameConnection;
  decoder: JsonLineDecoder;
  authenticated: boolean;
  channels: Set<string>;
  /** Organs this frontend contributed via register_capabilities. */
  capabilities: Set<string>;
  inflight: Map<string, AbortController>;
  /** Bridged invocations this connection is currently answering. */
  bridgeIds: Set<string>;
  handshakeTimer: ReturnType<typeof setTimeout> | null;
}

interface BridgeState {
  conn: Connection;
  queue: unknown[];
  done: boolean;
  error: Error | null;
  wake: (() => void) | null;
}

/** Decode the payload half of a signed token without verifying it. */
function parseTokenClaims(token: string): { mid: string; did: string; aud: string } | null {
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  try {
    const payload: unknown = JSON.parse(
      new TextDecoder().decode(fromBase64Url(token.slice(0, dot))),
    );
    if (payload === null || typeof payload !== "object") return null;
    const record = payload as Record<string, unknown>;
    if (
      typeof record.mid !== "string" ||
      typeof record.did !== "string" ||
      typeof record.aud !== "string"
    ) {
      return null;
    }
    return { mid: record.mid, did: record.did, aud: record.aud };
  } catch {
    return null;
  }
}

export class RuntimeHostServer {
  private readonly connections = new Set<Connection>();
  /** capability → the connection contributing it (last registrar wins). */
  private readonly bridged = new Map<string, Connection>();
  private readonly bridgeInflight = new Map<string, BridgeState>();
  private readonly capabilityListeners = new Set<(capabilities: string[]) => void>();
  private bridgeCounter = 0;
  private closed = false;

  private constructor(
    private readonly listener: FrameListener,
    private readonly opts: RuntimeHostServerOptions,
    private readonly pid: number,
  ) {}

  /**
   * Bind the canonical endpoint and become the coordinator. Throws
   * `CoordinatorAlreadyBoundError` when another listener holds it —
   * the caller attaches instead. The caller is responsible for
   * clearing a *verified-stale* socket file first (the election does
   * this); bind never unlinks.
   */
  static async bind(opts: RuntimeHostServerOptions): Promise<RuntimeHostServer> {
    const pid = opts.pid ?? opts.platform.pid;
    const now = opts.now ?? (() => Date.now());
    const bound = await opts.platform.bind(opts.socketPath);
    if (bound === "in_use") throw new CoordinatorAlreadyBoundError(opts.socketPath);
    const host = new RuntimeHostServer(bound, opts, pid);
    bound.onConnection((conn) => host.onConnection(conn));
    await writeLockfile(opts.platform, opts.lockfilePath, {
      pid,
      bound_at: now(),
      protocol_version: RUNTIME_HOST_PROTOCOL_VERSION,
    });
    return host;
  }

  get attachedCount(): number {
    let count = 0;
    for (const conn of this.connections) if (conn.authenticated) count += 1;
    return count;
  }

  /** The organs currently contributed by attached frontends. */
  get bridgedCapabilities(): string[] {
    return [...this.bridged.keys()];
  }

  /**
   * Subscribe to changes in the bridged-organ set — fired after a
   * frontend registers capabilities and after a contributing frontend
   * disconnects. The listener receives the CURRENT full set (idempotent
   * sync semantics, never deltas: last-registrar-wins and multi-frontend
   * churn collapse to "reconcile against this"). Returns unsubscribe.
   */
  onBridgedCapabilitiesChanged(listener: (capabilities: string[]) => void): () => void {
    this.capabilityListeners.add(listener);
    return () => this.capabilityListeners.delete(listener);
  }

  /**
   * Listener faults must not tear down the coordinator or the frame
   * that triggered the change — log and keep serving.
   */
  private notifyCapabilitiesChanged(): void {
    const capabilities = this.bridgedCapabilities;
    for (const listener of this.capabilityListeners) {
      try {
        listener(capabilities);
      } catch (err: unknown) {
        this.opts.logger?.warn("runtime-host: bridged-capabilities listener failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /** Push an event to every attached frontend subscribed to `channel`. */
  publishEvent(channel: string, payload: unknown): void {
    for (const conn of this.connections) {
      if (conn.authenticated && conn.channels.has(channel)) {
        this.send(conn, { t: "event", channel, payload });
      }
    }
  }

  /**
   * Invoke an organ a frontend contributed — the bridging half of the
   * election doctrine. Streams the frontend's chunks; throws honestly
   * when no attached frontend contributes the capability or the
   * contributor disconnects mid-stream (fail-loud, never silent retry
   * across the authority boundary).
   */
  async *invokeBridged(
    capability: string,
    prompt: string,
    options?: Record<string, unknown>,
  ): AsyncGenerator<unknown> {
    const conn = this.bridged.get(capability);
    if (conn === undefined || conn.conn.destroyed) {
      throw new Error(`no attached frontend contributes capability "${capability}"`);
    }
    this.bridgeCounter += 1;
    const id = `bridge-${this.bridgeCounter}`;
    const state: BridgeState = { conn, queue: [], done: false, error: null, wake: null };
    this.bridgeInflight.set(id, state);
    conn.bridgeIds.add(id);
    this.send(conn, { t: "bridge_invoke", id, capability, prompt, options });
    try {
      for (;;) {
        while (state.queue.length > 0) yield state.queue.shift();
        if (state.error !== null) throw state.error;
        if (state.done) return;
        await new Promise<void>((resolve) => {
          state.wake = resolve;
        });
        state.wake = null;
      }
    } finally {
      this.bridgeInflight.delete(id);
      conn.bridgeIds.delete(id);
    }
  }

  /** Stop coordinating: drop connections, release the socket + lock. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const conn of this.connections) this.destroyConnection(conn);
    await this.listener.close();
    await this.opts.platform.removeSocketFile(this.opts.socketPath);
    await removeLockfile(this.opts.platform, this.opts.lockfilePath, this.pid);
  }

  private onConnection(frameConn: FrameConnection): void {
    const conn: Connection = {
      conn: frameConn,
      decoder: new JsonLineDecoder(),
      authenticated: false,
      channels: new Set(),
      capabilities: new Set(),
      inflight: new Map(),
      bridgeIds: new Set(),
      handshakeTimer: null,
    };
    this.connections.add(conn);
    conn.handshakeTimer = setTimeout(() => {
      if (!conn.authenticated) this.destroyConnection(conn);
    }, this.opts.handshakeTimeoutMs ?? 5000);

    frameConn.onData((data) => {
      let frames: unknown[];
      try {
        frames = conn.decoder.push(data);
      } catch (err) {
        this.opts.logger?.warn("runtime-host: destroying connection on malformed frame", {
          error: err instanceof Error ? err.message : String(err),
        });
        this.destroyConnection(conn);
        return;
      }
      for (const frame of frames) {
        void this.onMessage(conn, frame as ClientMessage);
      }
    });
    frameConn.onClose(() => this.destroyConnection(conn));
  }

  private async onMessage(conn: Connection, message: ClientMessage): Promise<void> {
    if (!conn.authenticated) {
      if (message.t !== "hello") {
        // Fail-closed: nothing but hello speaks before authentication.
        this.destroyConnection(conn);
        return;
      }
      await this.onHello(conn, message);
      return;
    }
    switch (message.t) {
      case "hello":
        // Re-hello on an attached connection is protocol abuse.
        this.destroyConnection(conn);
        return;
      case "subscribe":
        if (typeof message.channel === "string") conn.channels.add(message.channel);
        return;
      case "unsubscribe":
        if (typeof message.channel === "string") conn.channels.delete(message.channel);
        return;
      case "register_capabilities": {
        if (
          !Array.isArray(message.capabilities) ||
          message.capabilities.some((c) => typeof c !== "string")
        ) {
          this.destroyConnection(conn);
          return;
        }
        // Idempotent replace of this connection's contributed set.
        for (const capability of conn.capabilities) {
          if (this.bridged.get(capability) === conn) this.bridged.delete(capability);
        }
        conn.capabilities = new Set(message.capabilities);
        for (const capability of conn.capabilities) {
          this.bridged.set(capability, conn);
        }
        this.notifyCapabilitiesChanged();
        return;
      }
      case "bridge_chunk":
      case "bridge_end":
      case "bridge_error": {
        const state = this.bridgeInflight.get(message.id);
        // Only the connection answering ITS OWN bridged invocation may
        // touch the stream — another frontend cannot inject chunks.
        if (state === undefined || state.conn !== conn) return;
        if (message.t === "bridge_chunk") state.queue.push(message.chunk);
        else if (message.t === "bridge_end") state.done = true;
        else state.error = new Error(message.message);
        state.wake?.();
        return;
      }
      case "invoke":
        if (
          typeof message.id !== "string" ||
          typeof message.capability !== "string" ||
          typeof message.prompt !== "string"
        ) {
          this.destroyConnection(conn);
          return;
        }
        await this.runStream(conn, message.id, (ctx) =>
          this.opts.onInvoke(message.capability, message.prompt, message.options, ctx),
        );
        return;
      case "chat": {
        if (typeof message.id !== "string" || typeof message.text !== "string") {
          this.destroyConnection(conn);
          return;
        }
        const onChat = this.opts.onChat;
        if (onChat === undefined) {
          this.send(conn, {
            t: "invoke_error",
            id: message.id,
            message: "this coordinator does not proxy chat",
          });
          return;
        }
        await this.runStream(conn, message.id, (ctx) => onChat(message.text, message.options, ctx));
        return;
      }
      case "resolve_approval": {
        if (
          typeof message.id !== "string" ||
          typeof message.approved !== "boolean" ||
          typeof message.approver_id !== "string"
        ) {
          this.destroyConnection(conn);
          return;
        }
        const onResolveApproval = this.opts.onResolveApproval;
        if (onResolveApproval === undefined) {
          this.send(conn, {
            t: "invoke_error",
            id: message.id,
            message: "this coordinator does not proxy approval resolution",
          });
          return;
        }
        await this.runStream(conn, message.id, (ctx) =>
          onResolveApproval(message.approved, message.approver_id, ctx),
        );
        return;
      }
      default:
        this.destroyConnection(conn);
    }
  }

  private refuse(conn: Connection, reason: AttachRefusalReason, detail: string): void {
    this.send(conn, { t: "refuse", reason, detail });
    conn.conn.end();
  }

  private async onHello(
    conn: Connection,
    hello: { protocol_version?: unknown; token?: unknown },
  ): Promise<void> {
    if (typeof hello.protocol_version !== "number" || typeof hello.token !== "string") {
      this.refuse(conn, "malformed_hello", "hello requires protocol_version and token");
      return;
    }
    if (hello.protocol_version !== RUNTIME_HOST_PROTOCOL_VERSION) {
      this.refuse(
        conn,
        "version_skew",
        `coordinator speaks runtime-host protocol v${RUNTIME_HOST_PROTOCOL_VERSION}, attacher sent v${hello.protocol_version}`,
      );
      return;
    }
    const claims = parseTokenClaims(hello.token);
    if (claims === null) {
      this.refuse(conn, "auth_failed", "attach token is malformed");
      return;
    }
    if (claims.aud !== RUNTIME_ATTACH_AUDIENCE) {
      this.refuse(
        conn,
        "auth_failed",
        `attach token audience is "${claims.aud}", expected "${RUNTIME_ATTACH_AUDIENCE}"`,
      );
      return;
    }
    if (claims.mid !== this.opts.motebitId) {
      this.refuse(conn, "auth_failed", "attach token is for a different motebit identity");
      return;
    }
    let publicKey: Uint8Array | null;
    try {
      publicKey = await this.opts.resolveDevicePublicKey(claims.did);
    } catch (err) {
      // Resolution failure is a refusal, never an open door.
      this.opts.logger?.warn("runtime-host: device key resolution failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      publicKey = null;
    }
    if (publicKey === null) {
      this.refuse(conn, "auth_failed", `unknown device "${claims.did}"`);
      return;
    }
    const payload = await verifySignedToken(hello.token, publicKey);
    if (payload === null) {
      this.refuse(conn, "auth_failed", "attach token signature invalid or token expired");
      return;
    }
    conn.authenticated = true;
    if (conn.handshakeTimer !== null) {
      clearTimeout(conn.handshakeTimer);
      conn.handshakeTimer = null;
    }
    this.send(conn, {
      t: "hello_ack",
      protocol_version: RUNTIME_HOST_PROTOCOL_VERSION,
      coordinator_pid: this.pid,
    });
  }

  /** Drive one handler stream onto the wire: chunk* then end, or invoke_error. */
  private async runStream(
    conn: Connection,
    id: string,
    start: (ctx: { signal: AbortSignal }) => AsyncIterable<unknown>,
  ): Promise<void> {
    const controller = new AbortController();
    conn.inflight.set(id, controller);
    try {
      for await (const chunk of start({ signal: controller.signal })) {
        if (controller.signal.aborted || conn.conn.destroyed) return;
        this.send(conn, { t: "chunk", id, chunk });
      }
      if (!conn.conn.destroyed) this.send(conn, { t: "end", id });
    } catch (err) {
      if (!conn.conn.destroyed) {
        this.send(conn, {
          t: "invoke_error",
          id,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    } finally {
      conn.inflight.delete(id);
    }
  }

  private send(conn: Connection, message: ServerMessage): void {
    if (conn.conn.destroyed) return;
    conn.conn.send(encodeFrame(message));
  }

  private destroyConnection(conn: Connection): void {
    if (!this.connections.has(conn)) return;
    this.connections.delete(conn);
    if (conn.handshakeTimer !== null) clearTimeout(conn.handshakeTimer);
    for (const controller of conn.inflight.values()) controller.abort();
    conn.inflight.clear();
    // Fail-loud: bridged invocations this frontend was answering die
    // with it, and its organs leave the bridged set.
    for (const id of conn.bridgeIds) {
      const state = this.bridgeInflight.get(id);
      if (state !== undefined && state.error === null && !state.done) {
        state.error = new Error("bridged frontend disconnected mid-invocation");
        state.wake?.();
      }
    }
    conn.bridgeIds.clear();
    let removedOrgans = 0;
    for (const capability of conn.capabilities) {
      if (this.bridged.get(capability) === conn) {
        this.bridged.delete(capability);
        removedOrgans += 1;
      }
    }
    conn.conn.destroy();
    if (removedOrgans > 0) this.notifyCapabilitiesChanged();
  }
}
