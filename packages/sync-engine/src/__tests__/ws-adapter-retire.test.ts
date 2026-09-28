/**
 * A disconnected adapter stays down, and its offline queue can be handed on
 * (#816). A caller that replaces an adapter (the web/desktop/spatial token
 * refresh) retires the old one with `disconnect()`; before this, a connect
 * still in progress at that moment opened a socket anyway, and the auth
 * timer scheduled a reconnect — a retired adapter came back to life, open at
 * the relay and deaf.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { EventLogEntry } from "@motebit/sdk";
import { WebSocketEventStoreAdapter } from "../ws-adapter.js";
import type { CredentialSource } from "../credential-source.js";

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  readyState = 1;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  sent: string[] = [];
  constructor(public url: string) {
    MockWebSocket.instances.push(this);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 3;
  }
}

function entry(id: string): EventLogEntry {
  return {
    event_id: id,
    motebit_id: "m",
    timestamp: 0,
    event_type: "state_updated",
    payload: {},
    version_clock: 1,
    tombstoned: false,
  } as unknown as EventLogEntry;
}

const pushedIds = (ws: MockWebSocket): string[] =>
  ws.sent
    .map((s) => JSON.parse(s) as { type: string; events?: Array<{ event_id: string }> })
    .filter((f) => f.type === "push")
    .flatMap((f) => (f.events ?? []).map((e) => e.event_id));

describe("retiring an adapter", () => {
  let original: typeof globalThis.WebSocket;
  beforeEach(() => {
    vi.useFakeTimers();
    MockWebSocket.instances = [];
    original = globalThis.WebSocket;
    globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
  });
  afterEach(() => {
    globalThis.WebSocket = original;
    vi.useRealTimers();
  });

  it("disconnect while the credentialSource is still resolving opens no socket", async () => {
    let resolve: (t: string) => void = () => {};
    const source: CredentialSource = {
      getCredential: () => new Promise<string>((r) => (resolve = r)),
    };
    const adapter = new WebSocketEventStoreAdapter({
      url: "ws://relay/ws/sync/m",
      motebitId: "m",
      credentialSource: source,
    });
    adapter.connect();
    adapter.disconnect();
    resolve("late-token");
    await vi.advanceTimersByTimeAsync(60_000);

    expect(MockWebSocket.instances).toHaveLength(0);
  });

  it("disconnect mid-handshake: the auth timer never schedules a reconnect", async () => {
    const adapter = new WebSocketEventStoreAdapter({
      url: "ws://relay/ws/sync/m",
      motebitId: "m",
      authToken: "tok",
      reconnectBaseMs: 10,
    });
    adapter.connect();
    const ws = MockWebSocket.instances[0]!;
    ws.onopen?.(); // auth frame sent; no auth_result yet
    expect(ws.sent.some((s) => s.includes('"auth"'))).toBe(true);

    adapter.disconnect();
    await vi.advanceTimersByTimeAsync(60_000); // well past the 5s auth timeout

    expect(MockWebSocket.instances).toHaveLength(1);
    expect(adapter.isConnected).toBe(false);
  });

  it("a connect after disconnect still works (the generation only cancels what was in flight)", async () => {
    const source: CredentialSource = { getCredential: async () => "tok" };
    const adapter = new WebSocketEventStoreAdapter({
      url: "ws://relay/ws/sync/m",
      motebitId: "m",
      credentialSource: source,
    });
    adapter.connect();
    adapter.disconnect();
    adapter.connect();
    await vi.advanceTimersByTimeAsync(0);
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it("takePendingEvents hands the offline queue over exactly once", async () => {
    const old = new WebSocketEventStoreAdapter({ url: "ws://r/a", motebitId: "m", authToken: "t" });
    await old.append(entry("e1"));
    await old.append(entry("e2"));
    old.disconnect();

    const handed = old.takePendingEvents();
    expect(handed.map((e) => e.event_id)).toEqual(["e1", "e2"]);
    expect(old.takePendingEvents()).toEqual([]);

    const fresh = new WebSocketEventStoreAdapter({
      url: "ws://r/b",
      motebitId: "m",
      authToken: "t",
    });
    for (const e of handed) await fresh.append(e);
    fresh.connect();
    const ws = MockWebSocket.instances[0]!;
    ws.onopen?.();
    ws.onmessage?.({ data: JSON.stringify({ type: "auth_result", ok: true }) });

    expect(pushedIds(ws)).toEqual(["e1", "e2"]);

    // The retired adapter, reconnected, has nothing left to flush.
    old.connect();
    const ws2 = MockWebSocket.instances[1]!;
    ws2.onopen?.();
    ws2.onmessage?.({ data: JSON.stringify({ type: "auth_result", ok: true }) });
    expect(pushedIds(ws2)).toEqual([]);
  });
});
