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
 *
 * v2 (2026-06-12): `query` / `act` frame pairs — attach-mode parity
 * (reads and acts against the coordinator's interior).
 */
export const RUNTIME_HOST_PROTOCOL_VERSION = 2;

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

/**
 * Read a record set from the coordinator's interior (attach-mode
 * parity). `kind` is opaque to the transport — the closed registry of
 * read kinds lives with the record owner (`@motebit/runtime`'s
 * `resolveAttachedRead`), exactly as `invoke` carries opaque capability
 * names. Answered by `query_result` / `query_error`. Reads return
 * records and carry no authority fields.
 */
export interface QueryMessage {
  t: "query";
  id: string;
  kind: string;
  params?: Record<string, unknown>;
}

/**
 * Perform a typed panel act against the coordinator's interior
 * (delete/pin/form memory, set petname, …). Deliberately a distinct
 * frame from `query` — records vs acts stays typed end-to-end
 * (`docs/doctrine/records-vs-acts.md`) — and from `invoke`, which is
 * relay delegation, not a local act. The closed act registry lives in
 * `@motebit/runtime`'s `resolveAttachedAct`; money-shaped acts are
 * structurally absent from it. Answered by `query_result` /
 * `query_error`.
 */
export interface ActMessage {
  t: "act";
  id: string;
  kind: string;
  params?: Record<string, unknown>;
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

/**
 * Declare this frontend's contributed organs — the capability-bridging
 * half of the election doctrine: whichever process coordinates, an
 * attached process's unique capabilities (desktop SE-attest,
 * computer-use, …) stay reachable through the coordinator. Idempotent
 * replace of this connection's set.
 */
export interface RegisterCapabilitiesMessage {
  t: "register_capabilities";
  capabilities: string[];
}

/** One streamed chunk of a coordinator-initiated bridged invocation. */
export interface BridgeChunkMessage {
  t: "bridge_chunk";
  id: string;
  chunk: unknown;
}

/** Bridged invocation completed on the frontend. */
export interface BridgeEndMessage {
  t: "bridge_end";
  id: string;
}

/** Bridged invocation failed on the frontend; terminal for this id. */
export interface BridgeErrorMessage {
  t: "bridge_error";
  id: string;
  message: string;
}

export type ClientMessage =
  | HelloMessage
  | InvokeMessage
  | ChatMessage
  | ResolveApprovalMessage
  | QueryMessage
  | ActMessage
  | SubscribeMessage
  | UnsubscribeMessage
  | RegisterCapabilitiesMessage
  | BridgeChunkMessage
  | BridgeEndMessage
  | BridgeErrorMessage;

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

/** Successful answer to a `query` or `act` frame; terminal for its id. */
export interface QueryResultMessage {
  t: "query_result";
  id: string;
  payload: unknown;
}

/**
 * A `query` or `act` refused or failed; terminal for its id. Unknown
 * kinds, malformed params, and a coordinator that serves no
 * query/act seam all answer here — honest error, never a hang.
 */
export interface QueryErrorMessage {
  t: "query_error";
  id: string;
  message: string;
}

/** Coordinator-pushed event on a subscribed channel. */
export interface EventMessage {
  t: "event";
  channel: string;
  payload: unknown;
}

/**
 * Coordinator-initiated invocation of a capability this frontend
 * registered via `register_capabilities` — the reverse channel that
 * makes the election outcome operationally neutral. The frontend
 * answers with `bridge_chunk*` then `bridge_end` (or `bridge_error`).
 */
export interface BridgeInvokeMessage {
  t: "bridge_invoke";
  id: string;
  capability: string;
  prompt: string;
  options?: Record<string, unknown>;
}

export type ServerMessage =
  | HelloAckMessage
  | RefuseMessage
  | ChunkMessage
  | EndMessage
  | InvokeErrorMessage
  | QueryResultMessage
  | QueryErrorMessage
  | EventMessage
  | BridgeInvokeMessage;

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
  // Streaming decoder: a multibyte UTF-8 character split across two
  // socket chunks must not corrupt — `stream: true` holds the partial
  // sequence until its continuation bytes arrive.
  private readonly utf8 = new TextDecoder();

  push(data: string | Uint8Array): unknown[] {
    this.buffer += typeof data === "string" ? data : this.utf8.decode(data, { stream: true });
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
