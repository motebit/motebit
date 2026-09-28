/**
 * #816 — on a runtime with no global WebSocket (Node 20), the adapter imports
 * `ws` on first connect. A `disconnect()` while that import is resolving must
 * cancel the connect, exactly as it does for a pending credential.
 *
 * Its own file: the adapter caches the imported `ws` class at module scope,
 * so the import is only asynchronous the first time in a module instance.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const created = vi.hoisted(() => ({ urls: [] as string[] }));

vi.mock("ws", () => {
  class NodeWebSocket {
    readyState = 0;
    onopen: (() => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onmessage: ((e: { data: string }) => void) | null = null;
    constructor(url: string) {
      created.urls.push(url);
    }
    send(): void {}
    close(): void {
      this.readyState = 3;
    }
  }
  return { default: NodeWebSocket };
});

import { WebSocketEventStoreAdapter } from "../ws-adapter.js";

describe("retiring an adapter while `ws` is still being imported", () => {
  let original: typeof globalThis.WebSocket | undefined;
  beforeEach(() => {
    created.urls = [];
    original = globalThis.WebSocket;
    // Model Node 20: no global WebSocket, so the adapter imports `ws`.
    delete (globalThis as { WebSocket?: unknown }).WebSocket;
  });
  afterEach(() => {
    if (original !== undefined) globalThis.WebSocket = original;
  });

  it("disconnect before the import resolves opens no socket", async () => {
    const adapter = new WebSocketEventStoreAdapter({
      url: "ws://relay/ws/sync/m",
      motebitId: "m",
      authToken: "tok",
    });
    adapter.connect();
    adapter.disconnect();
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));

    expect(created.urls).toHaveLength(0);
  });
});
