import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@motebit/memory-graph", async () => {
  const actual = await vi.importActual<typeof import("@motebit/memory-graph")>("@motebit/memory-graph");
  return { ...actual, embedText: (text: string) => Promise.resolve(actual.embedTextHash(text)) };
});

import { createMotebitServer } from "../index.js";
import type { MotebitServer } from "../index.js";
import { TrustMode, BatteryMode, EventType, SensitivityLevel } from "@motebit/sdk";
import type { EventLogEntry } from "@motebit/sdk";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MOTEBIT_ID = "motebit-api-test";
const API_KEY = "test-api-key";
const API_TOKEN = "test-token";
const AUTH_HEADER = { Authorization: `Bearer ${API_TOKEN}` };

function createTestServer(): MotebitServer {
  return createMotebitServer({ motebitId: MOTEBIT_ID, apiKey: API_KEY, apiToken: API_TOKEN });
}

function mockAnthropicResponse(text: string) {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    content: [{ type: "text", text }],
    model: "claude-sonnet-4-5-20250514",
    stop_reason: "end_turn",
    usage: { input_tokens: 100, output_tokens: 50 },
  };
}

function mockFetchSuccess(text: string): void {
  const mockFn = globalThis.fetch as ReturnType<typeof vi.fn>;
  mockFn.mockResolvedValueOnce(
    new Response(JSON.stringify(mockAnthropicResponse(text)), { status: 200 }),
  );
}

function mockFetchStreamSuccess(text: string): void {
  // Build Anthropic SSE stream with content_block_start, content_block_delta(s), message_stop events
  const chunks = text.split(/(?<=\s)/); // split on word boundaries
  let ssePayload = "";
  ssePayload += `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n`;
  for (const chunk of chunks) {
    ssePayload += `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":${JSON.stringify(chunk)}}}\n\n`;
  }
  ssePayload += `event: message_stop\ndata: {"type":"message_stop"}\n\n`;

  const mockFn = globalThis.fetch as ReturnType<typeof vi.fn>;
  mockFn.mockResolvedValueOnce(
    new Response(ssePayload, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    }),
  );
}

