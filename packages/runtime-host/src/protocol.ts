/**
 * Wire protocol for the local runtime-host socket.
 *
 * One coordinator process per machine binds `~/.motebit/runtime.sock`;
 * every other motebit process attaches as a frontend over this protocol
 * (`docs/doctrine/daemon-desktop-unification.md`). Transport is a local
 * unix domain socket (Windows: named pipe); framing is newline-delimited
 * JSON — one UTF-8 JSON object per `\n`-terminated line. The protocol
 * never crosses the machine.
 *
 * Authentication is a device-key-signed token (`aud: "runtime:attach"`)
 * carried in the `hello` message. Until `hello` is accepted, the only
 * legal client message is `hello`; anything else destroys the
 * connection fail-closed.
 */

/**
 * Version exchanged in the `hello` / `hello_ack` pair. A mismatch is
 * refused with `version_skew` and the mismatch named — honest refusal,
 * never silent degradation.
 */
export const RUNTIME_HOST_PROTOCOL_VERSION = 1;

/** Why an attach handshake was refused. Closed set; `detail` elaborates. */
export type AttachRefusalReason = "auth_failed" | "version_skew" | "malformed_hello";

// === Client → coordinator ====================================================

/** First message on every connection: protocol version + signed attach token. */
export interface HelloMessage {
  t: "hello";
  protocol_version: number;
  /** Device-key-signed token, `aud: "runtime:attach"` (see `@motebit/crypto` `createSignedToken`). */
  token: string;
}

/** Proxy a typed capability invocation to the coordinator's runtime. */
export interface InvokeMessage {
  t: "invoke";
  /** Caller-chosen correlation id; all response frames echo it. */
  id: string;
  capability: string;
  prompt: string;
  options?: Record<string, unknown>;
}

/**
 * Proxy one conversational turn to the coordinator's runtime
 * (`sendMessageStreaming`). Deliberately a distinct frame from
 * `invoke`: capabilities are deterministic affordances, chat is the AI
 * loop — the distinction stays typed end-to-end
 * (`docs/doctrine/surface-determinism.md`).
 */
export interface ChatMessage {
  t: "chat";
  id: string;
  text: string;
  options?: Record<string, unknown>;
}

/**
 * Resolve a pending approval surfaced by an `approval_request` chunk.
 * The chat stream ends after yielding the request; the continuation
 * turn streams back under THIS frame's id (mirrors the in-process
 * `resolveApprovalVote` shape).
 */
export interface ResolveApprovalMessage {
  t: "resolve_approval";
  id: string;
  approved: boolean;
  approver_id: string;
}

/** Subscribe this connection to a coordinator event channel. */
export interface SubscribeMessage {
  t: "subscribe";
  channel: string;
}

/** Unsubscribe this connection from an event channel. */
export interface UnsubscribeMessage {
  t: "unsubscribe";
  channel: string;
}

export type ClientMessage =
  | HelloMessage
  | InvokeMessage
  | ChatMessage
  | ResolveApprovalMessage
  | SubscribeMessage
  | UnsubscribeMessage;

// === Coordinator → client ====================================================

/** Handshake accepted; the connection is an attached frontend. */
export interface HelloAckMessage {
  t: "hello_ack";
  protocol_version: number;
  coordinator_pid: number;
}

/** Handshake refused; the coordinator closes the connection after sending. */
export interface RefuseMessage {
  t: "refuse";
  reason: AttachRefusalReason;
  detail: string;
}

/** One streamed chunk of an in-flight invocation. */
export interface ChunkMessage {
  t: "chunk";
  id: string;
  chunk: unknown;
}

/** Invocation completed; no more frames for this id. */
export interface EndMessage {
  t: "end";
  id: string;
}

/** Invocation failed; terminal for this id. */
export interface InvokeErrorMessage {
  t: "invoke_error";
  id: string;
  message: string;
}

/** Coordinator-pushed event on a subscribed channel. */
export interface EventMessage {
  t: "event";
  channel: string;
  payload: unknown;
}

export type ServerMessage =
  | HelloAckMessage
  | RefuseMessage
  | ChunkMessage
  | EndMessage
  | InvokeErrorMessage
  | EventMessage;

// === Framing =================================================================

/**
 * Ceiling on a single frame. A local peer streaming garbage (or a
 * non-protocol process that found the socket) must exhaust neither
 * memory nor patience: past the ceiling the decoder throws and the
 * connection is destroyed fail-closed.
 */
export const MAX_FRAME_BYTES = 4 * 1024 * 1024;

/** Encode one message as a `\n`-terminated JSON line. */
export function encodeFrame(message: ClientMessage | ServerMessage): string {
  return `${JSON.stringify(message)}\n`;
}

/**
 * Incremental newline-delimited JSON decoder. Feed raw socket bytes;
 * receive parsed objects. Throws on a frame past `MAX_FRAME_BYTES` or
 * on a line that is not a JSON object — callers destroy the connection
 * on throw (fail-closed; a garbled local stream has no recovery point).
 */
export class JsonLineDecoder {
  private buffer = "";

  push(data: string | Uint8Array): unknown[] {
    this.buffer += typeof data === "string" ? data : new TextDecoder().decode(data);
    if (this.buffer.length > MAX_FRAME_BYTES) {
      throw new Error(`frame exceeds ${MAX_FRAME_BYTES} bytes`);
    }
    const frames: unknown[] = [];
    let newline = this.buffer.indexOf("\n");
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (line.trim().length > 0) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch (err) {
          throw new Error(`malformed frame: ${err instanceof Error ? err.message : String(err)}`, {
            cause: err,
          });
        }
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("malformed frame: not a JSON object");
        }
        frames.push(parsed);
      }
      newline = this.buffer.indexOf("\n");
    }
    return frames;
  }
}
