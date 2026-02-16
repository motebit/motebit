import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createMoteServer } from "../index.js";
import { TrustMode, BatteryMode } from "@mote/sdk";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MOTE_ID = "mote-api-test";
const API_KEY = "test-api-key";

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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Mote API", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("POST /api/v1/message/:moteId returns response with memory and state", async () => {
    const { app } = createMoteServer(MOTE_ID, API_KEY);

    const responseText = [
      "That's really interesting!",
      '<memory confidence="0.9" sensitivity="personal">User enjoys hiking on weekends</memory>',
      '<state field="curiosity" value="0.8"/>',
    ].join(" ");

    mockFetchSuccess(responseText);

    const res = await app.request(`/api/v1/message/${MOTE_ID}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "I love hiking on weekends!" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();

    // Response text should have tags stripped
    expect(body.response).toContain("That's really interesting!");
    expect(body.response).not.toContain("<memory");
    expect(body.response).not.toContain("<state");

    // Memory should have been formed
    expect(body.memories_formed).toHaveLength(1);
    expect(body.memories_formed[0].content).toBe("User enjoys hiking on weekends");
    expect(body.memories_formed[0].confidence).toBe(0.9);

    // State and cues should be present
    expect(body.state).toBeDefined();
    expect(body.cues).toBeDefined();
    expect(body.cues.hover_distance).toBeGreaterThan(0);

    expect(body.mote_id).toBe(MOTE_ID);
  });

  it("GET /api/v1/state/:moteId returns current state", async () => {
    const { app } = createMoteServer(MOTE_ID, API_KEY);

    const res = await app.request(`/api/v1/state/${MOTE_ID}`, {
      method: "GET",
    });

    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.mote_id).toBe(MOTE_ID);
    expect(body.state).toBeDefined();
    // Default state values
    expect(body.state.confidence).toBe(0.5);
    expect(body.state.attention).toBe(0);
    expect(body.state.trust_mode).toBe(TrustMode.Guarded);
    expect(body.state.battery_mode).toBe(BatteryMode.Normal);
  });

  it("GET /api/v1/memory/:moteId returns stored memories", async () => {
    const { app } = createMoteServer(MOTE_ID, API_KEY);

    // Initially empty
    const res1 = await app.request(`/api/v1/memory/${MOTE_ID}`, {
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

    await app.request(`/api/v1/message/${MOTE_ID}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "I love jazz music" }),
    });

    // Now memories should be populated
    const res2 = await app.request(`/api/v1/memory/${MOTE_ID}`, {
      method: "GET",
    });

    expect(res2.status).toBe(200);
    const body2 = await res2.json();
    expect(body2.memories).toHaveLength(1);
    expect(body2.memories[0].content).toBe("User loves jazz music");
  });

  it("GET /health returns ok", async () => {
    const { app } = createMoteServer(MOTE_ID, API_KEY);

    const res = await app.request("/health", { method: "GET" });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body.timestamp).toBeTypeOf("number");
  });

  it("POST /api/v1/message/:moteId handles no-memory response", async () => {
    const { app } = createMoteServer(MOTE_ID, API_KEY);

    mockFetchSuccess("Just a plain response, no memories here.");

    const res = await app.request(`/api/v1/message/${MOTE_ID}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "What's up?" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.response).toBe("Just a plain response, no memories here.");
    expect(body.memories_formed).toHaveLength(0);
  });
});
