import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createSyncRelay } from "../index.js";
import type { SyncRelay } from "../index.js";
import type { SyncConversation, SyncConversationMessage } from "@motebit/sdk";

// === Helpers ===

const API_TOKEN = "test-token";
const AUTH_HEADER = { Authorization: `Bearer ${API_TOKEN}` };
const MOTEBIT_ID = "test-mote";

function createTestRelay(): SyncRelay {
  return createSyncRelay({ apiToken: API_TOKEN, enableDeviceAuth: false });
}

function makeConversation(motebitId: string, overrides: Partial<SyncConversation> = {}): SyncConversation {
  return {
    conversation_id: crypto.randomUUID(),
    motebit_id: motebitId,
    started_at: Date.now() - 60_000,
    last_active_at: Date.now(),
    title: null,
    summary: null,
    message_count: 0,
    ...overrides,
  };
}

function makeMessage(conversationId: string, motebitId: string, overrides: Partial<SyncConversationMessage> = {}): SyncConversationMessage {
  return {
    message_id: crypto.randomUUID(),
    conversation_id: conversationId,
    motebit_id: motebitId,
    role: "user",
    content: "Hello from device",
    tool_calls: null,
    tool_call_id: null,
    created_at: Date.now(),
    token_estimate: 4,
    ...overrides,
  };
}

// === Tests ===

