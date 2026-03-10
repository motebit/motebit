import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { HttpEventStoreAdapter } from "../http-adapter.js";
import { EventType } from "@motebit/sdk";
import type { EventLogEntry } from "@motebit/sdk";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE_URL = "http://localhost:3000";
const MOTEBIT_ID = "motebit-test";
const AUTH_TOKEN = "test-token";

function makeEvent(clock: number): EventLogEntry {
  return {
    event_id: `event-${clock}`,
    motebit_id: MOTEBIT_ID,
    device_id: "test-device",
    timestamp: Date.now(),
    event_type: EventType.StateUpdated,
    payload: { clock },
    version_clock: clock,
    tombstoned: false,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("HttpEventStoreAdapter", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("append sends POST to push endpoint with correct URL and auth header", async () => {
    const mockFn = globalThis.fetch as ReturnType<typeof vi.fn>;
    mockFn.mockResolvedValueOnce(new Response(JSON.stringify({ accepted: 1 }), { status: 200 }));

    const adapter = new HttpEventStoreAdapter({
      baseUrl: BASE_URL,
      motebitId: MOTEBIT_ID,
      authToken: AUTH_TOKEN,
    });

    const event = makeEvent(1);
    await adapter.append(event);

    expect(mockFn).toHaveBeenCalledTimes(1);
    const [url, options] = mockFn.mock.calls[0]!;
    expect(url).toBe(`${BASE_URL}/sync/${MOTEBIT_ID}/push`);
    expect(options.method).toBe("POST");
    expect(options.headers["Authorization"]).toBe(`Bearer ${AUTH_TOKEN}`);
    expect(options.headers["Content-Type"]).toBe("application/json");

    const body = JSON.parse(options.body);
    expect(body.events).toHaveLength(1);
    expect(body.events[0].event_id).toBe(event.event_id);
  });

  it("query sends GET to pull endpoint with after_clock param", async () => {
    const events = [makeEvent(1), makeEvent(2)];
    const mockFn = globalThis.fetch as ReturnType<typeof vi.fn>;
    mockFn.mockResolvedValueOnce(new Response(JSON.stringify({ events }), { status: 200 }));

    const adapter = new HttpEventStoreAdapter({
      baseUrl: BASE_URL,
      motebitId: MOTEBIT_ID,
      authToken: AUTH_TOKEN,
    });

    const result = await adapter.query({ after_version_clock: 5 });

    expect(mockFn).toHaveBeenCalledTimes(1);
    const [url, options] = mockFn.mock.calls[0]!;
    expect(url).toBe(`${BASE_URL}/sync/${MOTEBIT_ID}/pull?after_clock=5`);
    expect(options.method).toBe("GET");
    expect(options.headers["Authorization"]).toBe(`Bearer ${AUTH_TOKEN}`);
    expect(result).toEqual(events);
  });

  it("query defaults after_clock to 0 when filter has no after_version_clock", async () => {
    const mockFn = globalThis.fetch as ReturnType<typeof vi.fn>;
    mockFn.mockResolvedValueOnce(new Response(JSON.stringify({ events: [] }), { status: 200 }));

    const adapter = new HttpEventStoreAdapter({
      baseUrl: BASE_URL,
      motebitId: MOTEBIT_ID,
    });

    await adapter.query({});

    const [url] = mockFn.mock.calls[0]!;
    expect(url).toBe(`${BASE_URL}/sync/${MOTEBIT_ID}/pull?after_clock=0`);
  });

  it("getLatestClock sends GET to clock endpoint", async () => {
    const mockFn = globalThis.fetch as ReturnType<typeof vi.fn>;
    mockFn.mockResolvedValueOnce(
      new Response(JSON.stringify({ motebit_id: MOTEBIT_ID, latest_clock: 42 }), { status: 200 }),
    );

    const adapter = new HttpEventStoreAdapter({
      baseUrl: BASE_URL,
      motebitId: MOTEBIT_ID,
      authToken: AUTH_TOKEN,
    });

    const clock = await adapter.getLatestClock(MOTEBIT_ID);

    expect(mockFn).toHaveBeenCalledTimes(1);
    const [url, options] = mockFn.mock.calls[0]!;
    expect(url).toBe(`${BASE_URL}/sync/${MOTEBIT_ID}/clock`);
    expect(options.method).toBe("GET");
    expect(options.headers["Authorization"]).toBe(`Bearer ${AUTH_TOKEN}`);
    expect(clock).toBe(42);
  });

  it("append throws on non-200 response", async () => {
    const mockFn = globalThis.fetch as ReturnType<typeof vi.fn>;
    mockFn.mockResolvedValueOnce(
      new Response("Unauthorized", { status: 401, statusText: "Unauthorized" }),
    );

    const adapter = new HttpEventStoreAdapter({
      baseUrl: BASE_URL,
      motebitId: MOTEBIT_ID,
    });

    await expect(adapter.append(makeEvent(1))).rejects.toThrow("Push failed: 401 Unauthorized");
  });

  it("query throws on non-200 response", async () => {
    const mockFn = globalThis.fetch as ReturnType<typeof vi.fn>;
    mockFn.mockResolvedValueOnce(
      new Response("Server Error", { status: 500, statusText: "Internal Server Error" }),
    );

    const adapter = new HttpEventStoreAdapter({
      baseUrl: BASE_URL,
      motebitId: MOTEBIT_ID,
    });

    await expect(adapter.query({})).rejects.toThrow("Pull failed: 500 Internal Server Error");
  });

  it("getLatestClock throws on non-200 response", async () => {
    const mockFn = globalThis.fetch as ReturnType<typeof vi.fn>;
    mockFn.mockResolvedValueOnce(
      new Response("Not Found", { status: 404, statusText: "Not Found" }),
    );

    const adapter = new HttpEventStoreAdapter({
      baseUrl: BASE_URL,
      motebitId: MOTEBIT_ID,
    });

    await expect(adapter.getLatestClock(MOTEBIT_ID)).rejects.toThrow("Clock failed: 404 Not Found");
  });

  it("omits Authorization header when no authToken is provided", async () => {
    const mockFn = globalThis.fetch as ReturnType<typeof vi.fn>;
    mockFn.mockResolvedValueOnce(new Response(JSON.stringify({ events: [] }), { status: 200 }));

    const adapter = new HttpEventStoreAdapter({
      baseUrl: BASE_URL,
      motebitId: MOTEBIT_ID,
    });

    await adapter.query({});

    const [, options] = mockFn.mock.calls[0]!;
    expect(options.headers["Authorization"]).toBeUndefined();
  });

  it("tombstone is a no-op", async () => {
    const adapter = new HttpEventStoreAdapter({
      baseUrl: BASE_URL,
      motebitId: MOTEBIT_ID,
    });

    // Should resolve without error and not call fetch
    await adapter.tombstone("event-1", MOTEBIT_ID);

    const mockFn = globalThis.fetch as ReturnType<typeof vi.fn>;
    expect(mockFn).not.toHaveBeenCalled();
  });

  it("strips trailing slashes from baseUrl", async () => {
    const mockFn = globalThis.fetch as ReturnType<typeof vi.fn>;
    mockFn.mockResolvedValueOnce(new Response(JSON.stringify({ events: [] }), { status: 200 }));

    const adapter = new HttpEventStoreAdapter({
      baseUrl: "http://localhost:3000///",
      motebitId: MOTEBIT_ID,
    });

    await adapter.query({});

    const [url] = mockFn.mock.calls[0]!;
    expect(url).toBe(`http://localhost:3000/sync/${MOTEBIT_ID}/pull?after_clock=0`);
  });
});
