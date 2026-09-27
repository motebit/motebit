/**
 * The adapter's `credentialSource` is resolved on EVERY (re)connect, and
 * each connect presents the token that call returned (#820). A long-lived
 * client depends on this: its signed tokens expire, and the adapter
 * reconnects on its own. The static `authToken` form still presents its
 * one string every time, for the callers that rebuild the adapter instead.
 *
 * A separate file from `ws-adapter.test.ts` on purpose: the adapter itself
 * is not changed here, only its existing contract pinned.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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
  /** Open, then accept whatever auth frame was sent. */
  openAndAccept(): void {
    this.onopen?.();
    this.onmessage?.({ data: JSON.stringify({ type: "auth_result", ok: true }) });
  }
  drop(): void {
    this.readyState = 3;
    this.onclose?.();
  }
  authToken(): string | undefined {
    const frame = this.sent.map((s) => JSON.parse(s) as { type: string; token?: string });
    return frame.find((f) => f.type === "auth")?.token;
  }
}

const last = () => MockWebSocket.instances[MockWebSocket.instances.length - 1]!;

describe("credentials across reconnects", () => {
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

  it("a credentialSource is called on every reconnect, and each connect presents that call's token", async () => {
    let n = 0;
    const source: CredentialSource = { getCredential: vi.fn(async () => `tok-${++n}`) };
    const adapter = new WebSocketEventStoreAdapter({
      url: "ws://relay/ws/sync/m",
      motebitId: "m",
      credentialSource: source,
      reconnectBaseMs: 10,
    });

    adapter.connect();
    await vi.advanceTimersByTimeAsync(0);
    last().openAndAccept();
    expect(last().authToken()).toBe("tok-1");

    for (const expected of ["tok-2", "tok-3"]) {
      last().drop();
      await vi.advanceTimersByTimeAsync(1_000);
      last().openAndAccept();
      expect(last().authToken()).toBe(expected);
    }
    expect(source.getCredential).toHaveBeenCalledTimes(3);
    adapter.disconnect();
  });

  it("the static authToken form still presents its one string on every connect", async () => {
    const adapter = new WebSocketEventStoreAdapter({
      url: "ws://relay/ws/sync/m",
      motebitId: "m",
      authToken: "static",
      reconnectBaseMs: 10,
    });
    adapter.connect();
    last().openAndAccept();
    expect(last().authToken()).toBe("static");
    last().drop();
    await vi.advanceTimersByTimeAsync(1_000);
    last().openAndAccept();
    expect(last().authToken()).toBe("static");
    expect(MockWebSocket.instances).toHaveLength(2);
    adapter.disconnect();
  });
});
