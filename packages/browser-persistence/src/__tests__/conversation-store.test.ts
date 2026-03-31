import { describe, it, expect, beforeEach } from "vitest";
import { openMotebitDB } from "../idb.js";
import { IdbConversationStore } from "../conversation-store.js";

describe("IdbConversationStore", () => {
  let store: IdbConversationStore;
  const motebitId = "m-test-conv";

  beforeEach(async () => {
    const db = await openMotebitDB(`test-conv-${crypto.randomUUID()}`);
    store = new IdbConversationStore(db);
  });

  it("createConversation returns a UUID and updates caches", () => {
    const id = store.createConversation(motebitId);
    expect(id).toBeTruthy();
    expect(typeof id).toBe("string");

    // Should appear in list cache
    const list = store.listConversations(motebitId);
    expect(list).toHaveLength(1);
    expect(list[0]!.conversationId).toBe(id);

    // Should be the active conversation
    const active = store.getActiveConversation(motebitId);
    expect(active).not.toBeNull();
    expect(active!.conversationId).toBe(id);

    // Should have empty message cache
    const msgs = store.loadMessages(id);
    expect(msgs).toHaveLength(0);
  });

  it("appendMessage uses monotonic timestamps and updates cache", () => {
    const convId = store.createConversation(motebitId);
    store.appendMessage(convId, motebitId, { role: "user", content: "hello" });
    store.appendMessage(convId, motebitId, { role: "assistant", content: "hi" });

    const msgs = store.loadMessages(convId);
    expect(msgs).toHaveLength(2);
    // Monotonic: second timestamp strictly greater
    expect(msgs[1]!.createdAt).toBeGreaterThan(msgs[0]!.createdAt);
    expect(msgs[0]!.role).toBe("user");
    expect(msgs[1]!.role).toBe("assistant");
  });

  it("appendMessage stores toolCalls and toolCallId", () => {
    const convId = store.createConversation(motebitId);
    store.appendMessage(convId, motebitId, {
      role: "assistant",
      content: "calling tool",
      toolCalls: '[{"name":"search"}]',
      toolCallId: "tc-1",
    });

    const msgs = store.loadMessages(convId);
    expect(msgs[0]!.toolCalls).toBe('[{"name":"search"}]');
    expect(msgs[0]!.toolCallId).toBe("tc-1");
  });

  it("loadMessages respects limit parameter", () => {
    const convId = store.createConversation(motebitId);
    for (let i = 0; i < 5; i++) {
      store.appendMessage(convId, motebitId, { role: "user", content: `msg ${i}` });
    }

    const limited = store.loadMessages(convId, 2);
    expect(limited).toHaveLength(2);
    // Should be the last 2 messages
    expect(limited[0]!.content).toBe("msg 3");
    expect(limited[1]!.content).toBe("msg 4");
  });

  it("loadMessages returns empty for unknown conversation", () => {
    expect(store.loadMessages("unknown")).toHaveLength(0);
  });

  it("getActiveConversation returns null when no conversations", () => {
    expect(store.getActiveConversation(motebitId)).toBeNull();
  });

  it("updateSummary modifies active conversation cache", () => {
    const convId = store.createConversation(motebitId);
    store.updateSummary(convId, "A summary");

    const active = store.getActiveConversation(motebitId);
    expect(active!.summary).toBe("A summary");
  });

  it("updateTitle modifies list cache", () => {
    const convId = store.createConversation(motebitId);
    store.updateTitle(convId, "My Chat");

    const list = store.listConversations(motebitId);
    expect(list[0]!.title).toBe("My Chat");
  });

  it("listConversations respects limit", () => {
    store.createConversation(motebitId);
    store.createConversation(motebitId);
    store.createConversation(motebitId);

    const limited = store.listConversations(motebitId, 2);
    expect(limited).toHaveLength(2);
  });

  it("listConversations returns empty for unknown motebitId", () => {
    expect(store.listConversations("unknown")).toHaveLength(0);
  });

  it("deleteConversation cascades messages and invalidates caches", () => {
    const convId = store.createConversation(motebitId);
    store.appendMessage(convId, motebitId, { role: "user", content: "test" });

    store.deleteConversation(convId);

    expect(store.loadMessages(convId)).toHaveLength(0);
    expect(store.listConversations(motebitId)).toHaveLength(0);
    expect(store.getActiveConversation(motebitId)).toBeNull();
  });

  it("upsertSyncConversation creates a new entry in cache", () => {
    // Initialize the list cache first
    store.createConversation(motebitId);
    const now = Date.now();

    store.upsertSyncConversation({
      conversation_id: "sync-conv-1",
      motebit_id: motebitId,
      started_at: now - 1000,
      last_active_at: now,
      title: "Synced Chat",
      summary: null,
      message_count: 5,
    });

    const list = store.listConversations(motebitId);
    const synced = list.find((c) => c.conversationId === "sync-conv-1");
    expect(synced).toBeDefined();
    expect(synced!.title).toBe("Synced Chat");
    expect(synced!.messageCount).toBe(5);
  });

  it("upsertSyncConversation updates existing entry in cache", () => {
    store.createConversation(motebitId);
    const now = Date.now();

    store.upsertSyncConversation({
      conversation_id: "sync-conv-2",
      motebit_id: motebitId,
      started_at: now - 2000,
      last_active_at: now - 1000,
      title: "Old Title",
      summary: null,
      message_count: 3,
    });

    store.upsertSyncConversation({
      conversation_id: "sync-conv-2",
      motebit_id: motebitId,
      started_at: now - 2000,
      last_active_at: now,
      title: "New Title",
      summary: "updated",
      message_count: 7,
    });

    const list = store.listConversations(motebitId);
    const entries = list.filter((c) => c.conversationId === "sync-conv-2");
    expect(entries).toHaveLength(1);
    expect(entries[0]!.title).toBe("New Title");
    expect(entries[0]!.messageCount).toBe(7);
  });

  it("upsertSyncMessage deduplicates and sorts by createdAt", () => {
    const convId = store.createConversation(motebitId);
    const now = Date.now();

    store.upsertSyncMessage({
      message_id: "msg-1",
      conversation_id: convId,
      motebit_id: motebitId,
      role: "user",
      content: "hello",
      tool_calls: null,
      tool_call_id: null,
      created_at: now + 100,
      token_estimate: 2,
    });

    // Duplicate — should not add again
    store.upsertSyncMessage({
      message_id: "msg-1",
      conversation_id: convId,
      motebit_id: motebitId,
      role: "user",
      content: "hello",
      tool_calls: null,
      tool_call_id: null,
      created_at: now + 100,
      token_estimate: 2,
    });

    // Earlier message — should be sorted before msg-1
    store.upsertSyncMessage({
      message_id: "msg-0",
      conversation_id: convId,
      motebit_id: motebitId,
      role: "assistant",
      content: "hi",
      tool_calls: null,
      tool_call_id: null,
      created_at: now,
      token_estimate: 1,
    });

    const msgs = store.loadMessages(convId);
    expect(msgs).toHaveLength(2);
    expect(msgs[0]!.messageId).toBe("msg-0");
    expect(msgs[1]!.messageId).toBe("msg-1");
  });

  it("preload loads conversations + active + messages within 4h window", async () => {
    const convId = store.createConversation(motebitId);
    store.appendMessage(convId, motebitId, { role: "user", content: "recent" });

    // Wait for IDB writes
    await new Promise((r) => setTimeout(r, 50));

    // Create a new store from the same DB
    const db = (store as unknown as { db: IDBDatabase }).db;
    const store2 = new IdbConversationStore(db);

    // Before preload: caches are empty
    expect(store2.listConversations(motebitId)).toHaveLength(0);
    expect(store2.getActiveConversation(motebitId)).toBeNull();

    await store2.preload(motebitId);

    // After preload: data loaded
    const list = store2.listConversations(motebitId);
    expect(list).toHaveLength(1);
    expect(list[0]!.conversationId).toBe(convId);

    // Active conversation found (within 4h)
    const active = store2.getActiveConversation(motebitId);
    expect(active).not.toBeNull();
    expect(active!.conversationId).toBe(convId);

    // Messages loaded for active conversation
    const msgs = store2.loadMessages(convId);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.content).toBe("recent");
  });

  it("preload does not set active for old conversations", async () => {
    // Directly write a conversation with old lastActiveAt to IDB
    const db = (store as unknown as { db: IDBDatabase }).db;
    const convId = "old-conv";
    const fiveHoursAgo = Date.now() - 5 * 60 * 60 * 1000;

    const tx = db.transaction("conversations", "readwrite");
    tx.objectStore("conversations").put({
      conversationId: convId,
      motebitId,
      startedAt: fiveHoursAgo,
      lastActiveAt: fiveHoursAgo,
      title: null,
      summary: null,
      messageCount: 0,
    });

    await new Promise((r) => setTimeout(r, 50));

    const store2 = new IdbConversationStore(db);
    await store2.preload(motebitId);

    // Should be in list but not active
    expect(store2.listConversations(motebitId)).toHaveLength(1);
    expect(store2.getActiveConversation(motebitId)).toBeNull();
  });

  it("preloadConversation loads messages into cache", async () => {
    const convId = store.createConversation(motebitId);
    store.appendMessage(convId, motebitId, { role: "user", content: "test msg" });

    await new Promise((r) => setTimeout(r, 50));

    const db = (store as unknown as { db: IDBDatabase }).db;
    const store2 = new IdbConversationStore(db);

    expect(store2.loadMessages(convId)).toHaveLength(0);
    await store2.preloadConversation(convId);
    const msgs = store2.loadMessages(convId);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.content).toBe("test msg");
  });

  it("preloadConversation skips if already cached", async () => {
    const convId = store.createConversation(motebitId);
    store.appendMessage(convId, motebitId, { role: "user", content: "first" });

    await new Promise((r) => setTimeout(r, 50));

    const db = (store as unknown as { db: IDBDatabase }).db;
    const store2 = new IdbConversationStore(db);
    await store2.preloadConversation(convId);

    // Add another message to IDB directly
    const tx = db.transaction("conversation_messages", "readwrite");
    tx.objectStore("conversation_messages").put({
      messageId: "extra-msg",
      conversationId: convId,
      motebitId,
      role: "assistant",
      content: "second",
      toolCalls: null,
      toolCallId: null,
      createdAt: Date.now(),
      tokenEstimate: 2,
    });
    await new Promise((r) => setTimeout(r, 50));

    // preloadConversation should skip since already cached
    await store2.preloadConversation(convId);
    expect(store2.loadMessages(convId)).toHaveLength(1);
  });

  it("preloadAllMessages loads messages for all cached conversations", async () => {
    const conv1 = store.createConversation(motebitId);
    const conv2 = store.createConversation(motebitId);
    store.appendMessage(conv1, motebitId, { role: "user", content: "msg1" });
    store.appendMessage(conv2, motebitId, { role: "user", content: "msg2" });

    await new Promise((r) => setTimeout(r, 50));

    const db = (store as unknown as { db: IDBDatabase }).db;
    const store2 = new IdbConversationStore(db);

    // Preload conversations list first
    await store2.preload(motebitId);

    // Clear message caches to test preloadAllMessages
    // Force clear by creating fresh store with list cache populated
    const store3 = new IdbConversationStore(db);
    await store3.preload(motebitId);

    // preloadAllMessages should load messages for all conversations
    await store3.preloadAllMessages();

    expect(store3.loadMessages(conv1).length).toBeGreaterThanOrEqual(1);
    expect(store3.loadMessages(conv2).length).toBeGreaterThanOrEqual(1);
  });

  it("appendMessage updates conversation list cache entry", () => {
    const convId = store.createConversation(motebitId);
    const listBefore = store.listConversations(motebitId);
    expect(listBefore[0]!.messageCount).toBe(0);

    store.appendMessage(convId, motebitId, { role: "user", content: "bump" });

    const listAfter = store.listConversations(motebitId);
    expect(listAfter[0]!.messageCount).toBe(1);
  });
});
