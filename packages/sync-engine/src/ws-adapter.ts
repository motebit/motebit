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
    if (this.config.credentialSource) {
      const request: CredentialRequest = { serverUrl: this.config.url };
      void this.config.credentialSource.getCredential(request).then((token) => {
        this.connectWithToken(token ?? undefined);
      });
      return;
    }

    this.connectWithToken(this.config.authToken ?? undefined);
  }

  /** Internal: establish the WebSocket connection with an already-resolved token. */
  private connectWithToken(token: string | undefined): void {
    if (this.ws) return;

    let url =
      token != null && token !== ""
        ? `${this.config.url}?token=${encodeURIComponent(token)}`
        : this.config.url;

    if (this.config.capabilities && this.config.capabilities.length > 0) {
      const sep = url.includes("?") ? "&" : "?";
      url += `${sep}capabilities=${encodeURIComponent(this.config.capabilities.join(","))}`;
    }

    // Resolve WebSocket impl (async for Node <22 where ws must be imported).
    // If globalThis.WebSocket exists (Node 22+, browsers, tests), use it synchronously.
    // Otherwise, import ws and re-enter connectWithToken().
    if (typeof globalThis.WebSocket !== "undefined") {
      this.ws = new globalThis.WebSocket(url);
    } else if (_wsPackage) {
      this.ws = new _wsPackage(url) as unknown as WebSocket;
    } else {
      void resolveWebSocket().then(() => this.connectWithToken(token));
      return;
    }

    this.ws.onopen = () => {
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
    };

    this.ws.onmessage = (event: MessageEvent) => {
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

    this.ws.onclose = () => {
      this.connected = false;
      this.ws = null;
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
