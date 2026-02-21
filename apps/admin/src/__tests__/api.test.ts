import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  fetchState,
  fetchMemory,
  fetchEvents,
  deleteMemoryNode,
  fetchHealth,
  fetchGoals,
  fetchConversations,
  fetchConversationMessages,
  fetchDevices,
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

function expectAuthHeader(call: unknown[] | undefined) {
  expect(call).toBeDefined();
  const init = call![1] as RequestInit;
  const headers = new Headers(init.headers);
  if (config.apiToken) {
    expect(headers.get("Authorization")).toBe(`Bearer ${config.apiToken}`);
  }
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

    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    expect(fetchMock).toHaveBeenCalledOnce();
    const call = fetchMock.mock.calls[0]!;
    expect(call[0]).toBe(`${config.apiUrl}/api/v1/state/${config.motebitId}`);
    expectAuthHeader(call);
    expect(result).toEqual(data);
  });

  it("passes AbortSignal", async () => {
    mockFetch({ motebit_id: "m1", state: {} });
    const controller = new AbortController();

    await fetchState(controller.signal);

    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    const call = fetchMock.mock.calls[0]!;
    const init = call[1] as RequestInit;
    expect(init.signal).toBe(controller.signal);
  });
});

describe("fetchMemory", () => {
  it("calls correct URL and returns typed response", async () => {
    const data = { motebit_id: "m1", memories: [], edges: [] };
    mockFetch(data);

    const result = await fetchMemory();

    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    const call = fetchMock.mock.calls[0]!;
    expect(call[0]).toBe(`${config.apiUrl}/api/v1/memory/${config.motebitId}`);
    expectAuthHeader(call);
    expect(result).toEqual(data);
  });
});

describe("fetchEvents", () => {
  it("calls correct URL with after_clock param", async () => {
    const data = { motebit_id: "m1", events: [], after_clock: 5 };
    mockFetch(data);

    const result = await fetchEvents(5);

    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    const call = fetchMock.mock.calls[0]!;
    expect(call[0]).toBe(`${config.apiUrl}/api/v1/sync/${config.motebitId}/pull?after_clock=5`);
    expectAuthHeader(call);
    expect(result).toEqual(data);
  });
});

describe("deleteMemoryNode", () => {
  it("calls DELETE with correct URL", async () => {
    const data = { motebit_id: "m1", node_id: "n1", deleted: true };
    mockFetch(data);

    const result = await deleteMemoryNode("n1");

    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    const call = fetchMock.mock.calls[0]!;
    expect(call[0]).toBe(`${config.apiUrl}/api/v1/memory/${config.motebitId}/n1`);
    const init = call[1] as RequestInit;
    expect(init.method).toBe("DELETE");
    expectAuthHeader(call);
    expect(result).toEqual(data);
  });
});

describe("fetchHealth", () => {
  it("calls /health endpoint", async () => {
    const data = { status: "ok", timestamp: 123 };
    mockFetch(data);

    const result = await fetchHealth();

    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    const call = fetchMock.mock.calls[0]!;
    expect(call[0]).toBe(`${config.apiUrl}/health`);
    expectAuthHeader(call);
    expect(result).toEqual(data);
  });
});

describe("fetchGoals", () => {
  it("calls correct URL and returns typed response", async () => {
    const data = { motebit_id: "m1", goals: [{ goal_id: "g1", prompt: "test" }] };
    mockFetch(data);

    const result = await fetchGoals();

    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    expect(fetchMock).toHaveBeenCalledOnce();
    const call = fetchMock.mock.calls[0]!;
    expect(call[0]).toBe(`${config.apiUrl}/api/v1/goals/${config.motebitId}`);
    expectAuthHeader(call);
    expect(result).toEqual(data);
  });

  it("passes AbortSignal", async () => {
    mockFetch({ motebit_id: "m1", goals: [] });
    const controller = new AbortController();

    await fetchGoals(controller.signal);

    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    const call = fetchMock.mock.calls[0]!;
    const init = call[1] as RequestInit;
    expect(init.signal).toBe(controller.signal);
  });
});

describe("fetchConversations", () => {
  it("calls correct URL and returns typed response", async () => {
    const data = { motebit_id: "m1", conversations: [] };
    mockFetch(data);

    const result = await fetchConversations();

    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    const call = fetchMock.mock.calls[0]!;
    expect(call[0]).toBe(`${config.apiUrl}/api/v1/conversations/${config.motebitId}`);
    expectAuthHeader(call);
    expect(result).toEqual(data);
  });
});

describe("fetchConversationMessages", () => {
  it("calls correct URL with conversation ID", async () => {
    const data = { motebit_id: "m1", conversation_id: "c1", messages: [] };
    mockFetch(data);

    const result = await fetchConversationMessages("c1");

    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    const call = fetchMock.mock.calls[0]!;
    expect(call[0]).toBe(`${config.apiUrl}/api/v1/conversations/${config.motebitId}/c1/messages`);
    expectAuthHeader(call);
    expect(result).toEqual(data);
  });
});

describe("fetchDevices", () => {
  it("calls correct URL and returns typed response", async () => {
    const data = { motebit_id: "m1", devices: [{ device_id: "d1", device_name: "Test" }] };
    mockFetch(data);

    const result = await fetchDevices();

    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    const call = fetchMock.mock.calls[0]!;
    expect(call[0]).toBe(`${config.apiUrl}/api/v1/devices/${config.motebitId}`);
    expectAuthHeader(call);
    expect(result).toEqual(data);
  });

  it("passes AbortSignal", async () => {
    mockFetch({ motebit_id: "m1", devices: [] });
    const controller = new AbortController();

    await fetchDevices(controller.signal);

    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    const call = fetchMock.mock.calls[0]!;
    const init = call[1] as RequestInit;
    expect(init.signal).toBe(controller.signal);
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
