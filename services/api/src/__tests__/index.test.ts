import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@mote/memory-graph", async () => {
  const actual = await vi.importActual<typeof import("@mote/memory-graph")>("@mote/memory-graph");
  return { ...actual, embedText: (text: string) => Promise.resolve(actual.embedTextHash(text)) };
});

import { createMoteServer } from "../index.js";
import type { MoteServer } from "../index.js";
import { TrustMode, BatteryMode, EventType, SensitivityLevel } from "@mote/sdk";
import type { EventLogEntry } from "@mote/sdk";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MOTE_ID = "mote-api-test";
const API_KEY = "test-api-key";

function createTestServer(): MoteServer {
  return createMoteServer({ moteId: MOTE_ID, apiKey: API_KEY });
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

function makeEvent(moteId: string, clock: number): EventLogEntry {
  return {
    event_id: crypto.randomUUID(),
    mote_id: moteId,
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

describe("Mote API", () => {
  const originalFetch = globalThis.fetch;
  let server: MoteServer;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
    server = createTestServer();
  });

  afterEach(() => {
    server.close();
    globalThis.fetch = originalFetch;
  });

  // === Existing tests (updated to use config object) ===

  it("POST /api/v1/message/:moteId returns response with memory and state", async () => {
    const responseText = [
      "That's really interesting!",
      '<memory confidence="0.9" sensitivity="personal">User enjoys hiking on weekends</memory>',
      '<state field="curiosity" value="0.8"/>',
    ].join(" ");

    mockFetchSuccess(responseText);

    const res = await server.app.request(`/api/v1/message/${MOTE_ID}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "I love hiking on weekends!" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.response).toContain("That's really interesting!");
    expect(body.response).not.toContain("<memory");
    expect(body.response).not.toContain("<state");

    expect(body.memories_formed).toHaveLength(1);
    expect(body.memories_formed[0].content).toBe("User enjoys hiking on weekends");
    expect(body.memories_formed[0].confidence).toBe(0.9);

    expect(body.state).toBeDefined();
    expect(body.cues).toBeDefined();
    expect(body.cues.hover_distance).toBeGreaterThan(0);
    expect(body.mote_id).toBe(MOTE_ID);
  });

  it("GET /api/v1/state/:moteId returns current state", async () => {
    const res = await server.app.request(`/api/v1/state/${MOTE_ID}`, {
      method: "GET",
    });

    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.mote_id).toBe(MOTE_ID);
    expect(body.state).toBeDefined();
    expect(body.state.confidence).toBe(0.5);
    expect(body.state.attention).toBe(0);
    expect(body.state.trust_mode).toBe(TrustMode.Guarded);
    expect(body.state.battery_mode).toBe(BatteryMode.Normal);
  });

  it("GET /api/v1/memory/:moteId returns stored memories", async () => {
    // Initially empty
    const res1 = await server.app.request(`/api/v1/memory/${MOTE_ID}`, {
      method: "GET",
    });

    expect(res1.status).toBe(200);
    const body1 = await res1.json();
    expect(body1.mote_id).toBe(MOTE_ID);
    expect(body1.memories).toHaveLength(0);
    expect(body1.edges).toHaveLength(0);

    // Form a memory via the message endpoint
    mockFetchSuccess(
      'Cool! <memory confidence="0.85" sensitivity="none">User loves jazz music</memory>',
    );

    await server.app.request(`/api/v1/message/${MOTE_ID}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "I love jazz music" }),
    });

    // Now memories should be populated
    const res2 = await server.app.request(`/api/v1/memory/${MOTE_ID}`, {
      method: "GET",
    });

    expect(res2.status).toBe(200);
    const body2 = await res2.json();
    expect(body2.memories).toHaveLength(1);
    expect(body2.memories[0].content).toBe("User loves jazz music");
  });

  it("GET /health returns ok", async () => {
    const res = await server.app.request("/health", { method: "GET" });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body.timestamp).toBeTypeOf("number");
  });

  it("POST /api/v1/message/:moteId handles no-memory response", async () => {
    mockFetchSuccess("Just a plain response, no memories here.");

    const res = await server.app.request(`/api/v1/message/${MOTE_ID}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "What's up?" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.response).toBe("Just a plain response, no memories here.");
    expect(body.memories_formed).toHaveLength(0);
  });

  // === New tests: Identity ===

  it("POST /api/v1/identity creates identity", async () => {
    const res = await server.app.request("/api/v1/identity", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ owner_id: "owner-1" }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.mote_id).toBeTypeOf("string");
    expect(body.owner_id).toBe("owner-1");
    expect(body.created_at).toBeTypeOf("number");
    expect(body.version_clock).toBe(0);
  });

  it("GET /api/v1/identity/:moteId loads existing identity", async () => {
    // Create first
    const createRes = await server.app.request("/api/v1/identity", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ owner_id: "owner-2" }),
    });
    const created = await createRes.json();

    // Load
    const res = await server.app.request(`/api/v1/identity/${created.mote_id}`, {
      method: "GET",
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.mote_id).toBe(created.mote_id);
    expect(body.owner_id).toBe("owner-2");
  });

  it("GET /api/v1/identity/:moteId returns 404 for nonexistent", async () => {
    const res = await server.app.request("/api/v1/identity/nonexistent-id", {
      method: "GET",
    });

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("identity not found");
  });

  // === New tests: Memory POST ===

  it("POST /api/v1/memory/:moteId creates memory with embedding", async () => {
    const res = await server.app.request(`/api/v1/memory/${MOTE_ID}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "User likes coffee" }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.content).toBe("User likes coffee");
    expect(body.node_id).toBeTypeOf("string");
    expect(body.embedding).toBeInstanceOf(Array);
    expect(body.embedding.length).toBeGreaterThan(0);
    expect(body.sensitivity).toBe(SensitivityLevel.None);

    // Verify persisted via GET
    const getRes = await server.app.request(`/api/v1/memory/${MOTE_ID}`, {
      method: "GET",
    });
    const getBody = await getRes.json();
    expect(getBody.memories).toHaveLength(1);
    expect(getBody.memories[0].content).toBe("User likes coffee");
  });

  it("POST /api/v1/memory/:moteId respects sensitivity parameter", async () => {
    const res = await server.app.request(`/api/v1/memory/${MOTE_ID}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "User has allergy", sensitivity: "medical" }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.sensitivity).toBe(SensitivityLevel.Medical);
  });

  // === New tests: Sync ===

  it("POST /api/v1/sync/:moteId/push accepts events", async () => {
    const events = [makeEvent(MOTE_ID, 1), makeEvent(MOTE_ID, 2)];

    const res = await server.app.request(`/api/v1/sync/${MOTE_ID}/push`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ events }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.accepted).toBe(2);
  });

  it("GET /api/v1/sync/:moteId/pull returns pushed events", async () => {
    const events = [makeEvent(MOTE_ID, 1), makeEvent(MOTE_ID, 2)];

    await server.app.request(`/api/v1/sync/${MOTE_ID}/push`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ events }),
    });

    const res = await server.app.request(`/api/v1/sync/${MOTE_ID}/pull?after_clock=0`, {
      method: "GET",
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.events.length).toBeGreaterThanOrEqual(2);
  });

  it("GET /api/v1/sync/:moteId/pull filters by after_clock", async () => {
    const events = [
      makeEvent(MOTE_ID, 1),
      makeEvent(MOTE_ID, 2),
      makeEvent(MOTE_ID, 3),
    ];

    await server.app.request(`/api/v1/sync/${MOTE_ID}/push`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ events }),
    });

    const res = await server.app.request(`/api/v1/sync/${MOTE_ID}/pull?after_clock=1`, {
      method: "GET",
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    // Should only get events with version_clock > 1
    for (const ev of body.events) {
      expect(ev.version_clock).toBeGreaterThan(1);
    }
    expect(body.events.length).toBeGreaterThanOrEqual(2);
  });

  // === New tests: Export ===

  it("GET /api/v1/export/:moteId returns full manifest", async () => {
    // Create identity
    const createRes = await server.app.request("/api/v1/identity", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ owner_id: "owner-export" }),
    });
    const identity = await createRes.json();

    // Form a memory via message endpoint (uses the server's moteId)
    mockFetchSuccess(
      'Sure! <memory confidence="0.8" sensitivity="none">User likes exports</memory>',
    );
    await server.app.request(`/api/v1/message/${MOTE_ID}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Test export" }),
    });

    // Export
    const res = await server.app.request(`/api/v1/export/${identity.mote_id}`, {
      method: "GET",
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.mote_id).toBe(MOTE_ID); // manifest uses server's moteId
    expect(body.exported_at).toBeTypeOf("number");
    expect(body.identity).toBeDefined();
    expect(body.identity.mote_id).toBe(identity.mote_id);
    expect(body.memories).toBeInstanceOf(Array);
    expect(body.events).toBeInstanceOf(Array);
    expect(body.audit_log).toBeInstanceOf(Array);
  });

  it("GET /api/v1/export/:moteId returns 404 with no identity", async () => {
    const res = await server.app.request("/api/v1/export/no-such-mote", {
      method: "GET",
    });

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("identity not found");
  });

  // === New tests: Delete ===

  it("POST /api/v1/delete/:moteId deletes memories and returns certificates", async () => {
    // Create identity
    const createRes = await server.app.request("/api/v1/identity", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ owner_id: "owner-delete" }),
    });
    const identity = await createRes.json();

    // Form a memory via message endpoint
    mockFetchSuccess(
      'OK! <memory confidence="0.7" sensitivity="none">Deletable memory</memory>',
    );
    await server.app.request(`/api/v1/message/${MOTE_ID}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Remember this for deletion" }),
    });

    // Delete
    const res = await server.app.request(`/api/v1/delete/${identity.mote_id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deleted_by: "owner-delete" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.mote_id).toBe(identity.mote_id);
    expect(body.deletion_certificates).toBeInstanceOf(Array);
  });

  it("POST /api/v1/delete/:moteId with no memories returns empty certificates", async () => {
    // Create identity with no memories
    const createRes = await server.app.request("/api/v1/identity", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ owner_id: "owner-empty-delete" }),
    });
    const identity = await createRes.json();

    const res = await server.app.request(`/api/v1/delete/${identity.mote_id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deleted_by: "owner-empty-delete" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.deletion_certificates).toEqual([]);
  });

  it("POST /api/v1/delete/:moteId returns 404 with no identity", async () => {
    const res = await server.app.request("/api/v1/delete/no-such-mote", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deleted_by: "someone" }),
    });

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("identity not found");
  });
});
