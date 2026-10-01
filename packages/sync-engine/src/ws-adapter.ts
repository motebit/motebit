import type { EventLogEntry } from "@motebit/sdk";
import type { EventStoreAdapter, EventFilter } from "@motebit/event-log";
import type { CredentialSource, CredentialRequest } from "./credential-source.js";
import {
  isSeqPullSource,
  pullBySeq,
  relayStreamOfKey,
  resolveSeqCursorStore,
  warnSkippedSyncEvent,
  type SkippedSyncEvent,
  type SyncSeqCursorStore,
} from "./seq-cursor.js";
import { assertPushable, type RelayPayloadMode } from "./event-payload.js";
import { sanitizeRelayText } from "./relay-text.js";

// Resolve WebSocket: use the global (Node 22+, browsers) or fall back to the `ws` package (Node 20).
// globalThis.WebSocket is checked every time (tests may mock it). The `ws` import result is cached.
let _wsPackage: typeof globalThis.WebSocket | undefined;
async function resolveWebSocket(): Promise<typeof globalThis.WebSocket> {
  if (typeof globalThis.WebSocket !== "undefined") return globalThis.WebSocket;
  if (_wsPackage) return _wsPackage;
  const ws = await import("ws");
  _wsPackage = (ws.default ?? ws) as unknown as typeof globalThis.WebSocket;
  return _wsPackage;
}

export interface WebSocketAdapterConfig {
  /** WebSocket URL, e.g. "ws://localhost:3000/sync/my-mote" */
  url: string;
  motebitId: string;
  authToken?: string;
  /** Dynamic credential provider — takes precedence over authToken. Resolved at connect time. */
  credentialSource?: CredentialSource;
  /** Device capabilities to advertise on connect. */
  capabilities?: string[];
  /**
   * This device's id, declared on connect.
   *
   * The relay uses it to tell "two processes on one machine" (which
   * share a database, so either can answer for both) from "two
   * machines" (which do not). Without it the relay assigns a fresh
   * random id per connection, and the two cases are indistinguishable.
   */
  deviceId?: string;
  /** Reconnect delay base (ms). Doubles on each retry. */
  reconnectBaseMs?: number;
  /** Max reconnect delay (ms). */
  reconnectMaxMs?: number;
  /** HTTP adapter for catch-up pulls after reconnect */
  httpFallback?: EventStoreAdapter;
  /** Local event store for writing caught-up events */
  localStore?: EventStoreAdapter;
  /** Callback when catch-up pull completes */
  onCatchUp?: (pulled: number) => void;
  /**
   * Where the catch-up's relay-ingest-sequence cursor is kept (#868).
   * Default: `localStore` itself when it persists cursors, else process
   * memory keyed by `localStore` — shared with a replacement adapter over
   * the same store, so a token refresh does not restart from seq 0.
   */
  seqCursorStore?: SyncSeqCursorStore;
  /**
   * Told of every caught-up event moved past without being applied (#868) —
   * one this device cannot decrypt. Default: a `console.warn` line.
   */
  onSkippedEvent?: (skipped: SkippedSyncEvent) => void;
  /**
   * Told when a catch-up pull FAILS (#927) — a relay refusal the fallback's
   * one credential refresh did not cure, a network error, a refused page.
   * The catch-up is desktop's only pull door, so a failure is surfaced, never
   * swallowed: the caller puts it in its sync status. Default: a
   * `console.warn` line. The cursor never passes an unapplied event, and the
   * next reconnect retries.
   *
   * Also told when the `credentialSource` REJECTS at connect (#928 round 2):
   * the socket cannot connect without a token, so the failure is reported
   * here and a reconnect is scheduled on the usual backoff.
   */
  onCatchUpError?: (err: unknown) => void;
  /**
   * What this transport may push (#928). `e2e`: only E2E envelopes — a
   * plaintext payload is refused (the append rejects) before it is sent or
   * queued. A surface that holds a sync encryption key MUST build its socket
   * in `e2e` mode. Default `raw`.
   */
  payloads?: RelayPayloadMode;
  /**
   * How long an `append` waits for the relay's acknowledgment (#914), from
   * the call. Past it the append rejects — the sync engine then re-pushes the
   * event on a later sync — while an event still queued STAYS queued and goes
   * out on the next connection. A frame on the wire this long without an ack
   * takes its socket down, so a late ack can never be read as another
   * frame's. Default 15 000 ms.
   */
  pushAckTimeoutMs?: number;
}

/** The default `pushAckTimeoutMs`. */
const DEFAULT_PUSH_ACK_TIMEOUT_MS = 15_000;
/**
 * The most events one push frame carries. The relay sets no per-frame event
 * cap (services/relay/src/websocket.ts takes `msg.events` whole); its socket
 * server keeps the `ws` default 100 MiB payload limit. 500 events of a few KB
 * stays far below it.
 */
const MAX_EVENTS_PER_PUSH_FRAME = 500;
/**
 * Push-frame pacing (#914 round 2). The relay admits 100 messages per 10 s
 * per DEVICE — its limiter key is `ws:<motebit_id>:<device_id>`
 * (services/relay/src/websocket.ts), shared by every socket that device
 * opens — and answers the excess with `{type:"error", message:"Rate limit
 * exceeded"}`, dropping the frame unprocessed. Pushes use at most half of
 * that budget, leaving the rest for every other frame.
 *
 * The budget is kept per (socket URL, device id) for the whole process
 * (`sharedPushBudgets`), not per adapter: a token refresh opens a second
 * adapter for the same device, and both draw on the one relay budget. Two
 * PROCESSES of one device (a desktop app and a daemon sharing a device id)
 * cannot share it; each paces itself, and a burst from both can still reach
 * the relay's limit — then the refusal below fails the frame fast.
 */
const PUSH_FRAMES_PER_WINDOW = 50;
const PUSH_WINDOW_MS = 10_000;
/**
 * Push coalescing (#914 round 3). An append does not send at once: the frame
 * goes when no further append has arrived for PUSH_LINGER_MS, or
 * PUSH_LINGER_MAX_MS after the first, or when the frame is full — so a batch
 * appended together (the sync engine's `batch_size`) goes out as one frame.
 */
