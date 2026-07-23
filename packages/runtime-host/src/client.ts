/**
 * Frontend side of the runtime-host protocol.
 *
 * A process that loses the election (or starts while a coordinator is
 * live) attaches here: signed handshake in, typed capability proxying
 * coordinator-ward, receipt/event streaming frontend-ward, and — the
 * bridging half of the doctrine — this frontend's unique organs
 * registered as capabilities the coordinator can invoke back across
 * the same connection. Coordinator EOF surfaces through `onClose` so
 * the frontend can re-run the election — in-flight invocations fail
 * loudly to their origin, never silently retried across an authority
 * boundary.
 */
import { mintAudienceToken } from "@motebit/crypto";
import { RUNTIME_ATTACH_AUDIENCE } from "@motebit/protocol";
import {
  encodeFrame,
  JsonLineDecoder,
  RUNTIME_HOST_PROTOCOL_VERSION,
  type AttachRefusalReason,
  type ClientMessage,
  type ServerMessage,
} from "./protocol.js";
import type { FrameConnection, RuntimeHostPlatform } from "./transport.js";

/** The coordinator refused the handshake (auth, version skew, malformed hello). */
export class AttachRefusedError extends Error {
  constructor(
    public readonly reason: AttachRefusalReason,
    public readonly detail: string,
  ) {
    super(`attach refused (${reason}): ${detail}`);
    this.name = "AttachRefusedError";
  }
}

/** No coordinator answered on the socket (ENOENT / ECONNREFUSED / timeout). */
export class CoordinatorUnreachableError extends Error {
  constructor(socketPath: string, cause?: unknown) {
    super(`no coordinator reachable at ${socketPath}`, { cause });
    this.name = "CoordinatorUnreachableError";
  }
}

/**
 * Mint the device-key-signed attach token for the handshake. Short TTL
 * by design: the token authenticates one local handshake, not a
 * session — the connection is the session.
 */
export async function mintAttachToken(
  identity: { motebitId: string; deviceId: string },
  privateKey: Uint8Array,
  opts: { ttlMs?: number; now?: () => number } = {},
): Promise<string> {
  const now = opts.now ?? (() => Date.now());
  return (
    await mintAudienceToken(
      {
        mid: identity.motebitId,
        did: identity.deviceId,
        aud: RUNTIME_ATTACH_AUDIENCE,
        ttlMs: opts.ttlMs ?? 30_000,
        nowMs: now(),
      },
      privateKey,
    )
  ).token;
}

/**
 * An organ this frontend contributes — invoked BY the coordinator over
 * the bridge. `signal` aborts when the connection drops.
 */
export type BridgedCapabilityHandler = (
  prompt: string,
  options: Record<string, unknown> | undefined,
  ctx: { signal: AbortSignal },
) => AsyncIterable<unknown>;

export interface RuntimeHostClientOptions {
  /** The OS seam — node sockets or the desktop's Tauri pipe. */
  platform: RuntimeHostPlatform;
  socketPath: string;
  /** Signed attach token (`mintAttachToken`). */
  token: string;
  connectTimeoutMs?: number;
  /**
   * Ceiling on the wait for `hello_ack` / `refuse`. A listener that
   * accepts but never answers (a non-protocol process squatting the
   * path) must surface as unreachable, not hang the election.
   */
  handshakeTimeoutMs?: number;
  /**
   * Organs to contribute immediately after attaching (also settable
   * later via `setBridgedCapabilities`).
   */
  capabilities?: Record<string, BridgedCapabilityHandler>;
  /**
   * Test seam: send a different protocol version in `hello` to exercise
   * the coordinator's version-skew refusal. Production callers omit it.
   */
  protocolVersion?: number;
}

interface InflightInvoke {
  queue: unknown[];
  done: boolean;
  error: Error | null;
  wake: (() => void) | null;
}

export class RuntimeHostClient {
  private readonly inflight = new Map<string, InflightInvoke>();
  private readonly pendingQueries = new Map<
    string,
    { resolve: (payload: unknown) => void; reject: (err: Error) => void }
  >();
  private readonly eventHandlers = new Map<string, Set<(payload: unknown) => void>>();
  private readonly closeHandlers = new Set<() => void>();
  private capabilityHandlers = new Map<string, BridgedCapabilityHandler>();
  private readonly bridgeAborts = new Map<string, AbortController>();
  private requestCounter = 0;
  private closed = false;

  private constructor(
    private readonly conn: FrameConnection,
    public readonly coordinatorPid: number,
  ) {}

