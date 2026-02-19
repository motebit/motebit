import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  ConversationSyncEngine,
  InMemoryConversationSyncStore,
  HttpConversationSyncAdapter,
} from "../conversation-sync.js";
import type {
  ConversationSyncRemoteAdapter,
  ConversationSyncStatus,
} from "../conversation-sync.js";
import type { SyncConversation, SyncConversationMessage } from "@motebit/sdk";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MOTEBIT_ID = "motebit-conv-test";

function makeConversation(overrides: Partial<SyncConversation> = {}): SyncConversation {
  return {
    conversation_id: crypto.randomUUID(),
    motebit_id: MOTEBIT_ID,
    started_at: Date.now() - 60_000,
    last_active_at: Date.now(),
    title: null,
    summary: null,
    message_count: 0,
    ...overrides,
  };
}

function makeMessage(conversationId: string, overrides: Partial<SyncConversationMessage> = {}): SyncConversationMessage {
  return {
    message_id: crypto.randomUUID(),
    conversation_id: conversationId,
    motebit_id: MOTEBIT_ID,
    role: "user",
    content: "Hello",
    tool_calls: null,
    tool_call_id: null,
    created_at: Date.now(),
    token_estimate: 2,
    ...overrides,
  };
}

function createMockRemote(): ConversationSyncRemoteAdapter & {
  _conversations: SyncConversation[];
  _messages: SyncConversationMessage[];
} {
  const remote = {
    _conversations: [] as SyncConversation[],
    _messages: [] as SyncConversationMessage[],
    pushConversations: vi.fn(async (_mid: string, convs: SyncConversation[]) => {
      remote._conversations.push(...convs);
      return convs.length;
    }),
    pullConversations: vi.fn(async (_mid: string, since: number) => {
      return remote._conversations.filter((c) => c.last_active_at > since);
    }),
    pushMessages: vi.fn(async (_mid: string, msgs: SyncConversationMessage[]) => {
      remote._messages.push(...msgs);
      return msgs.length;
    }),
    pullMessages: vi.fn(async (_mid: string, convId: string, since: number) => {
      return remote._messages.filter((m) => m.conversation_id === convId && m.created_at > since);
    }),
  };
  return remote;
}

// ---------------------------------------------------------------------------
// InMemoryConversationSyncStore
// ---------------------------------------------------------------------------

describe("InMemoryConversationSyncStore", () => {
  let store: InMemoryConversationSyncStore;

  beforeEach(() => {
    store = new InMemoryConversationSyncStore();
  });

  it("upserts and retrieves conversations", () => {
    const conv = makeConversation();
    store.upsertConversation(conv);

    const results = store.getConversationsSince(MOTEBIT_ID, 0);
    expect(results).toHaveLength(1);
    expect(results[0]!.conversation_id).toBe(conv.conversation_id);
  });

  it("filters conversations by since timestamp", () => {
    const old = makeConversation({ last_active_at: 1000 });
    const recent = makeConversation({ last_active_at: 5000 });
    store.upsertConversation(old);
    store.upsertConversation(recent);

    const results = store.getConversationsSince(MOTEBIT_ID, 3000);
    expect(results).toHaveLength(1);
    expect(results[0]!.conversation_id).toBe(recent.conversation_id);
  });

  it("last-writer-wins on conversation metadata", () => {
    const convId = "conv-1";
    store.upsertConversation(makeConversation({
      conversation_id: convId,
      last_active_at: 1000,
      title: "Old title",
      summary: "Old summary",
    }));
    store.upsertConversation(makeConversation({
      conversation_id: convId,
      last_active_at: 2000,
      title: "New title",
      summary: "New summary",
    }));

    const results = store.getConversationsSince(MOTEBIT_ID, 0);
    expect(results).toHaveLength(1);
    expect(results[0]!.title).toBe("New title");
    expect(results[0]!.summary).toBe("New summary");
  });

  it("upserts and retrieves messages", () => {
    const convId = "conv-msg-test";
    const msg = makeMessage(convId);
    store.upsertMessage(msg);

    const results = store.getMessagesSince(convId, 0);
    expect(results).toHaveLength(1);
    expect(results[0]!.message_id).toBe(msg.message_id);
  });

  it("ignores duplicate messages", () => {
    const convId = "conv-dup";
    const msg = makeMessage(convId);
    store.upsertMessage(msg);
    store.upsertMessage(msg); // duplicate

    const results = store.getMessagesSince(convId, 0);
    expect(results).toHaveLength(1);
  });

  it("filters messages by since timestamp", () => {
    const convId = "conv-filter";
    store.upsertMessage(makeMessage(convId, { created_at: 1000 }));
    store.upsertMessage(makeMessage(convId, { created_at: 5000 }));

    const results = store.getMessagesSince(convId, 3000);
    expect(results).toHaveLength(1);
    expect(results[0]!.created_at).toBe(5000);
  });
});