const PUSH_LINGER_MS = 15;
/** How far a frame's ack deadline stretches before its socket may be judged dead (× the base). */
const MAX_ACK_STRETCH = 64;
/** Full frames acked at the known-good frame size before a larger one is tried again. */
const PUSH_CEILING_PROBE_AFTER = 8;
const PUSH_LINGER_MAX_MS = 100;

/** What a link taught the socket about frame size (see `frame`). */
interface FrameState {
  limit: number;
  ceiling: number;
  fullAtCeiling: number;
  /**
   * The relay was last seen echoing `push_id`: a HINT that frames may
   * overlap, kept per relay stream (a token refresh or reconnect to the
   * same relay keeps its window). Never trusted for attribution (#914 round
   * 8): an ack that names no frame while more than one frame is in flight
   * on its socket credits NOTHING — see `onPushAnswered` — and turns the
   * hint off, so a relay restarted as an older version is found out on its
   * first ack.
   */
  echoes: boolean;
  /**
   * Push frames still on the wire on RETIRED sockets of this stream: they
   * drain beside the current socket's frames over the same uplink.
   */
  draining: Set<InFlightFrame>;
  /** Adapters waiting for a place in the stream's window (see `flushPush`). */
  waiting: Set<() => void>;
}

/** A push frame on the wire. */
interface InFlightFrame {
  id: string;
  /** Send order on this adapter: frames flushed in one tick share `sentAt`, never `seq`. */
  seq: number;
  socket: WebSocket;
  items: PendingPush[];
  timer: ReturnType<typeof setTimeout>;
  /** When the frame was sent. */
  sentAt: number;
  /**
   * When a frame sent AFTER this one on the same socket was answered by its
   * `push_id` while this one was not — evidence this one was lost (#914
   * round 8). Null until then.
   */
  overtakenAt: number | null;
  /** The frame's current ack deadline (ms from its send); stretched, never enforced by a kill. */
  deadlineMs: number;
}

/**
 * The catch-up running (or queued last) per local store and relay stream —
 * see `catchUp`. Keyed by the store object, so it goes with the store.
 */
const sharedCatchUps = new WeakMap<object, Map<string, Promise<void>>>();

/** The most push frames in flight at once, once the relay is seen echoing `push_id`. */
const PUSH_FRAME_WINDOW = 16;
/** Frame state per (socket URL, device id), shared by every adapter in the process. */
const sharedFrameStates = new Map<string, FrameState>();

/** Push-frame send times per (socket URL, device id), shared by every adapter in the process. */
const sharedPushBudgets = new Map<string, number[]>();

/** One caller waiting on the relay's acknowledgment of an appended event. */
interface PushWaiter {
  resolve: () => void;
  reject: (err: Error) => void;
  /** The waiter's deadline. */
  timer: ReturnType<typeof setTimeout> | null;
  settled: boolean;
}

/**
 * An event on its way to the relay, and everyone waiting on its ack. One per
 * event_id while queued: appending an event already queued joins it, so a
 * sync engine re-pushing through an outage never grows the queue.
 */
interface PendingPush {
  entry: EventLogEntry;
  waiters: PushWaiter[];
}

function settleWaiter(w: PushWaiter, err?: Error): void {
  if (w.timer) {
    clearTimeout(w.timer);
    w.timer = null;
  }
  if (w.settled) return;
  w.settled = true;
  if (err) w.reject(err);
  else w.resolve();
}

function clearWaiterTimer(w: PushWaiter): void {
  if (w.timer) {
    clearTimeout(w.timer);
    w.timer = null;
  }
}

function settle(item: PendingPush, err?: Error): void {
  for (const w of item.waiters) settleWaiter(w, err);
}

/** The default report of a failed catch-up: one warning line. */
function warnCatchUpError(err: unknown): void {
  // eslint-disable-next-line no-console -- the runtime's pluggable-logger default (CLAUDE.md conventions); callers pass onCatchUpError to route it
  console.warn(`sync: socket sync failed: ${err instanceof Error ? err.message : String(err)}`);
}

export type EventReceivedCallback = (event: EventLogEntry) => void;
export type CustomMessageCallback = (msg: { type: string; [key: string]: unknown }) => void;

/**
 * WebSocket-based EventStoreAdapter for real-time sync.
 *
 * Protocol:
 *   Client → Server:  { type: "push", events: EventLogEntry[] }
 *   Server → Client:  { type: "event", event: EventLogEntry }
 *   Server → Client:  { type: "ack", accepted: number }
 *   Server → Client:  { type: "error", message: "push refused: …" }
 *
 * `append` resolves when the relay ACKNOWLEDGED the event (#914) — not when
 * it was sent or queued. One push frame is on the wire at a time, so the
 * next `ack` on this socket is that frame's; events appended meanwhile wait
 * and go out together in the next frame. A frame's `ack` resolves each of
 * its appends; a `push refused` error, the socket closing, or no `ack` in
 * `pushAckTimeoutMs` rejects them (the last also takes the socket down, so a
 * late `ack` cannot be credited to the next frame). An event appended while
 * disconnected is queued (once per event_id) and goes out on the next
 * connection, or to a replacement adapter through `takePendingEvents`; its
 * append rejects at `pushAckTimeoutMs` if no ack came by then.
 * Incoming events from other devices are delivered via the onEvent callback.
 * Query/clock operations fall back to HTTP when the WS is unavailable.
 */