function makeEvent(motebitId: string, clock: number): EventLogEntry {
  return {
    event_id: crypto.randomUUID(),
    motebit_id: motebitId,
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

describe("Motebit API", () => {
  const originalFetch = globalThis.fetch;
  let server: MotebitServer;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
    server = createTestServer();
  });

  afterEach(() => {
    server.close();
    globalThis.fetch = originalFetch;
  });

  // === Auth & Validation Negative Tests ===

  it("returns 401 when no bearer token is provided", async () => {
    const res = await server.app.request(`/api/v1/state/${MOTEBIT_ID}`, {
      method: "GET",
    });

    expect(res.status).toBe(401);
  });

  it("returns 401 when wrong bearer token is provided", async () => {
    const res = await server.app.request(`/api/v1/state/${MOTEBIT_ID}`, {
      method: "GET",
      headers: { Authorization: "Bearer wrong-token" },
    });

    expect(res.status).toBe(401);
  });

  it("POST /api/v1/message returns 400 when message field is missing", async () => {
    const res = await server.app.request(`/api/v1/message/${MOTEBIT_ID}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("message");
  });

  it("POST /api/v1/message returns 400 when message field is empty", async () => {
    const res = await server.app.request(`/api/v1/message/${MOTEBIT_ID}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({ message: "  " }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("message");
  });

  it("POST /api/v1/identity returns 400 when owner_id is missing", async () => {
    const res = await server.app.request("/api/v1/identity", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("owner_id");
  });

  it("POST /api/v1/memory returns 400 when content is missing", async () => {
    const res = await server.app.request(`/api/v1/memory/${MOTEBIT_ID}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("content");
  });

  it("POST /api/v1/sync/push returns 400 when events is missing", async () => {
    const res = await server.app.request(`/api/v1/sync/${MOTEBIT_ID}/push`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("events");
  });

  it("GET /health succeeds without auth token", async () => {
    const res = await server.app.request("/health", { method: "GET" });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; timestamp: number };
    expect(body.status).toBe("ok");
    expect(body.timestamp).toBeTypeOf("number");
  });

  // === Existing tests (with auth headers) ===

  it("POST /api/v1/message/:motebitId returns response with memory and state", async () => {
    const responseText = [
      "That's really interesting!",
      '<memory confidence="0.9" sensitivity="personal">User enjoys hiking on weekends</memory>',
      '<state field="curiosity" value="0.8"/>',
    ].join(" ");

    mockFetchSuccess(responseText);

    const res = await server.app.request(`/api/v1/message/${MOTEBIT_ID}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({ message: "I love hiking on weekends!" }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      motebit_id: string;
      response: string;
      memories_formed: { content: string; confidence: number }[];
      state: Record<string, unknown>;
      cues: { hover_distance: number };
    };

    expect(body.response).toContain("That's really interesting!");
    expect(body.response).not.toContain("<memory");
    expect(body.response).not.toContain("<state");

    expect(body.memories_formed).toHaveLength(1);
    expect(body.memories_formed[0]!.content).toBe("User enjoys hiking on weekends");
    expect(body.memories_formed[0]!.confidence).toBe(0.9);

    expect(body.state).toBeDefined();
    expect(body.cues).toBeDefined();
    expect(body.cues.hover_distance).toBeGreaterThan(0);
    expect(body.motebit_id).toBe(MOTEBIT_ID);
  });

  it("GET /api/v1/state/:motebitId returns current state", async () => {
    const res = await server.app.request(`/api/v1/state/${MOTEBIT_ID}`, {
      method: "GET",
      headers: AUTH_HEADER,
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      motebit_id: string;
      state: { confidence: number; attention: number; trust_mode: string; battery_mode: string };
    };

    expect(body.motebit_id).toBe(MOTEBIT_ID);
    expect(body.state).toBeDefined();
    expect(body.state.confidence).toBe(0.5);
    expect(body.state.attention).toBe(0);
    expect(body.state.trust_mode).toBe(TrustMode.Guarded);
    expect(body.state.battery_mode).toBe(BatteryMode.Normal);
  });

  it("GET /api/v1/memory/:motebitId returns stored memories", async () => {
    // Initially empty
    const res1 = await server.app.request(`/api/v1/memory/${MOTEBIT_ID}`, {
      method: "GET",
      headers: AUTH_HEADER,
    });

    expect(res1.status).toBe(200);
    const body1 = (await res1.json()) as {
      motebit_id: string;
      memories: { content: string }[];
      edges: unknown[];
    };
    expect(body1.motebit_id).toBe(MOTEBIT_ID);
    expect(body1.memories).toHaveLength(0);
    expect(body1.edges).toHaveLength(0);

    // Form a memory via the message endpoint
    mockFetchSuccess(
      'Cool! <memory confidence="0.85" sensitivity="none">User loves jazz music</memory>',
    );

    await server.app.request(`/api/v1/message/${MOTEBIT_ID}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({ message: "I love jazz music" }),
    });

    // Now memories should be populated
    const res2 = await server.app.request(`/api/v1/memory/${MOTEBIT_ID}`, {
      method: "GET",
      headers: AUTH_HEADER,
    });

    expect(res2.status).toBe(200);
    const body2 = (await res2.json()) as {
      memories: { content: string }[];
    };
    expect(body2.memories).toHaveLength(1);
    expect(body2.memories[0]!.content).toBe("User loves jazz music");
  });

  it("POST /api/v1/message/:motebitId handles no-memory response", async () => {
    mockFetchSuccess("Just a plain response, no memories here.");

    const res = await server.app.request(`/api/v1/message/${MOTEBIT_ID}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({ message: "What's up?" }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { response: string; memories_formed: unknown[] };
    expect(body.response).toBe("Just a plain response, no memories here.");
    expect(body.memories_formed).toHaveLength(0);
  });

  // === Streaming Message Tests ===

  it("POST /api/v1/message/:motebitId/stream returns SSE text and done events", async () => {
    const responseText = [
      "That's really interesting!",
      '<memory confidence="0.9" sensitivity="personal">User enjoys hiking on weekends</memory>',
      '<state field="curiosity" value="0.8"/>',
    ].join(" ");

    mockFetchStreamSuccess(responseText);

    const res = await server.app.request(`/api/v1/message/${MOTEBIT_ID}/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({ message: "I love hiking on weekends!" }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const text = await res.text();
    expect(text).toContain("event: text");
    expect(text).toContain("event: done");

    // Parse the done event data
    const doneMatch = text.match(/event: done\ndata: (.+)/);
    expect(doneMatch).not.toBeNull();
    const doneData = JSON.parse(doneMatch![1]!) as {
      motebit_id: string;
      response: string;
      state: Record<string, unknown>;
      cues: Record<string, unknown>;
      memories_formed: unknown[];
    };
    expect(doneData.motebit_id).toBe(MOTEBIT_ID);
    expect(doneData.response).toBeDefined();
    expect(doneData.state).toBeDefined();
    expect(doneData.cues).toBeDefined();
    expect(doneData.memories_formed).toBeInstanceOf(Array);
  });

  it("POST /api/v1/message/:motebitId/stream returns 400 when message is missing", async () => {
    const res = await server.app.request(`/api/v1/message/${MOTEBIT_ID}/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("message");
  });

  it("POST /api/v1/message/:motebitId/stream returns 401 without auth", async () => {
    const res = await server.app.request(`/api/v1/message/${MOTEBIT_ID}/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "hello" }),
    });

    expect(res.status).toBe(401);
  });

  // === Identity Tests ===

  it("POST /api/v1/identity creates identity", async () => {
    const res = await server.app.request("/api/v1/identity", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({ owner_id: "owner-1" }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      motebit_id: string;
      owner_id: string;
      created_at: number;
      version_clock: number;
    };
    expect(body.motebit_id).toBeTypeOf("string");
    expect(body.owner_id).toBe("owner-1");
    expect(body.created_at).toBeTypeOf("number");
    expect(body.version_clock).toBe(0);
  });

  it("GET /api/v1/identity/:motebitId loads existing identity", async () => {
    // Create first
    const createRes = await server.app.request("/api/v1/identity", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({ owner_id: "owner-2" }),
    });
    const created = (await createRes.json()) as { motebit_id: string; owner_id: string };

    // Load
    const res = await server.app.request(`/api/v1/identity/${created.motebit_id}`, {
      method: "GET",
      headers: AUTH_HEADER,
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { motebit_id: string; owner_id: string };
    expect(body.motebit_id).toBe(created.motebit_id);
    expect(body.owner_id).toBe("owner-2");
  });

  it("GET /api/v1/identity/:motebitId returns 404 for nonexistent", async () => {
    const res = await server.app.request("/api/v1/identity/nonexistent-id", {
      method: "GET",
      headers: AUTH_HEADER,
    });

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("identity not found");
  });

  // === Memory POST Tests ===

  it("POST /api/v1/memory/:motebitId creates memory with embedding", async () => {
    const res = await server.app.request(`/api/v1/memory/${MOTEBIT_ID}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({ content: "User likes coffee" }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      content: string;
      node_id: string;
      embedding: number[];
      sensitivity: string;
    };
    expect(body.content).toBe("User likes coffee");
    expect(body.node_id).toBeTypeOf("string");
    expect(body.embedding).toBeInstanceOf(Array);
    expect(body.embedding.length).toBeGreaterThan(0);
    expect(body.sensitivity).toBe(SensitivityLevel.None);

    // Verify persisted via GET
    const getRes = await server.app.request(`/api/v1/memory/${MOTEBIT_ID}`, {
      method: "GET",
      headers: AUTH_HEADER,
    });
    const getBody = (await getRes.json()) as { memories: { content: string }[] };
    expect(getBody.memories).toHaveLength(1);
    expect(getBody.memories[0]!.content).toBe("User likes coffee");
  });

  it("POST /api/v1/memory/:motebitId respects sensitivity parameter", async () => {
    const res = await server.app.request(`/api/v1/memory/${MOTEBIT_ID}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({ content: "User has allergy", sensitivity: "medical" }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { sensitivity: string };
    expect(body.sensitivity).toBe(SensitivityLevel.Medical);
  });

  // === Sync Tests ===

  it("POST /api/v1/sync/:motebitId/push accepts events", async () => {
    const events = [makeEvent(MOTEBIT_ID, 1), makeEvent(MOTEBIT_ID, 2)];

    const res = await server.app.request(`/api/v1/sync/${MOTEBIT_ID}/push`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({ events }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { accepted: number };
    expect(body.accepted).toBe(2);
  });

  it("GET /api/v1/sync/:motebitId/pull returns pushed events", async () => {
    const events = [makeEvent(MOTEBIT_ID, 1), makeEvent(MOTEBIT_ID, 2)];

    await server.app.request(`/api/v1/sync/${MOTEBIT_ID}/push`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({ events }),
    });

    const res = await server.app.request(`/api/v1/sync/${MOTEBIT_ID}/pull?after_clock=0`, {
      method: "GET",
      headers: AUTH_HEADER,
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: EventLogEntry[] };
    expect(body.events.length).toBeGreaterThanOrEqual(2);
  });

  it("GET /api/v1/sync/:motebitId/pull filters by after_clock", async () => {
    const events = [
      makeEvent(MOTEBIT_ID, 1),
      makeEvent(MOTEBIT_ID, 2),
      makeEvent(MOTEBIT_ID, 3),
    ];

    await server.app.request(`/api/v1/sync/${MOTEBIT_ID}/push`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({ events }),
    });

    const res = await server.app.request(`/api/v1/sync/${MOTEBIT_ID}/pull?after_clock=1`, {
      method: "GET",
      headers: AUTH_HEADER,
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: EventLogEntry[] };
    // Should only get events with version_clock > 1
    for (const ev of body.events) {
      expect(ev.version_clock).toBeGreaterThan(1);
    }
    expect(body.events.length).toBeGreaterThanOrEqual(2);
  });

  // === Clock Tests ===

  it("GET /api/v1/sync/:motebitId/clock returns latest clock", async () => {
    // Push some events to establish a clock
    const events = [makeEvent(MOTEBIT_ID, 1), makeEvent(MOTEBIT_ID, 2), makeEvent(MOTEBIT_ID, 3)];

    await server.app.request(`/api/v1/sync/${MOTEBIT_ID}/push`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({ events }),
    });

    const res = await server.app.request(`/api/v1/sync/${MOTEBIT_ID}/clock`, {
      method: "GET",
      headers: AUTH_HEADER,
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { motebit_id: string; latest_clock: number };
    expect(body.motebit_id).toBe(MOTEBIT_ID);
    expect(body.latest_clock).toBe(3);
  });

  it("GET /api/v1/sync/:motebitId/clock returns 0 when no events exist", async () => {
    const res = await server.app.request(`/api/v1/sync/${MOTEBIT_ID}/clock`, {
      method: "GET",
      headers: AUTH_HEADER,
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { motebit_id: string; latest_clock: number };
    expect(body.motebit_id).toBe(MOTEBIT_ID);
    expect(body.latest_clock).toBe(0);
  });

  // === Export Tests ===

  it("GET /api/v1/export/:motebitId returns full manifest", async () => {
    // Create identity
    const createRes = await server.app.request("/api/v1/identity", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({ owner_id: "owner-export" }),
    });
    const identity = (await createRes.json()) as { motebit_id: string };

    // Form a memory via message endpoint (uses the server's motebitId)
    mockFetchSuccess(
      'Sure! <memory confidence="0.8" sensitivity="none">User likes exports</memory>',
    );
    await server.app.request(`/api/v1/message/${MOTEBIT_ID}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({ message: "Test export" }),
    });

    // Export
    const res = await server.app.request(`/api/v1/export/${identity.motebit_id}`, {
      method: "GET",
      headers: AUTH_HEADER,
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      motebit_id: string;
      exported_at: number;
      identity: { motebit_id: string };
      memories: unknown[];
      events: unknown[];
      audit_log: unknown[];
    };
    expect(body.motebit_id).toBe(MOTEBIT_ID); // manifest uses server's motebitId
    expect(body.exported_at).toBeTypeOf("number");
    expect(body.identity).toBeDefined();
    expect(body.identity.motebit_id).toBe(identity.motebit_id);
    expect(body.memories).toBeInstanceOf(Array);
    expect(body.events).toBeInstanceOf(Array);
    expect(body.audit_log).toBeInstanceOf(Array);
  });

  it("GET /api/v1/export/:motebitId returns 404 with no identity", async () => {
    const res = await server.app.request("/api/v1/export/no-such-motebit", {
      method: "GET",
      headers: AUTH_HEADER,
    });

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("identity not found");
  });

  // === Delete Tests ===

  it("POST /api/v1/delete/:motebitId deletes memories and returns certificates", async () => {
    // Create identity
    const createRes = await server.app.request("/api/v1/identity", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({ owner_id: "owner-delete" }),
    });
    const identity = (await createRes.json()) as { motebit_id: string };

    // Form a memory via message endpoint
    mockFetchSuccess(
      'OK! <memory confidence="0.7" sensitivity="none">Deletable memory</memory>',
    );
    await server.app.request(`/api/v1/message/${MOTEBIT_ID}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({ message: "Remember this for deletion" }),
    });

    // Delete
    const res = await server.app.request(`/api/v1/delete/${identity.motebit_id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({ deleted_by: "owner-delete" }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { motebit_id: string; deletion_certificates: unknown[] };
    expect(body.motebit_id).toBe(identity.motebit_id);
    expect(body.deletion_certificates).toBeInstanceOf(Array);
  });

  it("POST /api/v1/delete/:motebitId with no memories returns empty certificates", async () => {
    // Create identity with no memories
    const createRes = await server.app.request("/api/v1/identity", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({ owner_id: "owner-empty-delete" }),
    });
    const identity = (await createRes.json()) as { motebit_id: string };

    const res = await server.app.request(`/api/v1/delete/${identity.motebit_id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({ deleted_by: "owner-empty-delete" }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { deletion_certificates: unknown[] };
    expect(body.deletion_certificates).toEqual([]);
  });

  it("POST /api/v1/delete/:motebitId returns 404 with no identity", async () => {
    const res = await server.app.request("/api/v1/delete/no-such-motebit", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({ deleted_by: "someone" }),
    });

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("identity not found");
  });
});