  /**
   * Connect + handshake. Resolves to an attached client, or throws
   * `CoordinatorUnreachableError` (nothing listening — caller should
   * run the election) / `AttachRefusedError` (a live coordinator said
   * no — caller must NOT try to bind over it).
   */
  static async attach(opts: RuntimeHostClientOptions): Promise<RuntimeHostClient> {
    const conn = await opts.platform.connect(opts.socketPath, opts.connectTimeoutMs ?? 2000);
    if (conn === null) {
      throw new CoordinatorUnreachableError(opts.socketPath, new Error("connect failed"));
    }

    conn.send(
      encodeFrame({
        t: "hello",
        protocol_version: opts.protocolVersion ?? RUNTIME_HOST_PROTOCOL_VERSION,
        token: opts.token,
      }),
    );

    const decoder = new JsonLineDecoder();
    // Frames batched into the same packet as the handshake reply must
    // not be dropped — they replay into the attached client below.
    const { first, rest } = await new Promise<{ first: ServerMessage; rest: ServerMessage[] }>(
      (resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
          settle();
          conn.destroy();
          reject(new CoordinatorUnreachableError(opts.socketPath, new Error("handshake timeout")));
        }, opts.handshakeTimeoutMs ?? 3000);
        const settle = (): void => {
          settled = true;
          clearTimeout(timer);
        };
        conn.onData((data) => {
          if (settled) return;
          let frames: unknown[];
          try {
            frames = decoder.push(data);
          } catch (err) {
            settle();
            conn.destroy();
            reject(
              new Error(
                `malformed coordinator frame: ${err instanceof Error ? err.message : String(err)}`,
                { cause: err },
              ),
            );
            return;
          }
          if (frames.length > 0) {
            settle();
            resolve({
              first: frames[0] as ServerMessage,
              rest: frames.slice(1) as ServerMessage[],
            });
          }
        });
        conn.onClose(() => {
          if (settled) return;
          settle();
          conn.destroy();
          reject(
            new CoordinatorUnreachableError(opts.socketPath, new Error("closed during handshake")),
          );
        });
      },
    );

    if (first.t === "refuse") {
      conn.destroy();
      throw new AttachRefusedError(first.reason, first.detail);
    }
    if (first.t !== "hello_ack") {
      conn.destroy();
      throw new Error(`unexpected first coordinator frame: ${first.t}`);
    }

    const client = new RuntimeHostClient(conn, first.coordinator_pid);
    client.wire(decoder);
    for (const frame of rest) client.onMessage(frame);
    if (opts.capabilities !== undefined) client.setBridgedCapabilities(opts.capabilities);
    return client;
  }

  /**
   * Proxy a typed capability invocation to the coordinator. Yields the
   * coordinator's streamed chunks; throws on `invoke_error` or if the
   * coordinator goes away mid-stream (fail-loud, per doctrine).
   */
  async *invoke(
    capability: string,
    prompt: string,
    options?: Record<string, unknown>,
  ): AsyncGenerator<unknown> {
    yield* this.stream((id) => ({ t: "invoke", id, capability, prompt, options }));
  }

  /**
   * Proxy one conversational turn (`sendMessageStreaming`) to the
   * coordinator. A turn that pauses on `approval_request` ends its
   * stream; continue it with `resolveApproval`.
   */
  async *chat(text: string, options?: Record<string, unknown>): AsyncGenerator<unknown> {
    yield* this.stream((id) => ({ t: "chat", id, text, options }));
  }

  /**
   * Resolve a pending approval on the coordinator
   * (`resolveApprovalVote`); yields the continuation turn's chunks.
   */
  async *resolveApproval(approved: boolean, approverId: string): AsyncGenerator<unknown> {
    yield* this.stream((id) => ({
      t: "resolve_approval",
      id,
      approved,
      approver_id: approverId,
    }));
  }

  /**
   * Read a record set from the coordinator's interior (attach-mode
   * parity). Resolves with the payload, rejects with the coordinator's
   * honest refusal (unknown kind, malformed params, no read seam) or on
   * disconnect.
   */
  query(kind: string, params?: Record<string, unknown>): Promise<unknown> {
    return this.request((id) => ({ t: "query", id, kind, params }));
  }

  /**
   * Perform a typed panel act against the coordinator's interior. A
   * distinct verb from `query` (records vs acts) and from `invoke`
   * (relay delegation); the coordinator's closed act registry decides
   * what is performable.
   */
  act(kind: string, params?: Record<string, unknown>): Promise<unknown> {
    return this.request((id) => ({ t: "act", id, kind, params }));
  }

  private request(build: (id: string) => ClientMessage): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(new Error("runtime-host client is closed"));
    }
    this.requestCounter += 1;
    const id = `q-${this.requestCounter}`;
    return new Promise<unknown>((resolve, reject) => {
      this.pendingQueries.set(id, { resolve, reject });
      this.conn.send(encodeFrame(build(id)));
    });
  }

  /**
   * Contribute this frontend's organs. Replaces the previous set, both
   * locally and on the coordinator (idempotent).
   */
  setBridgedCapabilities(handlers: Record<string, BridgedCapabilityHandler>): void {
    if (this.closed) throw new Error("runtime-host client is closed");
    this.capabilityHandlers = new Map(Object.entries(handlers));
    this.conn.send(
      encodeFrame({
        t: "register_capabilities",
        capabilities: [...this.capabilityHandlers.keys()],
      }),
    );
  }

  /** Subscribe to a coordinator event channel. Returns the unsubscriber. */
  subscribe(channel: string, handler: (payload: unknown) => void): () => void {
    let handlers = this.eventHandlers.get(channel);
    if (handlers === undefined) {
      handlers = new Set();
      this.eventHandlers.set(channel, handlers);
      this.conn.send(encodeFrame({ t: "subscribe", channel }));
    }
    handlers.add(handler);
    return () => {
      const current = this.eventHandlers.get(channel);
      if (current === undefined) return;
      current.delete(handler);
      if (current.size === 0) {
        this.eventHandlers.delete(channel);
        if (!this.closed) this.conn.send(encodeFrame({ t: "unsubscribe", channel }));
      }
    };
  }

  /** Fires once when the coordinator connection ends — the re-elect signal. */
  onClose(handler: () => void): () => void {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  close(): void {
    this.teardown(null);
  }

  private async *stream(
    buildFrame: (id: string) => Parameters<typeof encodeFrame>[0],
  ): AsyncGenerator<unknown> {
    if (this.closed) throw new Error("runtime-host client is closed");
    this.requestCounter += 1;
    const id = `req-${this.requestCounter}-${globalThis.crypto.randomUUID().slice(0, 8)}`;
    const state: InflightInvoke = { queue: [], done: false, error: null, wake: null };
    this.inflight.set(id, state);
    this.conn.send(encodeFrame(buildFrame(id)));
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
      this.inflight.delete(id);
    }
  }

  private wire(decoder: JsonLineDecoder): void {
    this.conn.onData((data) => {
      let frames: unknown[];
      try {
        frames = decoder.push(data);
      } catch (err) {
        this.teardown(
          new Error(
            `malformed coordinator frame: ${err instanceof Error ? err.message : String(err)}`,
            { cause: err },
          ),
        );
        return;
      }
      for (const frame of frames) this.onMessage(frame as ServerMessage);
    });
    this.conn.onClose(() => this.teardown(new Error("coordinator connection closed")));
  }

  private onMessage(message: ServerMessage): void {
    switch (message.t) {
      case "chunk": {
        const state = this.inflight.get(message.id);
        if (state !== undefined) {
          state.queue.push(message.chunk);
          state.wake?.();
        }
        return;
      }
      case "end": {
        const state = this.inflight.get(message.id);
        if (state !== undefined) {
          state.done = true;
          state.wake?.();
        }
        return;
      }
      case "invoke_error": {
        const state = this.inflight.get(message.id);
        if (state !== undefined) {
          state.error = new Error(message.message);
          state.wake?.();
        }
        return;
      }
      case "query_result": {
        const pending = this.pendingQueries.get(message.id);
        if (pending !== undefined) {
          this.pendingQueries.delete(message.id);
          pending.resolve(message.payload);
        }
        return;
      }
      case "query_error": {
        const pending = this.pendingQueries.get(message.id);
        if (pending !== undefined) {
          this.pendingQueries.delete(message.id);
          pending.reject(new Error(message.message));
        }
        return;
      }
      case "event": {
        const handlers = this.eventHandlers.get(message.channel);
        if (handlers !== undefined) {
          for (const handler of handlers) handler(message.payload);
        }
        return;
      }
      case "bridge_invoke": {
        if (
          typeof message.id === "string" &&
          typeof message.capability === "string" &&
          typeof message.prompt === "string"
        ) {
          void this.runBridgedInvocation(
            message.id,
            message.capability,
            message.prompt,
            message.options,
          );
        }
        return;
      }
      default:
        return;
    }
  }

  /** Answer a coordinator-initiated bridged invocation. */
  private async runBridgedInvocation(
    id: string,
    capability: string,
    prompt: string,
    options: Record<string, unknown> | undefined,
  ): Promise<void> {
    const handler = this.capabilityHandlers.get(capability);
    if (handler === undefined) {
      this.conn.send(
        encodeFrame({
          t: "bridge_error",
          id,
          message: `capability "${capability}" is not contributed by this frontend`,
        }),
      );
      return;
    }
    const controller = new AbortController();
    this.bridgeAborts.set(id, controller);
    try {
      for await (const chunk of handler(prompt, options, { signal: controller.signal })) {
        if (controller.signal.aborted || this.closed) return;
        this.conn.send(encodeFrame({ t: "bridge_chunk", id, chunk }));
      }
      if (!this.closed) this.conn.send(encodeFrame({ t: "bridge_end", id }));
    } catch (err) {
      if (!this.closed) {
        this.conn.send(
          encodeFrame({
            t: "bridge_error",
            id,
            message: err instanceof Error ? err.message : String(err),
          }),
        );
      }
    } finally {
      this.bridgeAborts.delete(id);
    }
  }

  private teardown(cause: Error | null): void {
    if (this.closed) return;
    this.closed = true;
    for (const state of this.inflight.values()) {
      if (!state.done && state.error === null) {
        state.error = cause ?? new Error("runtime-host client closed");
      }
      state.wake?.();
    }
    // Fail-loud: in-flight reads/acts die with the connection.
    for (const pending of this.pendingQueries.values()) {
      pending.reject(cause ?? new Error("runtime-host client closed"));
    }
    this.pendingQueries.clear();
    for (const controller of this.bridgeAborts.values()) controller.abort();
    this.bridgeAborts.clear();
    this.conn.destroy();
    for (const handler of this.closeHandlers) handler();
    this.closeHandlers.clear();
  }
}