describe("Conversation Sync Endpoints", () => {
  let relay: SyncRelay;

  beforeEach(() => {
    relay = createTestRelay();
  });

  afterEach(() => {
    relay.close();
  });

  // --- Push Conversations ---

  it("POST /sync/:id/conversations accepts conversations", async () => {
    const conversations = [
      makeConversation(MOTEBIT_ID, { title: "Chat 1" }),
      makeConversation(MOTEBIT_ID, { title: "Chat 2" }),
    ];
    const res = await relay.app.request(`/sync/${MOTEBIT_ID}/conversations`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({ conversations }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { motebit_id: string; accepted: number };
    expect(body.motebit_id).toBe(MOTEBIT_ID);
    expect(body.accepted).toBe(2);
  });

  it("POST /sync/:id/conversations returns 400 when conversations missing", async () => {
    const res = await relay.app.request(`/sync/${MOTEBIT_ID}/conversations`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  // --- Pull Conversations ---

  it("GET /sync/:id/conversations returns pushed conversations", async () => {
    const conversations = [
      makeConversation(MOTEBIT_ID, { title: "Chat A" }),
      makeConversation(MOTEBIT_ID, { title: "Chat B" }),
    ];
    await relay.app.request(`/sync/${MOTEBIT_ID}/conversations`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({ conversations }),
    });

    const res = await relay.app.request(`/sync/${MOTEBIT_ID}/conversations?since=0`, {
      method: "GET",
      headers: AUTH_HEADER,
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { motebit_id: string; conversations: SyncConversation[] };
    expect(body.motebit_id).toBe(MOTEBIT_ID);
    expect(body.conversations.length).toBeGreaterThanOrEqual(2);
  });

  it("GET /sync/:id/conversations filters by since timestamp", async () => {
    const oldConv = makeConversation(MOTEBIT_ID, { last_active_at: 1000 });
    const newConv = makeConversation(MOTEBIT_ID, { last_active_at: 5000 });
    await relay.app.request(`/sync/${MOTEBIT_ID}/conversations`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({ conversations: [oldConv, newConv] }),
    });

    const res = await relay.app.request(`/sync/${MOTEBIT_ID}/conversations?since=3000`, {
      method: "GET",
      headers: AUTH_HEADER,
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { conversations: SyncConversation[] };
    expect(body.conversations).toHaveLength(1);
    expect(body.conversations[0]!.conversation_id).toBe(newConv.conversation_id);
  });

  // --- Push Messages ---

  it("POST /sync/:id/messages accepts messages", async () => {
    const convId = "conv-msg-test";
    const messages = [
      makeMessage(convId, MOTEBIT_ID, { role: "user", content: "Hello" }),
      makeMessage(convId, MOTEBIT_ID, { role: "assistant", content: "Hi there!" }),
    ];
    const res = await relay.app.request(`/sync/${MOTEBIT_ID}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({ messages }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { motebit_id: string; accepted: number };
    expect(body.motebit_id).toBe(MOTEBIT_ID);
    expect(body.accepted).toBe(2);
  });

  it("POST /sync/:id/messages returns 400 when messages missing", async () => {
    const res = await relay.app.request(`/sync/${MOTEBIT_ID}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  // --- Pull Messages ---

  it("GET /sync/:id/messages returns pushed messages", async () => {
    const convId = "conv-pull-test";
    const messages = [
      makeMessage(convId, MOTEBIT_ID, { role: "user", content: "First", created_at: 1000 }),
      makeMessage(convId, MOTEBIT_ID, { role: "assistant", content: "Second", created_at: 2000 }),
    ];
    await relay.app.request(`/sync/${MOTEBIT_ID}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({ messages }),
    });

    const res = await relay.app.request(
      `/sync/${MOTEBIT_ID}/messages?conversation_id=${convId}&since=0`,
      { method: "GET", headers: AUTH_HEADER },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { motebit_id: string; conversation_id: string; messages: SyncConversationMessage[] };
    expect(body.motebit_id).toBe(MOTEBIT_ID);
    expect(body.conversation_id).toBe(convId);
    expect(body.messages).toHaveLength(2);
  });

  it("GET /sync/:id/messages filters by since timestamp", async () => {
    const convId = "conv-filter-test";
    const messages = [
      makeMessage(convId, MOTEBIT_ID, { content: "Old", created_at: 1000 }),
      makeMessage(convId, MOTEBIT_ID, { content: "New", created_at: 5000 }),
    ];
    await relay.app.request(`/sync/${MOTEBIT_ID}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({ messages }),
    });

    const res = await relay.app.request(
      `/sync/${MOTEBIT_ID}/messages?conversation_id=${convId}&since=3000`,
      { method: "GET", headers: AUTH_HEADER },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { messages: SyncConversationMessage[] };
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0]!.content).toBe("New");
  });

  it("GET /sync/:id/messages returns 400 when conversation_id missing", async () => {
    const res = await relay.app.request(
      `/sync/${MOTEBIT_ID}/messages?since=0`,
      { method: "GET", headers: AUTH_HEADER },
    );
    expect(res.status).toBe(400);
  });

  // --- Isolation ---

  it("conversations from one motebitId are isolated from another", async () => {
    const conv = makeConversation("mote-a", { title: "Mote A chat" });
    await relay.app.request("/sync/mote-a/conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({ conversations: [conv] }),
    });

    const res = await relay.app.request("/sync/mote-b/conversations?since=0", {
      method: "GET",
      headers: AUTH_HEADER,
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { conversations: SyncConversation[] };
    expect(body.conversations).toHaveLength(0);
  });

  // --- Last-writer-wins on upsert ---

  it("conversation upsert uses last-writer-wins for metadata", async () => {
    const convId = "conv-lww";
    const old = makeConversation(MOTEBIT_ID, {
      conversation_id: convId,
      last_active_at: 1000,
      title: "Old title",
      summary: "Old summary",
      message_count: 5,
    });
    const newer = makeConversation(MOTEBIT_ID, {
      conversation_id: convId,
      last_active_at: 2000,
      title: "New title",
      summary: "New summary",
      message_count: 3, // lower — but MAX should keep 5
    });

    await relay.app.request(`/sync/${MOTEBIT_ID}/conversations`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({ conversations: [old] }),
    });
    await relay.app.request(`/sync/${MOTEBIT_ID}/conversations`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({ conversations: [newer] }),
    });

    const res = await relay.app.request(`/sync/${MOTEBIT_ID}/conversations?since=0`, {
      method: "GET",
      headers: AUTH_HEADER,
    });

    const body = (await res.json()) as { conversations: SyncConversation[] };
    const conv = body.conversations.find((c) => c.conversation_id === convId);
    expect(conv).toBeDefined();
    expect(conv!.title).toBe("New title");
    expect(conv!.summary).toBe("New summary");
    expect(conv!.message_count).toBe(5); // MAX of 5 and 3
  });

  // --- Message deduplication ---

  it("duplicate messages are ignored (INSERT OR IGNORE)", async () => {
    const convId = "conv-dedup";
    const msg = makeMessage(convId, MOTEBIT_ID);

    // Push same message twice
    await relay.app.request(`/sync/${MOTEBIT_ID}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({ messages: [msg] }),
    });
    await relay.app.request(`/sync/${MOTEBIT_ID}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({ messages: [msg] }),
    });

    const res = await relay.app.request(
      `/sync/${MOTEBIT_ID}/messages?conversation_id=${convId}&since=0`,
      { method: "GET", headers: AUTH_HEADER },
    );

    const body = (await res.json()) as { messages: SyncConversationMessage[] };
    expect(body.messages).toHaveLength(1);
  });

  // --- Auth ---

  it("returns 401 when no token provided on conversation sync routes", async () => {
    const res = await relay.app.request(`/sync/${MOTEBIT_ID}/conversations?since=0`, { method: "GET" });
    expect(res.status).toBe(401);
  });
});
