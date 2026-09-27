import type { EventLogEntry } from "@motebit/sdk";
import type { EventStoreAdapter, EventFilter } from "@motebit/event-log";
import type { CredentialSource, CredentialRequest } from "./credential-source.js";

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
 *
 * The adapter pushes events immediately over the WebSocket.
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
    >;
  private onEventCallbacks: Set<EventReceivedCallback> = new Set();
  private onCustomMessageCallbacks: Set<CustomMessageCallback> = new Set();
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stabilityTimer: ReturnType<typeof setTimeout> | null = null;
  private connected = false;
  private pendingEvents: EventLogEntry[] = [];
  /**
   * Bumped by every `disconnect()`. A connect that is still resolving its
   * credential (or the `ws` import) when the adapter is disconnected must
   * not open a socket afterwards — that socket would belong to nobody:
   * open at the relay, counted in its liveness, and never closed.
   */
  private connectGeneration = 0;
  /** The pending auth-handshake timeout of the current socket, if any. */
  private authTimer: ReturnType<typeof setTimeout> | null = null;

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

    // If a credentialSource is provided, resolve the token asynchronously
    // before establishing the connection. Falls back to static authToken.
    const generation = this.connectGeneration;
    if (this.config.credentialSource) {
      const request: CredentialRequest = { serverUrl: this.config.url };
      void this.config.credentialSource.getCredential(request).then(
        (token) => {
          this.connectWithToken(token ?? undefined, generation);
        },
        () => {
          // No credential this time — retry with backoff, unless this
          // connect was abandoned by a disconnect() meanwhile.
          if (generation === this.connectGeneration) this.scheduleReconnect();
        },
      );
      return;
    }

    this.connectWithToken(this.config.authToken ?? undefined, generation);
  }

  /**
   * Replace the socket with a fresh one, re-resolving the credential.
   *
   * This is the token-refresh door. It keeps the ADAPTER and swaps only the
   * socket, so every `onEvent` / `onCustomMessage` handler, the pending
   * outbound events, and the config callbacks (`onCatchUp`) carry over by
   * construction — a refresh cannot leave a handler behind, and it cannot
   * leave the replaced socket open. (Building a new adapter per refresh did
   * both: the handlers stayed on the first adapter, and the refresh closed
   * the first adapter's socket every time, so every intermediate socket
   * stayed open and deaf — #816.)
   *
   * Order: the old socket closes before the new one opens, so the relay
   * never holds two sockets for this adapter. Events published in the gap
   * are recovered by the catch-up pull the new socket runs on auth success
   * (`httpFallback` + `localStore`), the same path an ordinary drop and
   * reconnect takes — PROVIDED the `httpFallback` can still authenticate:
   * give it a per-request credential source too, or a pull made after its
   * static token expired is refused and the gap is lost.
   *
   * A relay command addressed to this device during the gap is not
   * answered by this adapter. The relay either no longer lists the socket
   * (404 "Agent not connected" when it was the device's only one, or
   * another of the owner's sockets takes it), or still lists it as open
   * while the close is in flight, in which case the frame is swallowed and
   * the caller gets a 504 (no answer, or "closed_after_delivery"). Either
   * way the caller is told nothing answered — never a false success.
   *
   * Use a `credentialSource` for a refresh to carry a new token; with a
   * static `authToken` it reconnects with the same one.
   */
  refreshConnection(): void {
    this.disconnect();
    this.connect();
  }

  /** Internal: establish the WebSocket connection with an already-resolved token. */
  private connectWithToken(token: string | undefined, generation: number): void {
    if (this.ws) return;
    if (generation !== this.connectGeneration) return;

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
    let ws: WebSocket;
    if (typeof globalThis.WebSocket !== "undefined") {
      ws = new globalThis.WebSocket(url);
    } else if (_wsPackage) {
      ws = new _wsPackage(url);
    } else {
      void resolveWebSocket().then(() => this.connectWithToken(token, generation));
      return;
    }
    this.ws = ws;
    // Every callback below belongs to THIS socket of THIS connect. After a
    // disconnect() or a refresh, a late callback of the replaced socket must
    // not touch the adapter: an auth timeout firing on a stopped adapter
    // would schedule a reconnect (a socket after stop), and one firing after
    // a refresh would close the NEW, authenticated socket.
    const stale = (): boolean => generation !== this.connectGeneration || this.ws !== ws;

    ws.onopen = () => {
      if (stale()) return;
      // Post-connect auth: if we have a token, send it as the first frame and
      // wait for auth_result before considering the connection ready. Fail-closed:
      // rejection or 5s timeout closes the connection.
      if (token != null && token !== "") {
        ws.send(JSON.stringify({ type: "auth", token }));

        this.clearAuthTimer();
        this.authTimer = setTimeout(() => {
          this.authTimer = null;
          if (stale()) return;
          // Auth timed out — fail-closed
          ws.onclose = null;
          ws.close();
          this.ws = null;
          this.connected = false;
          this.scheduleReconnect();
        }, 5_000);

        // Temporarily override onmessage to intercept auth_result
        const originalOnMessage = ws.onmessage;
        ws.onmessage = (event: MessageEvent) => {
          if (stale()) return;
          try {
            const msg = JSON.parse(String(event.data)) as {
              type: string;
              ok?: boolean;
              error?: string;
            };
            if (msg.type === "auth_result") {
              this.clearAuthTimer();
              if (!msg.ok) {
                // Auth rejected — close and schedule reconnect
                ws.onclose = null;
                ws.close();
                this.ws = null;
                this.connected = false;
                this.scheduleReconnect();
                return;
              }
              // Auth succeeded — restore normal message handler and mark ready
              ws.onmessage = originalOnMessage;
              this.onAuthSuccess();
              return;
            }
          } catch {
            // Non-JSON or unexpected message during auth — ignore
          }
          // Forward non-auth messages to the normal handler
          originalOnMessage?.call(ws, event);
        };
        return;
      }

      // No token — unauthenticated connection, ready immediately
      this.onAuthSuccess();
    };

    ws.onmessage = (event: MessageEvent) => {
      if (stale()) return;
      try {
        const msg = JSON.parse(String(event.data)) as { type: string; [key: string]: unknown };

        if (msg.type === "event") {
          for (const cb of this.onEventCallbacks) {
            cb(msg.event as EventLogEntry);
          }
        } else if (msg.type !== "ack") {
          // Dispatch unrecognized message types to custom handlers
          for (const cb of this.onCustomMessageCallbacks) {
            cb(msg);
          }
        }
      } catch {
        // Ignore malformed messages
      }
    };

    ws.onclose = () => {
      if (stale()) return;
      this.clearAuthTimer();
      this.connected = false;
      this.ws = null;
      // Cancel stability timer — connection dropped before 30s, keep backoff elevated
      if (this.stabilityTimer) {
        clearTimeout(this.stabilityTimer);
        this.stabilityTimer = null;
      }
      this.scheduleReconnect();
    };

    ws.onerror = () => {
      // onclose will fire after onerror
    };
  }

  disconnect(): void {
    this.connectGeneration++;
    this.clearAuthTimer();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.stabilityTimer) {
      clearTimeout(this.stabilityTimer);
      this.stabilityTimer = null;
    }
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
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

  append(entry: EventLogEntry): Promise<void> {
    if (this.connected && this.ws) {
      this.sendPush([entry]);
    } else {
      this.pendingEvents.push(entry);
    }
    return Promise.resolve();
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

  private clearAuthTimer(): void {
    if (this.authTimer) {
      clearTimeout(this.authTimer);
      this.authTimer = null;
    }
  }

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

    // Flush pending events
    if (this.pendingEvents.length > 0) {
      const events = this.pendingEvents.splice(0);
      this.sendPush(events);
    }

    // Catch-up pull (fire and forget)
    void this.catchUp();
  }

  private async catchUp(): Promise<void> {
    if (!this.config.httpFallback || !this.config.localStore) return;
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
    } catch {
      // Catch-up failed, will retry on next reconnect
    }
  }

  private sendPush(events: EventLogEntry[]): void {
    if (!this.ws || this.ws.readyState !== 1 /* WebSocket.OPEN */) return;
    this.ws.send(JSON.stringify({ type: "push", events }));
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
