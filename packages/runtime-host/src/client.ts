/**
 * Frontend side of the runtime-host protocol.
 *
 * A process that loses the election (or starts while a coordinator is
 * live) attaches here: signed handshake in, typed capability proxying
 * coordinator-ward, receipt/event streaming frontend-ward. Coordinator
 * EOF surfaces through `onClose` so the frontend can re-run the
 * election — in-flight invocations fail loudly to their origin, never
 * silently retried across an authority boundary.
 */
import { randomUUID } from "node:crypto";
import { connect, type Socket } from "node:net";
import { createSignedToken } from "@motebit/crypto";
import { RUNTIME_ATTACH_AUDIENCE } from "@motebit/protocol";
import {
  encodeFrame,
  JsonLineDecoder,
  RUNTIME_HOST_PROTOCOL_VERSION,
  type AttachRefusalReason,
  type ServerMessage,
} from "./protocol.js";

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
  const issuedAt = now();
  return createSignedToken(
    {
      mid: identity.motebitId,
      did: identity.deviceId,
      iat: issuedAt,
      exp: issuedAt + (opts.ttlMs ?? 30_000),
      jti: randomUUID(),
      aud: RUNTIME_ATTACH_AUDIENCE,
    },
    privateKey,
  );
}

export interface RuntimeHostClientOptions {
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
  private readonly eventHandlers = new Map<string, Set<(payload: unknown) => void>>();
  private readonly closeHandlers = new Set<() => void>();
  private closed = false;

  private constructor(
    private readonly socket: Socket,
    public readonly coordinatorPid: number,
  ) {}

  /**
   * Connect + handshake. Resolves to an attached client, or throws
   * `CoordinatorUnreachableError` (nothing listening — caller should
   * run the election) / `AttachRefusedError` (a live coordinator said
   * no — caller must NOT try to bind over it).
   */
  static async attach(opts: RuntimeHostClientOptions): Promise<RuntimeHostClient> {
    const socket = await new Promise<Socket>((resolve, reject) => {
      const sock = connect(opts.socketPath);
      const timer = setTimeout(() => {
        sock.destroy();
        reject(new CoordinatorUnreachableError(opts.socketPath, new Error("connect timeout")));
      }, opts.connectTimeoutMs ?? 2000);
      sock.once("connect", () => {
        clearTimeout(timer);
        resolve(sock);
      });
      sock.once("error", (err) => {
        clearTimeout(timer);
        reject(new CoordinatorUnreachableError(opts.socketPath, err));
      });
    });

    socket.write(
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
        const timer = setTimeout(() => {
          cleanup();
          socket.destroy();
          reject(new CoordinatorUnreachableError(opts.socketPath, new Error("handshake timeout")));
        }, opts.handshakeTimeoutMs ?? 3000);
        const onData = (data: Uint8Array): void => {
          let frames: unknown[];
          try {
            frames = decoder.push(data);
          } catch (err) {
            cleanup();
            socket.destroy();
            reject(
              new Error(
                `malformed coordinator frame: ${err instanceof Error ? err.message : String(err)}`,
                { cause: err },
              ),
            );
            return;
          }
          if (frames.length > 0) {
            cleanup();
            resolve({
              first: frames[0] as ServerMessage,
              rest: frames.slice(1) as ServerMessage[],
            });
          }
        };
        const onEnd = (): void => {
          cleanup();
          socket.destroy();
          reject(
            new CoordinatorUnreachableError(opts.socketPath, new Error("closed during handshake")),
          );
        };
        const cleanup = (): void => {
          clearTimeout(timer);
          socket.removeListener("data", onData);
          socket.removeListener("end", onEnd);
          socket.removeListener("error", onEnd);
        };
        socket.on("data", onData);
        socket.once("end", onEnd);
        socket.once("error", onEnd);
      },
    );

    if (first.t === "refuse") {
      socket.destroy();
      throw new AttachRefusedError(first.reason, first.detail);
    }
    if (first.t !== "hello_ack") {
      socket.destroy();
      throw new Error(`unexpected first coordinator frame: ${first.t}`);
    }

    const client = new RuntimeHostClient(socket, first.coordinator_pid);
    client.wire(decoder);
    for (const frame of rest) client.onMessage(frame);
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

  private async *stream(
    buildFrame: (id: string) => Parameters<typeof encodeFrame>[0],
  ): AsyncGenerator<unknown> {
    if (this.closed) throw new Error("runtime-host client is closed");
    const id = randomUUID();
    const state: InflightInvoke = { queue: [], done: false, error: null, wake: null };
    this.inflight.set(id, state);
    this.socket.write(encodeFrame(buildFrame(id)));
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

  /** Subscribe to a coordinator event channel. Returns the unsubscriber. */
  subscribe(channel: string, handler: (payload: unknown) => void): () => void {
    let handlers = this.eventHandlers.get(channel);
    if (handlers === undefined) {
      handlers = new Set();
      this.eventHandlers.set(channel, handlers);
      this.socket.write(encodeFrame({ t: "subscribe", channel }));
    }
    handlers.add(handler);
    return () => {
      const current = this.eventHandlers.get(channel);
      if (current === undefined) return;
      current.delete(handler);
      if (current.size === 0) {
        this.eventHandlers.delete(channel);
        if (!this.closed) this.socket.write(encodeFrame({ t: "unsubscribe", channel }));
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

  private wire(decoder: JsonLineDecoder): void {
    this.socket.on("data", (data) => {
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
    this.socket.on("close", () => this.teardown(new Error("coordinator connection closed")));
    this.socket.on("error", (err) => this.teardown(err));
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
      case "event": {
        const handlers = this.eventHandlers.get(message.channel);
        if (handlers !== undefined) {
          for (const handler of handlers) handler(message.payload);
        }
        return;
      }
      default:
        return;
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
    this.socket.destroy();
    for (const handler of this.closeHandlers) handler();
    this.closeHandlers.clear();
  }
}