export class WebSocketEventStoreAdapter implements EventStoreAdapter {
  private ws: WebSocket | null = null;
  private config: Required<
    Omit<
      WebSocketAdapterConfig,
      | "authToken"
      | "credentialSource"
      | "capabilities"
      | "deviceId"
      | "httpFallback"
      | "localStore"
      | "onCatchUp"
      | "seqCursorStore"
      | "onSkippedEvent"
      | "onCatchUpError"
      | "payloads"
      | "pushAckTimeoutMs"
    >
  > &
    Pick<
      WebSocketAdapterConfig,
      | "authToken"
      | "credentialSource"
      | "capabilities"
      | "deviceId"
      | "httpFallback"
      | "localStore"
      | "onCatchUp"
      | "seqCursorStore"
      | "onSkippedEvent"
      | "onCatchUpError"
      | "payloads"
      | "pushAckTimeoutMs"
    >;
  private onEventCallbacks: Set<EventReceivedCallback> = new Set();
  private onCustomMessageCallbacks: Set<CustomMessageCallback> = new Set();
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stabilityTimer: ReturnType<typeof setTimeout> | null = null;
  private authTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Bumped by `disconnect()`. A connect still resolving its token or its
   * WebSocket implementation when the adapter is disconnected must not open
   * a socket afterwards (#816: a retired adapter came back to life).
   */
  private generation = 0;
  private connected = false;
  /** Appended events not yet in a frame (queued while offline, or behind the frame in flight). */
  private outbox: PendingPush[] = [];
  /**
   * What the link taught about frame size (#914 rounds 4–7). A frame not
   * acked in time halves the NEXT frames (down to 1; the late frame itself
   * stays in flight, never re-sent), and the size grows back by doubling
   * after full frames are acked, up to `ceiling`: the size known to fit —
   * which itself doubles after PUSH_CEILING_PROBE_AFTER full frames at it.
   *
   * Kept per (socket URL, device id) for the life of the process — beside
   * the pacing budget — never per adapter (#914 round 6): mobile rebuilds its
   * socket adapter every sync cycle, and a halved frame that never survives
   * the rebuild is re-sent at full size forever.
   */
  private get frame(): FrameState {
    let st = sharedFrameStates.get(this.pushBudgetKey);
    if (!st) {
      st = {
        limit: MAX_EVENTS_PER_PUSH_FRAME,
        ceiling: MAX_EVENTS_PER_PUSH_FRAME,
        fullAtCeiling: 0,
        echoes: false,
        draining: new Set(),
        waiting: new Set(),
      };
      sharedFrameStates.set(this.pushBudgetKey, st);
    }
    return st;
  }
  /** Told of every push frame sent or acked — the sync engine's watchdog. */
  private activityListeners = new Set<() => void>();
  /** A deferred flush (pacing). */
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  /** The linger: the idle timer (reset per append) and the cap (from the first). */
  private lingerIdle: ReturnType<typeof setTimeout> | null = null;
  private lingerCap: ReturnType<typeof setTimeout> | null = null;
  /**
   * Push frames awaiting their ack, oldest first. One at a time until the
   * relay is seen echoing `push_id` in its acks (then up to PUSH_FRAME_WINDOW
   * overlap, each ack matched to its frame by id): an ack that names no
   * frame can only be credited to the oldest, so without the echo only one
   * may be in flight (#914 round 7).
   */
  private inFlight: InFlightFrame[] = [];
  private frameSeq = 0;
  /**
   * `disconnect()` retired this adapter (until a `connect()`): nothing it
   * queues will ever be flushed, so it must queue nothing (#914 round 9).
   */
  private retired = false;
  /** This adapter instance — the sync engine's `pushTransport` (#914 round 9). */
  get pushTransport(): this {
    return this;
  }

  /**
   * Is `eventId` still on the wire through this adapter — in a frame in
   * flight (on any socket, a draining retired one included) or queued on an
   * adapter that is not retired? Its append will then be settled by this
   * adapter's own rules; the sync engine may keep waiting on it (#914 round
   * 9). Queued on a RETIRED adapter it is not: nothing will flush it.
   */
  holdsPush(eventId: string): boolean {
    if (this.inFlight.some((f) => f.items.some((i) => i.entry.event_id === eventId))) return true;
    return !this.retired && this.outbox.some((i) => i.entry.event_id === eventId);
  }
  /** When each socket last had a push frame answered: the dead rule is per socket. */
  private answeredAt = new WeakMap<WebSocket, number>();

  constructor(config: WebSocketAdapterConfig) {
    this.config = {
      reconnectBaseMs: 1_000,
      reconnectMaxMs: 30_000,
      ...config,
    };
  }

  // === Lifecycle ===

  connect(): void {
    if (this.ws) return;
    this.retired = false;

    // If a credentialSource is provided, resolve the token asynchronously
    // before establishing the connection. Falls back to static authToken.
    if (this.config.credentialSource) {
      const request: CredentialRequest = { serverUrl: this.config.url };
      const generation = this.generation;
      void this.config.credentialSource.getCredential(request).then(
        (token) => {
          if (generation !== this.generation) return;
          this.connectWithToken(token ?? undefined);
        },
        (err: unknown) => {
          // A failed mint used to be an unhandled rejection that left the
          // socket unconnected with no reconnect scheduled — silently
          // offline for good. Report it, then retry on the backoff (#928
          // round 2). A retired adapter does neither.
          if (generation !== this.generation) return;
          (this.config.onCatchUpError ?? warnCatchUpError)(
            new Error(
              `sync token unavailable: ${err instanceof Error ? err.message : String(err)}`,
              { cause: err },
            ),
          );
          this.scheduleReconnect();
        },
      );
      return;
    }

    this.connectWithToken(this.config.authToken ?? undefined);
  }

  /** Internal: establish the WebSocket connection with an already-resolved token. */
  private connectWithToken(token: string | undefined): void {
    if (this.ws) return;

    // Post-connect auth: never put tokens in the URL. Auth is sent as the first
    // WebSocket frame after the connection opens, avoiding exposure in server logs,
    // proxy logs, and browser history.
    let url = this.config.url;

    if (this.config.capabilities && this.config.capabilities.length > 0) {
      const sep = url.includes("?") ? "&" : "?";
      url += `${sep}capabilities=${encodeURIComponent(this.config.capabilities.join(","))}`;
    }
    if (this.config.deviceId != null && this.config.deviceId !== "") {
      const sep = url.includes("?") ? "&" : "?";
      url += `${sep}device_id=${encodeURIComponent(this.config.deviceId)}`;
    }

    // Resolve WebSocket impl (async for Node <22 where ws must be imported).
    // If globalThis.WebSocket exists (Node 22+, browsers, tests), use it synchronously.
    // Otherwise, import ws and re-enter connectWithToken().
    if (typeof globalThis.WebSocket !== "undefined") {
      this.ws = new globalThis.WebSocket(url);
    } else if (_wsPackage) {
      this.ws = new _wsPackage(url);
    } else {
      const generation = this.generation;
      void resolveWebSocket().then(() => {
        if (generation !== this.generation) return;
        this.connectWithToken(token);
      });
      return;
    }

    this.ws.onopen = () => {
      // Post-connect auth: if we have a token, send it as the first frame and
      // wait for auth_result before considering the connection ready. Fail-closed:
      // rejection or 5s timeout closes the connection.
      if (token != null && token !== "") {
        const socket = this.ws!;
        socket.send(JSON.stringify({ type: "auth", token }));

        const authTimeout = setTimeout(() => {
          // This timer belongs to `socket`. If that socket is gone (dropped,
          // replaced by a reconnect, or the adapter disconnected), it must
          // not close or reconnect anything (#816).
          if (this.ws !== socket) return;
          this.authTimer = null;
          // Auth timed out — fail-closed
          socket.onclose = null;
          socket.close();
          this.ws = null;
          this.connected = false;
          this.scheduleReconnect();
        }, 5_000);
        this.authTimer = authTimeout;

        // Temporarily override onmessage to intercept auth_result
        const originalOnMessage = this.ws!.onmessage;
        this.ws!.onmessage = (event: MessageEvent) => {
          try {
            const msg = JSON.parse(String(event.data)) as {
              type: string;
              ok?: boolean;
              error?: string;
            };
            if (msg.type === "auth_result") {
              clearTimeout(authTimeout);
              this.authTimer = null;
              if (!msg.ok) {
                // Auth rejected — close and schedule reconnect
                if (this.ws) {
                  this.ws.onclose = null;
                  this.ws.close();
                  this.ws = null;
                }
                this.connected = false;
                this.scheduleReconnect();
                return;
              }
              // Auth succeeded — restore normal message handler and mark ready
              this.ws!.onmessage = originalOnMessage;
              this.onAuthSuccess();
              return;
            }
          } catch {
            // Non-JSON or unexpected message during auth — ignore
          }
          // Forward non-auth messages to the normal handler
          if (this.ws) originalOnMessage?.call(this.ws, event);
        };
        return;
      }

      // No token — unauthenticated connection, ready immediately
      this.onAuthSuccess();
    };

    const thisSocket = this.ws;
    this.ws.onmessage = (event: MessageEvent) => {
      try {
        const msg = JSON.parse(String(event.data)) as { type: string; [key: string]: unknown };
        // A socket retired by `disconnect` while frames were in flight
        // drains: it still hears the answers to its frames, nothing else.
        if (this.ws !== thisSocket && msg.type !== "ack" && msg.type !== "error") return;

        if (msg.type === "event") {
          for (const cb of this.onEventCallbacks) {
            cb(msg.event as EventLogEntry);
          }
        } else if (msg.type === "ack") {
          this.onPushAnswered(
            thisSocket,
            undefined,
            typeof msg.push_id === "string" ? msg.push_id : undefined,
          );
        } else {
          if (
            msg.type === "error" &&
            typeof msg.message === "string" &&
            msg.message.startsWith("push refused")
          ) {
            // The relay refused the frame in flight (it answers a push with
            // an ack OR this error, never both).
            this.onPushAnswered(
              thisSocket,
              new Error(`sync push: ${sanitizeRelayText(msg.message)}`),
            );
          } else if (
            msg.type === "error" &&
            msg.message === "Rate limit exceeded" &&
            this.inFlight.some((f) => f.socket === thisSocket)
          ) {
            this.onPushRateLimited(thisSocket);
          }
          // Dispatch unrecognized message types to custom handlers
          for (const cb of this.onCustomMessageCallbacks) {
            cb(msg);
          }
        }
      } catch {
        // Ignore malformed messages
      }
    };

    this.ws.onclose = () => {
      this.failInFlight(new Error("sync push: the socket closed before the relay acknowledged"));
      for (const item of this.outbox) for (const w of item.waiters) this.armQueueDeadline(w);
      this.connected = false;
      this.ws = null;
      // The auth timer belongs to the socket that just closed.
      if (this.authTimer) {
        clearTimeout(this.authTimer);
        this.authTimer = null;
      }
      // Cancel stability timer — connection dropped before 30s, keep backoff elevated
      if (this.stabilityTimer) {
        clearTimeout(this.stabilityTimer);
        this.stabilityTimer = null;
      }
      this.scheduleReconnect();
    };

    this.ws.onerror = () => {
      // onclose will fire after onerror
    };
  }

  disconnect(): void {
    this.retired = true;
    this.frame.waiting.delete(this.wakeFlush);
    this.generation++;
    if (this.authTimer) {
      clearTimeout(this.authTimer);
      this.authTimer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.stabilityTimer) {
      clearTimeout(this.stabilityTimer);
      this.stabilityTimer = null;
    }
    if (this.ws) {
      const socket = this.ws;
      this.ws = null;
      if (socket.readyState === 1 && this.inFlight.some((f) => f.socket === socket)) {
        // Frames on the wire may still arrive and be acknowledged: the
        // socket drains — it closes when its last frame is answered, when it
        // closes itself, or when it is dead (#914 round 7). A frame never
        // loses its answer to a token refresh.
        for (const f of this.inFlight) if (f.socket === socket) this.frame.draining.add(f);
        socket.onclose = () => {
          this.failFramesOn(
            socket,
            new Error("sync push: the socket closed before the relay acknowledged"),
          );
        };
      } else {
        socket.onclose = null;
        socket.close();
      }
    }
    this.connected = false;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.endLinger();
    // Nothing this adapter still holds will be acknowledged through it. The
    // queued events stay queued for `takePendingEvents`; their appends
    // reject now, so the sync engine's cursor stays below them (#914).
    const retired = new Error(
      "sync push: the adapter was disconnected before the relay acknowledged",
    );
    for (const f of this.inFlight.filter((x) => x.socket.readyState !== 1)) {
      this.failFramesOn(f.socket, retired);
    }
    for (const item of this.outbox) settle(item, retired);
  }

  /**
   * Remove and return the events queued while this adapter was not
   * connected. A caller that replaces this adapter with another (a token
   * refresh) hands them to the replacement. Their appends here reject (the
   * relay never acknowledged them through this adapter), so the sync engine
   * pushes them again as well — a harmless duplicate, deduped by event_id.
   */
  takePendingEvents(): EventLogEntry[] {
    const taken = this.outbox.splice(0);
    const handed = new Error("sync push: handed to another adapter before the relay acknowledged");
    for (const item of taken) settle(item, handed);
    return taken.map((item) => item.entry);
  }

  get isConnected(): boolean {
    return this.connected;
  }

  // === Event Listener ===

  onEvent(callback: EventReceivedCallback): () => void {
    this.onEventCallbacks.add(callback);
    return () => {
      this.onEventCallbacks.delete(callback);
    };
  }

  /**
   * Register a handler for non-event/non-ack WebSocket messages.
   * Used by agent protocol for task_request, task_claimed, etc.
   */
  onCustomMessage(callback: CustomMessageCallback): () => void {
    this.onCustomMessageCallbacks.add(callback);
    return () => {
      this.onCustomMessageCallbacks.delete(callback);
    };
  }

  /**
   * Send an arbitrary JSON message over the WebSocket.
   * Used by agent protocol for task_claim messages.
   */
  sendRaw(data: string): void {
    if (!this.ws || this.ws.readyState !== 1 /* WebSocket.OPEN */) return;
    this.ws.send(data);
  }

  /**
   * Update and (re-)announce device capabilities.
   * Sends immediately if connected, otherwise included on next connect via URL param.
   */
  announceCapabilities(capabilities: string[]): void {
    this.config.capabilities = capabilities;
    if (this.connected && this.ws) {
      this.ws.send(JSON.stringify({ type: "capabilities_announce", capabilities }));
    }
  }

  // === EventStoreAdapter ===

  /**
   * Push one event. Resolves when the relay ACKNOWLEDGED the frame carrying
   * it (#914); rejects when it cannot know that (see the class comment).
   * Never resolves on send or on queue: the sync engine moves its push
   * cursor on this resolution.
   */
  append(entry: EventLogEntry): Promise<void> {
    // Fail closed before the entry is sent OR queued: an e2e socket never
    // carries plaintext (#928).
    try {
      assertPushable([entry], this.config.payloads ?? "raw");
    } catch (err: unknown) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
    let waiter!: PushWaiter;
    const acked = new Promise<void>((resolve, reject) => {
      waiter = { resolve, reject, timer: null, settled: false };
    });
    // A caller that hands events over without awaiting (a token refresh)
    // must not raise an unhandled rejection; an awaiting caller still sees it.
    acked.catch(() => {});
    // The ack deadline runs from when the event's FRAME is sent (the frame's
    // timer). While there is no connection to send it on, the wait is bounded
    // from now instead.
    if (!this.connected) this.armQueueDeadline(waiter);
    // An event whose frame is still in flight on a live socket is never sent
    // again: the new append waits on that frame's ack (#914 round 7).
    const flying = this.inFlight
      .flatMap((f) => f.items)
      .find((i) => i.entry.event_id === entry.event_id);
    if (flying) {
      flying.waiters.push(waiter);
      return acked;
    }
    const queued = this.outbox.find((i) => i.entry.event_id === entry.event_id);
    if (queued) {
      queued.entry = entry;
      queued.waiters.push(waiter);
    } else {
      this.outbox.push({ entry, waiters: [waiter] });
    }
    this.linger();
    return acked;
  }

  query(_filter: EventFilter): Promise<EventLogEntry[]> {
    // WebSocket adapter doesn't support query; SyncEngine uses local store for queries
    return Promise.resolve([]);
  }

  getLatestClock(_motebitId: string): Promise<number> {
    // Defer to HTTP fallback or local store
    return Promise.resolve(0);
  }

  async tombstone(_eventId: string, _motebitId: string): Promise<void> {
    // No-op for WebSocket
  }

  // === Internal ===

  /** Called when auth succeeds (or is skipped for unauthenticated connections). */
  private onAuthSuccess(): void {
    this.connected = true;
    // Stability hysteresis: don't reset backoff immediately — require 30s of
    // sustained connection. Prevents rapid reconnect cycles on flaky networks
    // from resetting the exponential backoff counter on each brief success.
    if (this.stabilityTimer) clearTimeout(this.stabilityTimer);
    this.stabilityTimer = setTimeout(() => {
      this.reconnectAttempt = 0;
    }, 30_000);

    // Send what was queued while offline. Connected again, a queued event's
    // wait is bounded by the frames ahead of it (each with its own deadline,
    // from its send), no longer by the offline deadline.
    for (const item of this.outbox) for (const w of item.waiters) clearWaiterTimer(w);
    this.flushPush();

    // Catch-up pull (fire and forget)
    void this.catchUp();
  }

  /**
   * Catch up after a connect — one catch-up at a time per relay stream and
   * local store (#914 round 7). A surface that reconnects before the last
   * catch-up finished (mobile rebuilds every cycle; a token refresh) waits
   * for it, then pulls from where it ended: never the same pages twice at
   * once on one link. A catch-up whose adapter was disconnected while it
   * waited is skipped; one already running continues.
   */
  private async catchUp(): Promise<void> {
    if (!this.config.httpFallback || !this.config.localStore) return;
    const fallback = this.config.httpFallback;
    const key = isSeqPullSource(fallback)
      ? fallback.seqCursorKey
      : `${this.config.url}#${this.config.motebitId}`;
    let perStore = sharedCatchUps.get(this.config.localStore);
    if (!perStore)
      sharedCatchUps.set(this.config.localStore, (perStore = new Map<string, Promise<void>>()));
    const generation = this.generation;
    const prior = perStore.get(key);
    // Waiting is worth it only while the running catch-up is bringing bytes
    // (a second would fetch the same pages over the same link at once). One
    // that is only waiting on a slow relay is not: this one starts now, and
    // may see what arrived since that request left.
    const busy = (fallback as { linkBusy?: () => boolean }).linkBusy?.() ?? true;
    const mine =
      prior && busy
        ? prior.then(() => {
            if (generation !== this.generation) return;
            return this.catchUpNow();
          })
        : this.catchUpNow();
    const tail = (prior ? Promise.all([prior, mine]) : mine).then(
      () => {},
      () => {},
    );
    perStore.set(key, tail);
    const table = perStore;
    try {
      await mine;
    } finally {
      if (table.get(key) === tail) table.delete(key);
    }
  }

  private async catchUpNow(): Promise<void> {
    if (!this.config.httpFallback || !this.config.localStore) return;
    const fallback = this.config.httpFallback;
    const localStore = this.config.localStore;
    if (isSeqPullSource(fallback)) {
      // #868: catch up by the relay ingest sequence. The local clock is sent
      // only as the fallback an older relay answers; it is never the cursor.
      try {
        const localClock = await localStore.getLatestClock(this.config.motebitId);
        const { fresh } = await pullBySeq({
          source: fallback,
          localStore,
          cursorStore: resolveSeqCursorStore(localStore, this.config.seqCursorStore),
          motebitId: this.config.motebitId,
          fallbackAfterClock: localClock,
          onSkipped: this.config.onSkippedEvent ?? warnSkippedSyncEvent,
        });
        // Only events this store did not already hold reach the listeners.
        for (const event of fresh) {
          for (const cb of this.onEventCallbacks) cb(event);
        }
        this.config.onCatchUp?.(fresh.length);
      } catch (err: unknown) {
        // Catch-up failed; the cursor was not advanced past anything
        // unapplied, and the next reconnect retries. Surfaced, never
        // swallowed (#927): this is the surface's only pull door.
        (this.config.onCatchUpError ?? warnCatchUpError)(err);
      }
      return;
    }
    try {
      const localClock = await this.config.localStore.getLatestClock(this.config.motebitId);
      const missed = await this.config.httpFallback.query({
        motebit_id: this.config.motebitId,
        after_version_clock: localClock,
      });
      for (const event of missed) {
        await this.config.localStore.append(event);
        for (const cb of this.onEventCallbacks) {
          cb(event);
        }
      }
      this.config.onCatchUp?.(missed.length);
    } catch (err: unknown) {
      // Catch-up failed; retried on the next reconnect. Surfaced (#927).
      (this.config.onCatchUpError ?? warnCatchUpError)(err);
    }
  }

  private get ackTimeoutMs(): number {
    return this.config.pushAckTimeoutMs ?? DEFAULT_PUSH_ACK_TIMEOUT_MS;
  }

  /**
   * Send the queued events as one frame — when connected, the socket open,
   * and no frame awaiting its ack. One frame in flight is what makes the
   * next `ack` on this socket this frame's (the relay's ack names no frame).
   */
  private flushPush(): void {
    const socket = this.ws;
    if (!this.connected || !socket || socket.readyState !== 1 /* WebSocket.OPEN */) return;
    if (this.lingerIdle || this.lingerCap) return; // the batch is still arriving
    // The window is the STREAM's: frames still draining on a retired socket
    // share the uplink with this one's, so they count against it too.
    const window = this.frame.echoes ? PUSH_FRAME_WINDOW : 1;
    const draining = this.frame.draining.size;
    if (this.outbox.length > 0 && this.inFlight.length + draining >= window) {
      this.frame.waiting.add(this.wakeFlush);
      return;
    }
    while (this.outbox.length > 0 && this.inFlight.length + draining < window) {
      // Pace: never more than PUSH_FRAMES_PER_WINDOW push frames per window,
      // counted per device across every adapter in this process.
      const now = Date.now();
      const sent = this.pushBudget().filter((t) => now - t < PUSH_WINDOW_MS);
      sharedPushBudgets.set(this.pushBudgetKey, sent);
      if (sent.length >= PUSH_FRAMES_PER_WINDOW) {
        this.deferFlush(sent[0]! + PUSH_WINDOW_MS - now);
        return;
      }
      if (this.flushTimer) {
        clearTimeout(this.flushTimer);
        this.flushTimer = null;
      }
      sent.push(now);
      const items = this.outbox.splice(0, this.frame.limit);
      // From here the frame's own deadline governs each event.
      for (const item of items) for (const w of item.waiters) clearWaiterTimer(w);
      const seq = ++this.frameSeq;
      const id = String(seq);
      // In flight BEFORE the send: an ack delivered during `send` is this frame's.
      const frame: InFlightFrame = {
        id,
        seq,
        socket,
        items,
        timer: setTimeout(() => this.onPushTimeout(socket, frame), this.ackTimeoutMs),
        sentAt: now,
        deadlineMs: this.ackTimeoutMs,
        overtakenAt: null,
      };
      this.inFlight.push(frame);
      try {
        socket.send(
          JSON.stringify({ type: "push", push_id: id, events: items.map((i) => i.entry) }),
        );
        this.active();
      } catch (err: unknown) {
        this.failInFlight(
          new Error(`sync push: send failed: ${err instanceof Error ? err.message : String(err)}`, {
            cause: err,
          }),
        );
        return;
      }
    }
  }

  private get pushBudgetKey(): string {
    return `${this.config.url}|${this.config.deviceId ?? ""}`;
  }

  private pushBudget(): number[] {
    return sharedPushBudgets.get(this.pushBudgetKey) ?? [];
  }

  /**
   * Hold the frame for the rest of the batch: send when no append has come
   * for PUSH_LINGER_MS, PUSH_LINGER_MAX_MS after the first, or at once when a
   * frame's worth is queued.
   */
  private linger(): void {
    // Offline, nothing lingers: the queue goes out whole on the connection.
    if (!this.connected) return;
    if (this.outbox.length >= MAX_EVENTS_PER_PUSH_FRAME) {
      this.endLinger();
      this.flushPush();
      return;
    }
    if (this.lingerIdle) clearTimeout(this.lingerIdle);
    this.lingerIdle = setTimeout(() => {
      this.endLinger();
      this.flushPush();
    }, PUSH_LINGER_MS);
    this.lingerCap ??= setTimeout(() => {
      this.endLinger();
      this.flushPush();
    }, PUSH_LINGER_MAX_MS);
  }

  private endLinger(): void {
    if (this.lingerIdle) clearTimeout(this.lingerIdle);
    if (this.lingerCap) clearTimeout(this.lingerCap);
    this.lingerIdle = null;
    this.lingerCap = null;
  }

  /** Bound a waiter while its event cannot be sent (no connection). */
  private armQueueDeadline(w: PushWaiter): void {
    if (w.settled || w.timer) return;
    w.timer = setTimeout(() => {
      w.timer = null;
      // Unknown whether the relay has it: the caller retries. A queued event
      // stays queued and still goes out on the next connection.
      settleWaiter(w, new Error("sync push: not acknowledged in time (not connected)"));
    }, this.ackTimeoutMs);
  }

  /** Flush after `ms`, unless a deferred flush is already pending. */
  private deferFlush(ms: number): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(
      () => {
        this.flushTimer = null;
        this.flushPush();
      },
      Math.max(0, ms),
    );
  }

