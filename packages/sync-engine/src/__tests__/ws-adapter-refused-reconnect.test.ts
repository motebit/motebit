/**
 * #1159: a host whose relay refuses the connection must reconnect on the
 * backoff, whatever the runtime's WebSocket does after `error`.
 *
 * Node 22's built-in WebSocket fires `error` on a refused connection and then
 * stays CONNECTING forever, never `close`. The adapter scheduled reconnects
 * only from `onclose`, so on Node 22 a refused first connect was never
 * retried. This drives the REAL runtime WebSocket against a refused port and
 * counts the sockets the adapter opens; it is red on Node 22 without the fix
 * (one socket, forever) and green on runtimes that fire `close`.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer } from "node:net";
import { WebSocketEventStoreAdapter } from "../ws-adapter.js";

/** A local port with nothing listening: bind, read the port, close. */
async function refusedPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

describe("refused connection reconnects on the backoff (#1159)", () => {
  const Runtime = globalThis.WebSocket;
  let opened = 0;
  let adapter: WebSocketEventStoreAdapter | undefined;

  beforeEach(() => {
    opened = 0;
    class Counting extends Runtime {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        opened += 1;
      }
    }
    globalThis.WebSocket = Counting as typeof WebSocket;
  });

  afterEach(() => {
    adapter?.disconnect();
    adapter = undefined;
    globalThis.WebSocket = Runtime;
  });

  it("opens a second socket after the first is refused", async () => {
    const port = await refusedPort();
    adapter = new WebSocketEventStoreAdapter({
      url: `ws://127.0.0.1:${port}/ws/sync/m`,
      motebitId: "m",
      reconnectBaseMs: 10,
      reconnectMaxMs: 20,
    });
    adapter.connect();
    await expect.poll(() => opened, { timeout: 3000, interval: 10 }).toBeGreaterThanOrEqual(2);
  });

  it("a refused socket schedules one reconnect, not one per event", async () => {
    const port = await refusedPort();
    adapter = new WebSocketEventStoreAdapter({
      url: `ws://127.0.0.1:${port}/ws/sync/m`,
      motebitId: "m",
      reconnectBaseMs: 200,
      reconnectMaxMs: 200,
    });
    adapter.connect();
    // Inside the first backoff window exactly one socket exists: the error
    // and any late real `close` must not each schedule a reconnect.
    await new Promise((r) => setTimeout(r, 100));
    expect(opened).toBe(1);
    await expect.poll(() => opened, { timeout: 3000, interval: 10 }).toBeGreaterThanOrEqual(2);
  });
});