// ---------------------------------------------------------------------------
// ConversationSyncEngine
// ---------------------------------------------------------------------------

describe("ConversationSyncEngine", () => {
  let localStore: InMemoryConversationSyncStore;
  let engine: ConversationSyncEngine;

  beforeEach(() => {
    localStore = new InMemoryConversationSyncStore();
    engine = new ConversationSyncEngine(localStore, MOTEBIT_ID);
  });

  it("starts in idle status", () => {
    expect(engine.getStatus()).toBe("idle");
  });

  it("sync with no remote returns offline", async () => {
    const result = await engine.sync();
    expect(engine.getStatus()).toBe("offline");
    expect(result.conversations_pushed).toBe(0);
    expect(result.conversations_pulled).toBe(0);
    expect(result.messages_pushed).toBe(0);
    expect(result.messages_pulled).toBe(0);
  });

  it("sync pushes local conversations and messages to remote", async () => {
    const remote = createMockRemote();
    engine.connectRemote(remote);

    const conv = makeConversation();
    const msg = makeMessage(conv.conversation_id);
    localStore.upsertConversation(conv);
    localStore.upsertMessage(msg);

    const result = await engine.sync();
    expect(result.conversations_pushed).toBe(1);
    expect(result.messages_pushed).toBe(1);
    expect(remote._conversations).toHaveLength(1);
    expect(remote._messages).toHaveLength(1);
  });

  it("sync pulls remote conversations and messages to local", async () => {
    const remote = createMockRemote();
    engine.connectRemote(remote);

    const conv = makeConversation();
    const msg = makeMessage(conv.conversation_id);
    remote._conversations.push(conv);
    remote._messages.push(msg);

    const result = await engine.sync();
    expect(result.conversations_pulled).toBe(1);
    expect(result.messages_pulled).toBe(1);

    const localConvs = localStore.getConversationsSince(MOTEBIT_ID, 0);
    expect(localConvs).toHaveLength(1);
    expect(localConvs[0]!.conversation_id).toBe(conv.conversation_id);

    const localMsgs = localStore.getMessagesSince(conv.conversation_id, 0);
    expect(localMsgs).toHaveLength(1);
    expect(localMsgs[0]!.message_id).toBe(msg.message_id);
  });

  it("sync updates lastSyncTimestamp after success", async () => {
    const remote = createMockRemote();
    engine.connectRemote(remote);

    expect(engine.getLastSyncTimestamp()).toBe(0);
    await engine.sync();
    expect(engine.getLastSyncTimestamp()).toBeGreaterThan(0);
  });

  it("status listeners are notified of status changes", async () => {
    const remote = createMockRemote();
    engine.connectRemote(remote);

    const statuses: ConversationSyncStatus[] = [];
    engine.onStatusChange((status) => {
      statuses.push(status);
    });

    await engine.sync();
    expect(statuses).toContain("syncing");
    expect(statuses).toContain("idle");
  });

  it("status listeners can be unsubscribed", async () => {
    const remote = createMockRemote();
    engine.connectRemote(remote);

    const statuses: ConversationSyncStatus[] = [];
    const unsub = engine.onStatusChange((status) => {
      statuses.push(status);
    });

    unsub();
    await engine.sync();
    expect(statuses).toHaveLength(0);
  });

  it("sync sets error status when remote throws", async () => {
    const failingRemote: ConversationSyncRemoteAdapter = {
      pushConversations: vi.fn().mockRejectedValue(new Error("network error")),
      pullConversations: vi.fn().mockRejectedValue(new Error("network error")),
      pushMessages: vi.fn().mockRejectedValue(new Error("network error")),
      pullMessages: vi.fn().mockRejectedValue(new Error("network error")),
    };
    engine.connectRemote(failingRemote);

    // Add data so push is attempted
    localStore.upsertConversation(makeConversation());

    const result = await engine.sync();
    expect(engine.getStatus()).toBe("error");
    expect(result.conversations_pushed).toBe(0);
  });

  it("start and stop manage the sync interval", () => {
    vi.useFakeTimers();

    const remote = createMockRemote();
    engine.connectRemote(remote);

    const syncSpy = vi.spyOn(engine, "sync");

    engine.start();
    vi.advanceTimersByTime(30_000);
    expect(syncSpy).toHaveBeenCalledTimes(1);

    engine.stop();
    vi.advanceTimersByTime(60_000);
    expect(syncSpy).toHaveBeenCalledTimes(1);

    syncSpy.mockRestore();
    vi.useRealTimers();
  });

  it("start is idempotent", () => {
    vi.useFakeTimers();

    const remote = createMockRemote();
    engine.connectRemote(remote);

    const syncSpy = vi.spyOn(engine, "sync");

    engine.start();
    engine.start(); // second call should be no-op
    vi.advanceTimersByTime(30_000);
    expect(syncSpy).toHaveBeenCalledTimes(1);

    engine.stop();
    syncSpy.mockRestore();
    vi.useRealTimers();
  });

  it("bidirectional sync: conversations from both sides merge correctly", async () => {
    const remote = createMockRemote();
    engine.connectRemote(remote);

    // Local has one conversation
    const localConv = makeConversation({ title: "Local conv" });
    localStore.upsertConversation(localConv);

    // Remote has a different conversation
    const remoteConv = makeConversation({ title: "Remote conv" });
    remote._conversations.push(remoteConv);

    await engine.sync();

    // Local should now have both conversations
    const localConvs = localStore.getConversationsSince(MOTEBIT_ID, 0);
    expect(localConvs).toHaveLength(2);
    const titles = localConvs.map((c) => c.title);
    expect(titles).toContain("Local conv");
    expect(titles).toContain("Remote conv");

    // Remote should also have the local conv pushed to it
    expect(remote._conversations).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// HttpConversationSyncAdapter
// ---------------------------------------------------------------------------

describe("HttpConversationSyncAdapter", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const BASE_URL = "http://localhost:3000";
  const AUTH_TOKEN = "test-token";

  it("pushConversations sends POST with correct URL and auth", async () => {
    const mockFn = globalThis.fetch as ReturnType<typeof vi.fn>;
    mockFn.mockResolvedValueOnce(
      new Response(JSON.stringify({ accepted: 1 }), { status: 200 }),
    );

    const adapter = new HttpConversationSyncAdapter({
      baseUrl: BASE_URL,
      motebitId: MOTEBIT_ID,
      authToken: AUTH_TOKEN,
    });

    const conv = makeConversation();
    await adapter.pushConversations(MOTEBIT_ID, [conv]);

    expect(mockFn).toHaveBeenCalledTimes(1);
    const [url, options] = mockFn.mock.calls[0]!;
    expect(url).toBe(`${BASE_URL}/sync/${MOTEBIT_ID}/conversations`);
    expect(options.method).toBe("POST");
    expect(options.headers["Authorization"]).toBe(`Bearer ${AUTH_TOKEN}`);
  });

  it("pullConversations sends GET with since parameter", async () => {
    const mockFn = globalThis.fetch as ReturnType<typeof vi.fn>;
    mockFn.mockResolvedValueOnce(
      new Response(JSON.stringify({ conversations: [] }), { status: 200 }),
    );

    const adapter = new HttpConversationSyncAdapter({
      baseUrl: BASE_URL,
      motebitId: MOTEBIT_ID,
      authToken: AUTH_TOKEN,
    });

    await adapter.pullConversations(MOTEBIT_ID, 12345);

    const [url] = mockFn.mock.calls[0]!;
    expect(url).toBe(`${BASE_URL}/sync/${MOTEBIT_ID}/conversations?since=12345`);
  });

  it("pushMessages sends POST with correct URL", async () => {
    const mockFn = globalThis.fetch as ReturnType<typeof vi.fn>;
    mockFn.mockResolvedValueOnce(
      new Response(JSON.stringify({ accepted: 1 }), { status: 200 }),
    );

    const adapter = new HttpConversationSyncAdapter({
      baseUrl: BASE_URL,
      motebitId: MOTEBIT_ID,
      authToken: AUTH_TOKEN,
    });

    const msg = makeMessage("conv-1");
    await adapter.pushMessages(MOTEBIT_ID, [msg]);

    const [url, options] = mockFn.mock.calls[0]!;
    expect(url).toBe(`${BASE_URL}/sync/${MOTEBIT_ID}/messages`);
    expect(options.method).toBe("POST");
  });

  it("pullMessages sends GET with conversation_id and since parameters", async () => {
    const mockFn = globalThis.fetch as ReturnType<typeof vi.fn>;
    mockFn.mockResolvedValueOnce(
      new Response(JSON.stringify({ messages: [] }), { status: 200 }),
    );

    const adapter = new HttpConversationSyncAdapter({
      baseUrl: BASE_URL,
      motebitId: MOTEBIT_ID,
      authToken: AUTH_TOKEN,
    });

    await adapter.pullMessages(MOTEBIT_ID, "conv-1", 5000);

    const [url] = mockFn.mock.calls[0]!;
    expect(url).toBe(`${BASE_URL}/sync/${MOTEBIT_ID}/messages?conversation_id=conv-1&since=5000`);
  });

  it("pushConversations throws on non-200 response", async () => {
    const mockFn = globalThis.fetch as ReturnType<typeof vi.fn>;
    mockFn.mockResolvedValueOnce(
      new Response("Unauthorized", { status: 401, statusText: "Unauthorized" }),
    );

    const adapter = new HttpConversationSyncAdapter({
      baseUrl: BASE_URL,
      motebitId: MOTEBIT_ID,
    });

    await expect(adapter.pushConversations(MOTEBIT_ID, [makeConversation()]))
      .rejects.toThrow("Push conversations failed: 401 Unauthorized");
  });

  it("pullConversations throws on non-200 response", async () => {
    const mockFn = globalThis.fetch as ReturnType<typeof vi.fn>;
    mockFn.mockResolvedValueOnce(
      new Response("Server Error", { status: 500, statusText: "Internal Server Error" }),
    );

    const adapter = new HttpConversationSyncAdapter({
      baseUrl: BASE_URL,
      motebitId: MOTEBIT_ID,
    });

    await expect(adapter.pullConversations(MOTEBIT_ID, 0))
      .rejects.toThrow("Pull conversations failed: 500 Internal Server Error");
  });

  it("omits Authorization header when no authToken", async () => {
    const mockFn = globalThis.fetch as ReturnType<typeof vi.fn>;
    mockFn.mockResolvedValueOnce(
      new Response(JSON.stringify({ conversations: [] }), { status: 200 }),
    );

    const adapter = new HttpConversationSyncAdapter({
      baseUrl: BASE_URL,
      motebitId: MOTEBIT_ID,
    });

    await adapter.pullConversations(MOTEBIT_ID, 0);

    const [, options] = mockFn.mock.calls[0]!;
    expect(options.headers["Authorization"]).toBeUndefined();
  });
});