  /**
   * The relay answered a frame on `socket`. An ack naming its `push_id`
   * settles that frame; one naming none settles the oldest (only one is ever
   * in flight then). A refusal names no frame: every frame on the socket
   * fails (the sync engine re-pushes; the relay dedups).
   */
  private onPushAnswered(socket: WebSocket, refused?: Error, pushId?: string): void {
    const mine = this.inFlight.filter((f) => f.socket === socket);
    if (mine.length === 0) return;
    let answered: InFlightFrame[];
    if (refused) answered = mine;
    else if (pushId !== undefined) {
      this.frame.echoes = true;
      const f = mine.find((x) => x.id === pushId);
      if (!f) return;
      answered = [f];
      // Every frame sent BEFORE it on this socket and still unanswered was
      // overtaken: its bytes reached the relay first, and the relay answered
      // the later one. One ack deadline from now it is judged lost.
      const now = Date.now();
      for (const earlier of mine) {
        if (earlier.seq >= f.seq || earlier.overtakenAt !== null) continue;
        earlier.overtakenAt = now;
        clearTimeout(earlier.timer);
        earlier.timer = setTimeout(() => this.onPushTimeout(socket, earlier), this.ackTimeoutMs);
      }
    } else {
      // An ack naming no frame: this relay does not echo (any more).
      this.frame.echoes = false;
      if (mine.length > 1) {
        // Frames overlapped on a relay that cannot say which one it
        // answered: crediting any would be a guess, and a guess can move
        // the cursor past an event the relay never stored. None is
        // credited; the socket is dropped and its frames fail — the sync
        // engine pushes them again, one frame at a time now (the relay
        // stores each event_id once).
        this.failFramesOn(socket, new Error("sync push: an ack named no frame of several"));
        if (this.ws === socket) this.dropSocket(socket);
        else this.closeIfDrained(socket);
        return;
      }
      answered = mine; // exactly one frame: the one this ack can only be for
    }
    this.answeredAt.set(socket, Date.now());
    for (const frame of answered) {
      clearTimeout(frame.timer);
      this.inFlight.splice(this.inFlight.indexOf(frame), 1);
      this.frame.draining.delete(frame);
      if (!refused) {
        this.active();
        if (frame.items.length >= this.frame.limit) this.fullFrameAcked();
      }
      for (const item of frame.items) settle(item, refused);
    }
    this.closeIfDrained(socket);
    this.flushPush();
    this.wakeWaiting();
  }

