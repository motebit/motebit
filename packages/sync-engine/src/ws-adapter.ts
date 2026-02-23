import type { EventLogEntry } from "@motebit/sdk";
import type { EventStoreAdapter, EventFilter } from "@motebit/event-log";

export interface WebSocketAdapterConfig {
  /** WebSocket URL, e.g. "ws://localhost:3000/sync/my-mote" */
  url: string;
  motebitId: string;
  authToken?: string;
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
  private config: Required<Omit<WebSocketAdapterConfig, "authToken" | "httpFallback" | "localStore" | "onCatchUp">> & Pick<WebSocketAdapterConfig, "authToken" | "httpFallback" | "localStore" | "onCatchUp">;
  private onEventCallbacks: Set<EventReceivedCallback> = new Set();
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
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

    const url = this.config.authToken != null && this.config.authToken !== ""
      ? `${this.config.url}?token=${encodeURIComponent(this.config.authToken)}`
      : this.config.url;

    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      this.connected = true;
      this.reconnectAttempt = 0;

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
        const msg = JSON.parse(String(event.data)) as
          | { type: "event"; event: EventLogEntry }
          | { type: "ack"; accepted: number };

        if (msg.type === "event") {
          for (const cb of this.onEventCallbacks) {
            cb(msg.event);
          }
        }
      } catch {
        // Ignore malformed messages
      }
    };

    this.ws.onclose = () => {
      this.connected = false;
      this.ws = null;
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
    return () => { this.onEventCallbacks.delete(callback); };
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
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
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
