import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { WebSocketEventStoreAdapter } from "../ws-adapter.js";
import { InMemoryEventStore } from "@motebit/event-log";
import { EventType } from "@motebit/sdk";
import type { EventLogEntry } from "@motebit/sdk";
import type { CredentialSource } from "../credential-source.js";

// ---------------------------------------------------------------------------
// Mock WebSocket
// ---------------------------------------------------------------------------

type WSListener = (event: { data: string }) => void;

class MockWebSocket {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: MockWebSocket[] = [];

  url: string;
  readyState = MockWebSocket.OPEN;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: WSListener | null = null;
  sent: string[] = [];
  closed = false;

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
    this.readyState = MockWebSocket.CLOSED;
  }

  // Test helpers
  simulateOpen(): void {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.();
  }

  simulateMessage(data: unknown): void {
    this.onmessage?.({ data: JSON.stringify(data) });
  }

  simulateClose(): void {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.();
  }

  simulateError(): void {
    this.onerror?.();
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const WS_URL = "ws://localhost:3000/sync/motebit-test";
const MOTEBIT_ID = "motebit-test";

function makeEvent(clock: number, payload: Record<string, unknown> = { clock }): EventLogEntry {
  return {
    event_id: `event-${clock}`,
    motebit_id: MOTEBIT_ID,
    device_id: "test-device",
    timestamp: Date.now(),
    event_type: EventType.StateUpdated,
    payload,
    version_clock: clock,
    tombstoned: false,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("WebSocketEventStoreAdapter", () => {
  let originalWebSocket: typeof globalThis.WebSocket;

  beforeEach(() => {
    vi.useFakeTimers();
    MockWebSocket.instances = [];
    originalWebSocket = globalThis.WebSocket;
    globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
  });

  afterEach(() => {
    globalThis.WebSocket = originalWebSocket;
    vi.useRealTimers();
  });

  function lastWS(): MockWebSocket {
    return MockWebSocket.instances[MockWebSocket.instances.length - 1]!;
  }

  // --- Lifecycle ---

  it("connect() creates a WebSocket with the correct URL", () => {
    const adapter = new WebSocketEventStoreAdapter({ url: WS_URL, motebitId: MOTEBIT_ID });
    adapter.connect();

    expect(MockWebSocket.instances).toHaveLength(1);
    expect(lastWS().url).toBe(WS_URL);
  });

  it("connect() appends auth token as query param", () => {
    const adapter = new WebSocketEventStoreAdapter({
      url: WS_URL,
      motebitId: MOTEBIT_ID,
      authToken: "secret-token",
    });
    adapter.connect();

    expect(lastWS().url).toBe(`${WS_URL}?token=secret-token`);
  });

  it("connect() URL-encodes auth token", () => {
    const adapter = new WebSocketEventStoreAdapter({
      url: WS_URL,
      motebitId: MOTEBIT_ID,
      authToken: "token with spaces&special=chars",
    });
    adapter.connect();

    expect(lastWS().url).toContain("token=token%20with%20spaces%26special%3Dchars");
  });

  it("connect() is idempotent — second call is a no-op", () => {
    const adapter = new WebSocketEventStoreAdapter({ url: WS_URL, motebitId: MOTEBIT_ID });
    adapter.connect();
    adapter.connect();

    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it("isConnected is false before connect, true after open", () => {
    const adapter = new WebSocketEventStoreAdapter({ url: WS_URL, motebitId: MOTEBIT_ID });
    expect(adapter.isConnected).toBe(false);

    adapter.connect();
    expect(adapter.isConnected).toBe(false);

    lastWS().simulateOpen();
    expect(adapter.isConnected).toBe(true);
  });

  it("disconnect() closes the WebSocket and resets state", () => {
    const adapter = new WebSocketEventStoreAdapter({ url: WS_URL, motebitId: MOTEBIT_ID });
    adapter.connect();
    lastWS().simulateOpen();

    adapter.disconnect();
    expect(adapter.isConnected).toBe(false);
    expect(lastWS().closed).toBe(true);
  });

  it("disconnect() clears pending reconnect timer", () => {
    const adapter = new WebSocketEventStoreAdapter({
      url: WS_URL,
      motebitId: MOTEBIT_ID,
      reconnectBaseMs: 1000,
    });
    adapter.connect();
    lastWS().simulateOpen();
    lastWS().simulateClose();

    // A reconnect is scheduled — disconnect should cancel it
    adapter.disconnect();

    // Advance past reconnect delay — should NOT create a new WebSocket
    vi.advanceTimersByTime(5000);
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  // --- append / push ---

  it("append() sends push message when connected", async () => {
    const adapter = new WebSocketEventStoreAdapter({ url: WS_URL, motebitId: MOTEBIT_ID });
    adapter.connect();
    lastWS().simulateOpen();

    const event = makeEvent(1);
    await adapter.append(event);

    expect(lastWS().sent).toHaveLength(1);
    const msg = JSON.parse(lastWS().sent[0]!) as { type: string; events: EventLogEntry[] };
    expect(msg.type).toBe("push");
    expect(msg.events).toHaveLength(1);
    expect(msg.events[0]!.event_id).toBe("event-1");
  });

  it("append() queues events when disconnected", async () => {
    const adapter = new WebSocketEventStoreAdapter({ url: WS_URL, motebitId: MOTEBIT_ID });
    // Don't connect — adapter is disconnected

    await adapter.append(makeEvent(1));
    await adapter.append(makeEvent(2));

    // No WebSocket exists, nothing sent
    expect(MockWebSocket.instances).toHaveLength(0);
  });

  it("pending events are flushed on connect", async () => {
    const adapter = new WebSocketEventStoreAdapter({ url: WS_URL, motebitId: MOTEBIT_ID });

    // Queue events while disconnected
    await adapter.append(makeEvent(1));
    await adapter.append(makeEvent(2));

    // Now connect
    adapter.connect();
    lastWS().simulateOpen();

    expect(lastWS().sent).toHaveLength(1);
    const msg = JSON.parse(lastWS().sent[0]!) as { type: string; events: EventLogEntry[] };
    expect(msg.events).toHaveLength(2);
    expect(msg.events[0]!.event_id).toBe("event-1");
    expect(msg.events[1]!.event_id).toBe("event-2");
  });

  // --- onEvent / message dispatch ---

  it("dispatches incoming events to onEvent callbacks", () => {
    const adapter = new WebSocketEventStoreAdapter({ url: WS_URL, motebitId: MOTEBIT_ID });
    const received: EventLogEntry[] = [];
    adapter.onEvent((e) => received.push(e));

    adapter.connect();
    lastWS().simulateOpen();

    const event = makeEvent(5);
    lastWS().simulateMessage({ type: "event", event });

    expect(received).toHaveLength(1);
    expect(received[0]!.event_id).toBe("event-5");
  });

  it("dispatches to multiple callbacks", () => {
    const adapter = new WebSocketEventStoreAdapter({ url: WS_URL, motebitId: MOTEBIT_ID });
    const a: EventLogEntry[] = [];
    const b: EventLogEntry[] = [];
    adapter.onEvent((e) => a.push(e));
    adapter.onEvent((e) => b.push(e));

    adapter.connect();
    lastWS().simulateOpen();
    lastWS().simulateMessage({ type: "event", event: makeEvent(1) });

    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
  });

  it("onEvent returns unsubscribe function", () => {
    const adapter = new WebSocketEventStoreAdapter({ url: WS_URL, motebitId: MOTEBIT_ID });
    const received: EventLogEntry[] = [];
    const unsub = adapter.onEvent((e) => received.push(e));

    adapter.connect();
    lastWS().simulateOpen();

    lastWS().simulateMessage({ type: "event", event: makeEvent(1) });
    expect(received).toHaveLength(1);

    unsub();
    lastWS().simulateMessage({ type: "event", event: makeEvent(2) });
    expect(received).toHaveLength(1); // no new event
  });

  it("ignores ack messages (no crash, no dispatch)", () => {
    const adapter = new WebSocketEventStoreAdapter({ url: WS_URL, motebitId: MOTEBIT_ID });
    const received: EventLogEntry[] = [];
    adapter.onEvent((e) => received.push(e));

    adapter.connect();
    lastWS().simulateOpen();

    lastWS().simulateMessage({ type: "ack", accepted: 3 });
    expect(received).toHaveLength(0);
  });

  it("ignores malformed messages without throwing", () => {
    const adapter = new WebSocketEventStoreAdapter({ url: WS_URL, motebitId: MOTEBIT_ID });
    adapter.connect();
    lastWS().simulateOpen();

    // Simulate raw invalid JSON
    expect(() => {
      lastWS().onmessage?.({ data: "not json{{{" });
    }).not.toThrow();
  });

  // --- Reconnect ---

  it("schedules reconnect on close with exponential backoff", () => {
    const adapter = new WebSocketEventStoreAdapter({
      url: WS_URL,
      motebitId: MOTEBIT_ID,
      reconnectBaseMs: 100,
      reconnectMaxMs: 10000,
    });
    adapter.connect();
    lastWS().simulateOpen();
    lastWS().simulateClose();
    expect(adapter.isConnected).toBe(false);

    // First reconnect at 100ms (attempt 0: 100 * 2^0)
    expect(MockWebSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(100);
    expect(MockWebSocket.instances).toHaveLength(2);

    // Close without opening — attempt counter stays incremented
    lastWS().simulateClose();

    // Second reconnect at 200ms (attempt 1: 100 * 2^1)
    vi.advanceTimersByTime(199);
    expect(MockWebSocket.instances).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(MockWebSocket.instances).toHaveLength(3);

    // Close again without opening
    lastWS().simulateClose();

    // Third reconnect at 400ms (attempt 2: 100 * 2^2)
    vi.advanceTimersByTime(399);
    expect(MockWebSocket.instances).toHaveLength(3);
    vi.advanceTimersByTime(1);
    expect(MockWebSocket.instances).toHaveLength(4);
  });

  it("caps reconnect delay at reconnectMaxMs", () => {
    const adapter = new WebSocketEventStoreAdapter({
      url: WS_URL,
      motebitId: MOTEBIT_ID,
      reconnectBaseMs: 500,
      reconnectMaxMs: 1000,
    });
    adapter.connect();

    // Force many reconnect attempts: 500, 1000, 1000, 1000...
    lastWS().simulateOpen();
    lastWS().simulateClose();
    vi.advanceTimersByTime(500); // attempt 0: 500ms
    expect(MockWebSocket.instances).toHaveLength(2);

    lastWS().simulateOpen();
    lastWS().simulateClose();
    vi.advanceTimersByTime(1000); // attempt 1: 1000ms
    expect(MockWebSocket.instances).toHaveLength(3);

    lastWS().simulateOpen();
    lastWS().simulateClose();
    vi.advanceTimersByTime(1000); // attempt 2: capped at 1000ms
    expect(MockWebSocket.instances).toHaveLength(4);
  });

  it("resets reconnect counter after 30s stable connection (hysteresis)", () => {
    const adapter = new WebSocketEventStoreAdapter({
      url: WS_URL,
      motebitId: MOTEBIT_ID,
      reconnectBaseMs: 100,
      reconnectMaxMs: 10000,
    });
    adapter.connect();
    lastWS().simulateOpen();
    lastWS().simulateClose();

    // First reconnect at 100ms (attempt 1)
    vi.advanceTimersByTime(100);
    expect(MockWebSocket.instances).toHaveLength(2);

    // Successful reconnect — hold for 30s stability window
    lastWS().simulateOpen();
    vi.advanceTimersByTime(30_000);
    lastWS().simulateClose();

    // Counter reset: next reconnect at base 100ms, not 200ms
    vi.advanceTimersByTime(100);
    expect(MockWebSocket.instances).toHaveLength(3);
  });

  it("keeps elevated backoff if connection drops before stability window", () => {
    const adapter = new WebSocketEventStoreAdapter({
      url: WS_URL,
      motebitId: MOTEBIT_ID,
      reconnectBaseMs: 100,
      reconnectMaxMs: 10000,
    });
    adapter.connect();
    lastWS().simulateOpen();
    lastWS().simulateClose();

    // Reconnect at 100ms (attempt 1)
    vi.advanceTimersByTime(100);
    expect(MockWebSocket.instances).toHaveLength(2);

    // Reconnect succeeds but drops after 5s (before 30s stability)
    lastWS().simulateOpen();
    vi.advanceTimersByTime(5_000);
    lastWS().simulateClose();

    // Backoff not reset: should be 200ms (attempt 2), not 100ms
    vi.advanceTimersByTime(100);
    expect(MockWebSocket.instances).toHaveLength(2); // not yet
    vi.advanceTimersByTime(100);
    expect(MockWebSocket.instances).toHaveLength(3); // 200ms → attempt 2
  });

  // --- Catch-up ---

  it("pulls missed events from httpFallback on connect", async () => {
    const httpFallback = new InMemoryEventStore();
    const localStore = new InMemoryEventStore();
    const onCatchUp = vi.fn();

    // Simulate missed events on the server
    await httpFallback.append(makeEvent(1));
    await httpFallback.append(makeEvent(2));

    const adapter = new WebSocketEventStoreAdapter({
      url: WS_URL,
      motebitId: MOTEBIT_ID,
      httpFallback,
      localStore,
      onCatchUp,
    });

    const received: EventLogEntry[] = [];
    adapter.onEvent((e) => received.push(e));

    adapter.connect();
    lastWS().simulateOpen();

    // catchUp is async — flush microtasks
    await vi.runAllTimersAsync();

    // Events should be written to local store
    const local = await localStore.query({ motebit_id: MOTEBIT_ID });
    expect(local).toHaveLength(2);

    // Events should be dispatched to onEvent callbacks
    expect(received).toHaveLength(2);

    // onCatchUp called with count
    expect(onCatchUp).toHaveBeenCalledWith(2);
  });

  it("catch-up skips events already in local store (after_version_clock)", async () => {
    const httpFallback = new InMemoryEventStore();
    const localStore = new InMemoryEventStore();

    // Local already has events up to clock 5
    await localStore.append(makeEvent(5));

    // Server has events 5, 6, 7
    await httpFallback.append(makeEvent(5));
    await httpFallback.append(makeEvent(6));
    await httpFallback.append(makeEvent(7));

    const adapter = new WebSocketEventStoreAdapter({
      url: WS_URL,
      motebitId: MOTEBIT_ID,
      httpFallback,
      localStore,
    });

    adapter.connect();
    lastWS().simulateOpen();
    await vi.runAllTimersAsync();

    // Should only pull events after clock 5
    const local = await localStore.query({ motebit_id: MOTEBIT_ID });
    // Original event-5 + caught-up event-6 and event-7
    expect(local).toHaveLength(3);
  });

  it("skips catch-up when no httpFallback configured", async () => {
    const adapter = new WebSocketEventStoreAdapter({
      url: WS_URL,
      motebitId: MOTEBIT_ID,
      // No httpFallback or localStore
    });

    // Should not throw
    adapter.connect();
    lastWS().simulateOpen();
    await vi.runAllTimersAsync();
  });

  // --- Passthrough / no-op methods ---

  it("query() always returns empty array", async () => {
    const adapter = new WebSocketEventStoreAdapter({ url: WS_URL, motebitId: MOTEBIT_ID });
    const result = await adapter.query({ motebit_id: MOTEBIT_ID });
    expect(result).toEqual([]);
  });

  it("getLatestClock() always returns 0", async () => {
    const adapter = new WebSocketEventStoreAdapter({ url: WS_URL, motebitId: MOTEBIT_ID });
    const clock = await adapter.getLatestClock(MOTEBIT_ID);
    expect(clock).toBe(0);
  });

  it("tombstone() resolves without error", async () => {
    const adapter = new WebSocketEventStoreAdapter({ url: WS_URL, motebitId: MOTEBIT_ID });
    await expect(adapter.tombstone("event-1", MOTEBIT_ID)).resolves.toBeUndefined();
  });

  // --- CredentialSource ---

  it("connect() resolves token from credentialSource and appends to URL", async () => {
    const credentialSource: CredentialSource = {
      getCredential: vi.fn().mockResolvedValue("dynamic-ws-token"),
    };

    const adapter = new WebSocketEventStoreAdapter({
      url: WS_URL,
      motebitId: MOTEBIT_ID,
      credentialSource,
    });
    adapter.connect();

    // credentialSource is async — flush the promise
    await vi.runAllTimersAsync();

    expect(MockWebSocket.instances).toHaveLength(1);
    expect(lastWS().url).toBe(`${WS_URL}?token=dynamic-ws-token`);
    expect(credentialSource.getCredential).toHaveBeenCalledWith({ serverUrl: WS_URL });
  });

  it("credentialSource takes precedence over authToken for WebSocket", async () => {
    const credentialSource: CredentialSource = {
      getCredential: vi.fn().mockResolvedValue("dynamic-token"),
    };

    const adapter = new WebSocketEventStoreAdapter({
      url: WS_URL,
      motebitId: MOTEBIT_ID,
      authToken: "static-token",
      credentialSource,
    });
    adapter.connect();
    await vi.runAllTimersAsync();

    expect(lastWS().url).toBe(`${WS_URL}?token=dynamic-token`);
  });

  it("credentialSource returning null omits token from URL", async () => {
    const credentialSource: CredentialSource = {
      getCredential: vi.fn().mockResolvedValue(null),
    };

    const adapter = new WebSocketEventStoreAdapter({
      url: WS_URL,
      motebitId: MOTEBIT_ID,
      credentialSource,
    });
    adapter.connect();
    await vi.runAllTimersAsync();

    expect(lastWS().url).toBe(WS_URL);
  });

  it("credentialSource is re-resolved on reconnect", async () => {
    let callCount = 0;
    const credentialSource: CredentialSource = {
      getCredential: vi.fn().mockImplementation(async () => `token-${++callCount}`),
    };

    const adapter = new WebSocketEventStoreAdapter({
      url: WS_URL,
      motebitId: MOTEBIT_ID,
      credentialSource,
      reconnectBaseMs: 100,
      reconnectMaxMs: 10000,
    });
    adapter.connect();
    await vi.runAllTimersAsync();

    expect(MockWebSocket.instances).toHaveLength(1);
    expect(lastWS().url).toContain("token=token-1");

    // Simulate open then close to trigger reconnect
    lastWS().simulateOpen();
    lastWS().simulateClose();

    // Advance past reconnect delay
    vi.advanceTimersByTime(100);
    await vi.runAllTimersAsync();

    expect(MockWebSocket.instances).toHaveLength(2);
    expect(lastWS().url).toContain("token=token-2");
    expect(credentialSource.getCredential).toHaveBeenCalledTimes(2);
  });
});