  /** A place in the stream's window opened: adapters waiting on it try again. */
  private wakeWaiting(): void {
    const waiting = [...this.frame.waiting];
    this.frame.waiting.clear();
    for (const wake of waiting) wake();
  }

  /** Try to send again (a place in the stream's window opened). */
  private readonly wakeFlush = (): void => {
    this.flushPush();
  };

  /** A retired socket whose last frame was answered is closed. */
  private closeIfDrained(socket: WebSocket): void {
    if (this.ws === socket || this.inFlight.some((f) => f.socket === socket)) return;
    socket.onclose = null;
    try {
      socket.close();
    } catch {
      // already closed
    }
  }

  /** Reject the frames in flight on `socket`: their answers can no longer be read. */
  private failFramesOn(socket: WebSocket, err: Error): void {
    for (const frame of this.inFlight.filter((f) => f.socket === socket)) {
      clearTimeout(frame.timer);
      this.inFlight.splice(this.inFlight.indexOf(frame), 1);
      this.frame.draining.delete(frame);
      for (const item of frame.items) settle(item, err);
    }
    this.wakeWaiting();
  }

  /** Reject every frame in flight: the relay's answers to them can no longer be read. */
  private failInFlight(err: Error): void {
    for (const frame of this.inFlight.splice(0)) {
      clearTimeout(frame.timer);
      this.frame.draining.delete(frame);
      for (const item of frame.items) settle(item, err);
    }
    this.wakeWaiting();
  }

