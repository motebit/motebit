import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  fetchState,
  fetchMemory,
  fetchEvents,
  deleteMemoryNode,
  fetchHealth,
  ApiError,
  config,
} from "../api";

const originalFetch = globalThis.fetch;

function mockFetch(body: unknown, status = 200) {
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Bad Request",
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as Response);
}

beforeEach(() => {
  globalThis.fetch = vi.fn();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("fetchState", () => {
  it("calls correct URL and returns typed response", async () => {
    const data = { motebit_id: "m1", state: { attention: 0.5 } };
    mockFetch(data);

    const result = await fetchState();

    expect(globalThis.fetch).toHaveBeenCalledWith(
      `${config.apiUrl}/api/v1/state/${config.motebitId}`,
      { signal: undefined },
    );
    expect(result).toEqual(data);
  });

  it("passes AbortSignal", async () => {
    mockFetch({ motebit_id: "m1", state: {} });
    const controller = new AbortController();

    await fetchState(controller.signal);

    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.any(String),
      { signal: controller.signal },
    );
  });
});

describe("fetchMemory", () => {
  it("calls correct URL and returns typed response", async () => {
    const data = { motebit_id: "m1", memories: [], edges: [] };
    mockFetch(data);

    const result = await fetchMemory();

    expect(globalThis.fetch).toHaveBeenCalledWith(
      `${config.apiUrl}/api/v1/memory/${config.motebitId}`,
      { signal: undefined },
    );
    expect(result).toEqual(data);
  });
});

describe("fetchEvents", () => {
  it("calls correct URL with after_clock param", async () => {
    const data = { motebit_id: "m1", events: [], after_clock: 5 };
    mockFetch(data);

    const result = await fetchEvents(5);

    expect(globalThis.fetch).toHaveBeenCalledWith(
      `${config.apiUrl}/api/v1/sync/${config.motebitId}/pull?after_clock=5`,
      { signal: undefined },
    );
    expect(result).toEqual(data);
  });
});

describe("deleteMemoryNode", () => {
  it("calls DELETE with correct URL", async () => {
    const data = { motebit_id: "m1", node_id: "n1", deleted: true };
    mockFetch(data);

    const result = await deleteMemoryNode("n1");

    expect(globalThis.fetch).toHaveBeenCalledWith(
      `${config.apiUrl}/api/v1/memory/${config.motebitId}/n1`,
      { method: "DELETE", signal: undefined },
    );
    expect(result).toEqual(data);
  });
});

describe("fetchHealth", () => {
  it("calls /health endpoint", async () => {
    const data = { status: "ok", timestamp: 123 };
    mockFetch(data);

    const result = await fetchHealth();

    expect(globalThis.fetch).toHaveBeenCalledWith(
      `${config.apiUrl}/health`,
      { signal: undefined },
    );
    expect(result).toEqual(data);
  });
});

describe("ApiError", () => {
  it("is thrown on non-OK response", async () => {
    mockFetch({ error: "not found" }, 404);

    await expect(fetchState()).rejects.toThrow(ApiError);
    await expect(fetchState()).rejects.toThrow("API 404");
  });

  it("includes status and body", async () => {
    mockFetch({ error: "bad" }, 400);

    try {
      await fetchState();
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      const apiErr = err as ApiError;
      expect(apiErr.status).toBe(400);
      expect(apiErr.body).toContain("bad");
    }
  });
});