  /**
   * The relay refused a message over its rate limit (#914 round 3) while a
   * push frame was in flight. The relay drops such a frame unprocessed, so it
   * is a definite answer: the frame fails at once rather than after the ack
   * deadline, and the budget is treated as spent for a whole window. The
   * refusal names no frame — it may have been another message's — so the
   * socket is taken down too, as on a timeout: an ack that still arrives for
   * this frame can never be credited to the next.
   */
  private onPushRateLimited(socket: WebSocket): void {
    const now = Date.now();
    sharedPushBudgets.set(
      this.pushBudgetKey,
      Array.from({ length: PUSH_FRAMES_PER_WINDOW }, () => now),
    );
    this.failFramesOn(socket, new Error("sync push: the relay's rate limit refused the frame"));
    if (this.ws === socket) this.dropSocket(socket);
    else this.closeIfDrained(socket); // a draining retired socket is closed too
  }

  /**
   * A frame's ack deadline passed (#914 round 7). A deadline changes
   * ADAPTATION only — it never destroys work that could still complete:
   *
   *   - the NEXT frames are halved (down to one event), and the halving is
   *     kept for the relay stream (`frame`), so a slow link converges;
   *   - THIS frame stays in flight on its socket, and its appends stay
   *     pending: a slow link still delivers it, and a relay that stores
   *     first and acks late still acks it — the cursor moves then;
   *   - its deadline doubles, and is re-armed.
   *
   * Two rules turn a late frame into a LOST one (#914 round 8) — evidence,
   * never elapsed time alone:
   *
   *   - OVERTAKEN: a frame sent after it on the same socket was answered by
   *     its `push_id`, and a further ack deadline has passed with this one
   *     still unanswered. Its bytes reached the relay first and the relay
   *     answered what came after: the relay dropped it. It is sent AGAIN,
   *     on the current socket (the relay stores each event_id once). This is
   *     the only re-send on the socket, and it never touches a frame whose
   *     answer could still come in order.
   *   - UNANSWERED: it is its stream's oldest frame on the wire, and its
   *     socket has answered nothing for 64 ack deadlines since it was sent.
   *     Inbound traffic (a sibling's events) does not count: a socket that
   *     delivers events but answers no push is not carrying pushes. The
   *     socket is dropped (a retired one closed) and its frames fail; the
   *     sync engine pushes them again. A frame queued behind an older frame
   *     of the stream — a retired socket draining over the same uplink — is
   *     never judged: only the oldest is.
   *
   * Close, error and a rate-limit refusal end a socket too, elsewhere.
   */
  private onPushTimeout(socket: WebSocket, frame: InFlightFrame): void {
    if (!this.inFlight.includes(frame) || frame.socket !== socket) return;
    if (frame.overtakenAt !== null && Date.now() - frame.overtakenAt >= this.ackTimeoutMs) {
      this.resendLost(frame);
      return;
    }
    const n = frame.items.length;
    // Each miss halves the next frames again (never the late frame itself).
    this.frame.limit = Math.max(1, Math.floor(Math.min(this.frame.limit, n) / 2));
    this.frame.ceiling = this.frame.limit;
    this.frame.fullAtCeiling = 0;
    const now = Date.now();
    const cap = this.ackTimeoutMs * MAX_ACK_STRETCH;
    // Unanswered since the frame went out, or since its socket last answered
    // a push frame. Only the stream's oldest frame on the wire is judged.
    const quietSince = Math.max(frame.sentAt, this.answeredAt.get(socket) ?? 0);
    let oldest = true;
    for (const f of [...this.inFlight, ...this.frame.draining]) {
      if (f.sentAt < frame.sentAt) oldest = false;
    }
    if (oldest && now - quietSince >= cap) {
      this.failFramesOn(socket, new Error("sync push: the socket answered nothing"));
      if (this.ws === socket) this.dropSocket(socket);
      else this.closeIfDrained(socket);
      return;
    }
    frame.deadlineMs = Math.min(cap, frame.deadlineMs * 2);
    const byDeadline = frame.sentAt + frame.deadlineMs;
    let next = byDeadline > now ? Math.min(byDeadline, quietSince + cap) : quietSince + cap;
    // Queued behind an older frame (or silent past the cap with no verdict):
    // look again a deadline on, never in a tight loop.
    if (next <= now) next = now + this.ackTimeoutMs;
    frame.timer = setTimeout(() => this.onPushTimeout(socket, frame), next - now);
  }

  /**
   * An OVERTAKEN frame (see `onPushTimeout`): lost at the relay. Its events
   * go back to the front of the queue — waiters and all — and out again on
   * the current socket.
   */
  private resendLost(frame: InFlightFrame): void {
    clearTimeout(frame.timer);
    this.inFlight.splice(this.inFlight.indexOf(frame), 1);
    this.frame.draining.delete(frame);
    if (this.retired) {
      // A retired adapter flushes nothing: re-queued here, the events would
      // wait forever (#914 round 9). Their appends fail, retryably; the
      // sync engine pushes them again through the live adapter.
      const lost = new Error(
        "sync push: the relay lost the frame, on a retired adapter — push again",
      );
      for (const item of frame.items) settle(item, lost);
    } else {
      this.outbox.unshift(...frame.items);
      // Not connected: queued events are bounded from now, as any queued one.
      if (!this.connected) {
        for (const item of frame.items) for (const w of item.waiters) this.armQueueDeadline(w);
      }
    }
    this.closeIfDrained(frame.socket);
    this.flushPush();
    this.wakeWaiting();
  }

  /**
   * The relay stream this socket's catch-ups read (the HTTP fallback's), so
   * the sync engine can ask what that relay has been seen to hold (#914
   * round 8). Undefined without a seq-pulling fallback.
   */
  get relayStreamKey(): string | undefined {
    const fallback = this.config.httpFallback;
    return fallback && isSeqPullSource(fallback)
      ? relayStreamOfKey(fallback.seqCursorKey)
      : undefined;
  }

  /**
   * Is there push work on the wire that may still complete — a frame in
   * flight on a live socket, or events queued behind it? The sync engine's
   * stall watchdog asks this, so a slow but live push is never abandoned.
   */
  hasLiveWork(): boolean {
    if (this.inFlight.some((f) => f.socket === this.ws)) return true;
    return this.connected && this.outbox.length > 0;
  }

  /** A full frame was acked: grow toward the ceiling, and probe past it now and then. */
  private fullFrameAcked(): void {
    if (this.frame.limit < this.frame.ceiling) {
      this.frame.limit = Math.min(this.frame.ceiling, this.frame.limit * 2);
      return;
    }
    if (this.frame.ceiling >= MAX_EVENTS_PER_PUSH_FRAME) return;
    if (++this.frame.fullAtCeiling >= PUSH_CEILING_PROBE_AFTER) {
      this.frame.fullAtCeiling = 0;
      this.frame.ceiling = Math.min(MAX_EVENTS_PER_PUSH_FRAME, this.frame.ceiling * 2);
      this.frame.limit = this.frame.ceiling;
    }
  }

  /**
   * Subscribe to push activity (a frame sent, a frame acked); the sync
   * engine's stall watchdog counts it as progress.
   */
  onActivity(listener: () => void): () => void {
    this.activityListeners.add(listener);
    return () => {
      this.activityListeners.delete(listener);
    };
  }

  private active(): void {
    for (const l of this.activityListeners) {
      try {
        l();
      } catch {
        // a listener never breaks a push
      }
    }
  }

  /** Close `socket` (if still current) and reconnect on the usual backoff. */
  private dropSocket(socket: WebSocket): void {
    if (this.ws !== socket) return;
    socket.onclose = null;
    socket.close();
    this.ws = null;
    this.connected = false;
    for (const item of this.outbox) for (const w of item.waiters) this.armQueueDeadline(w);
    if (this.stabilityTimer) {
      clearTimeout(this.stabilityTimer);
      this.stabilityTimer = null;
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;

    const delay = Math.min(
      this.config.reconnectBaseMs * Math.pow(2, this.reconnectAttempt),
      this.config.reconnectMaxMs,
    );
    this.reconnectAttempt++;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }
}
