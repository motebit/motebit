import { describe, it, expect, beforeEach } from "vitest";
import { createMotebitDatabase, type MotebitDatabase, type Conversation, type ConversationMessage } from "../index.js";

describe("SqliteConversationStore", () => {
  let moteDb: MotebitDatabase;

  beforeEach(() => {
    moteDb = createMotebitDatabase(":memory:");
  });

  // ============================================================
  // Core CRUD (existing tests preserved)
  // ============================================================

  it("creates a conversation and returns a UUID", () => {
    const id = moteDb.conversationStore.createConversation("mote-abc");
    expect(id).toBeTruthy();
    expect(id.length).toBe(36);
  });

  it("appends messages and loads them in order", () => {
    const convId = moteDb.conversationStore.createConversation("mote-abc");

    moteDb.conversationStore.appendMessage(convId, "mote-abc", {
      role: "user",
      content: "Hello there",
    });
    moteDb.conversationStore.appendMessage(convId, "mote-abc", {
      role: "assistant",
      content: "Hi! How can I help?",
    });

    const messages = moteDb.conversationStore.loadMessages(convId);
    expect(messages).toHaveLength(2);
    expect(messages[0]!.role).toBe("user");
    expect(messages[0]!.content).toBe("Hello there");
    expect(messages[1]!.role).toBe("assistant");
    expect(messages[1]!.content).toBe("Hi! How can I help?");
  });

  it("computes token estimates", () => {
    const convId = moteDb.conversationStore.createConversation("mote-abc");
    const content = "a".repeat(100);
    moteDb.conversationStore.appendMessage(convId, "mote-abc", {
      role: "user",
      content,
    });

    const messages = moteDb.conversationStore.loadMessages(convId);
    expect(messages[0]!.tokenEstimate).toBe(25);
  });

  it("updates conversation metadata on append", () => {
    const convId = moteDb.conversationStore.createConversation("mote-abc");
    moteDb.conversationStore.appendMessage(convId, "mote-abc", {
      role: "user",
      content: "msg 1",
    });
    moteDb.conversationStore.appendMessage(convId, "mote-abc", {
      role: "assistant",
      content: "msg 2",
    });

    const convList = moteDb.conversationStore.listConversations("mote-abc");
    expect(convList).toHaveLength(1);
    expect(convList[0]!.messageCount).toBe(2);
  });

  it("getActiveConversation returns recent conversation within 4h window", () => {
    const convId = moteDb.conversationStore.createConversation("mote-abc");
    moteDb.conversationStore.appendMessage(convId, "mote-abc", {
      role: "user",
      content: "hello",
    });

    const active = moteDb.conversationStore.getActiveConversation("mote-abc");
    expect(active).not.toBeNull();
    expect(active!.conversationId).toBe(convId);
  });

  it("getActiveConversation returns null for different motebit", () => {
    const convId = moteDb.conversationStore.createConversation("mote-abc");
    moteDb.conversationStore.appendMessage(convId, "mote-abc", {
      role: "user",
      content: "hello",
    });

    const active = moteDb.conversationStore.getActiveConversation("mote-xyz");
    expect(active).toBeNull();
  });

  it("updateSummary stores and retrieves summary", () => {
    const convId = moteDb.conversationStore.createConversation("mote-abc");
    moteDb.conversationStore.updateSummary(convId, "User asked about tea preferences");

    const active = moteDb.conversationStore.getActiveConversation("mote-abc");
    expect(active).not.toBeNull();
    expect(active!.summary).toBe("User asked about tea preferences");
  });

  it("listConversations returns ordered by last_active_at desc", () => {
    const id1 = moteDb.conversationStore.createConversation("mote-abc");
    moteDb.conversationStore.appendMessage(id1, "mote-abc", {
      role: "user",
      content: "first conversation",
    });

    const id2 = moteDb.conversationStore.createConversation("mote-abc");
    moteDb.conversationStore.appendMessage(id2, "mote-abc", {
      role: "user",
      content: "second conversation",
    });

    const list = moteDb.conversationStore.listConversations("mote-abc");
    expect(list).toHaveLength(2);
    expect(list[0]!.lastActiveAt).toBeGreaterThanOrEqual(list[1]!.lastActiveAt);
  });

  it("loadMessages respects limit", () => {
    const convId = moteDb.conversationStore.createConversation("mote-abc");
    for (let i = 0; i < 10; i++) {
      moteDb.conversationStore.appendMessage(convId, "mote-abc", {
        role: "user",
        content: `message ${i}`,
      });
    }

    const limited = moteDb.conversationStore.loadMessages(convId, 3);
    expect(limited).toHaveLength(3);
  });

  it("listConversations respects limit", () => {
    for (let i = 0; i < 5; i++) {
      moteDb.conversationStore.createConversation("mote-abc");
    }

    const limited = moteDb.conversationStore.listConversations("mote-abc", 2);
    expect(limited).toHaveLength(2);
  });

  it("preserves tool call metadata", () => {
    const convId = moteDb.conversationStore.createConversation("mote-abc");
    moteDb.conversationStore.appendMessage(convId, "mote-abc", {
      role: "assistant",
      content: "Let me search for that",
      toolCalls: JSON.stringify([{ id: "tc-1", name: "search", args: { q: "hello" } }]),
    });
    moteDb.conversationStore.appendMessage(convId, "mote-abc", {
      role: "user",
      content: '{"ok":true,"data":"result"}',
      toolCallId: "tc-1",
    });

    const messages = moteDb.conversationStore.loadMessages(convId);
    expect(messages).toHaveLength(2);
    expect(messages[0]!.toolCalls).toBe(JSON.stringify([{ id: "tc-1", name: "search", args: { q: "hello" } }]));
    expect(messages[1]!.toolCallId).toBe("tc-1");
  });

  // ============================================================
  // Sync methods — getConversationsSince
  // ============================================================

  it("getConversationsSince returns conversations updated after timestamp", () => {
    const beforeTime = Date.now();
    const id1 = moteDb.conversationStore.createConversation("mote-abc");
    moteDb.conversationStore.appendMessage(id1, "mote-abc", {
      role: "user",
      content: "hello",
    });

    const results = moteDb.conversationStore.getConversationsSince("mote-abc", beforeTime - 1);
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.some((c) => c.conversationId === id1)).toBe(true);
  });

  it("getConversationsSince returns empty for future timestamp", () => {
    moteDb.conversationStore.createConversation("mote-abc");
    const results = moteDb.conversationStore.getConversationsSince("mote-abc", Date.now() + 100000);
    expect(results).toHaveLength(0);
  });

  it("getConversationsSince filters by motebitId", () => {
    moteDb.conversationStore.createConversation("mote-abc");
    moteDb.conversationStore.createConversation("mote-xyz");

    const results = moteDb.conversationStore.getConversationsSince("mote-abc", 0);
    expect(results).toHaveLength(1);
    expect(results[0]!.motebitId).toBe("mote-abc");
  });

  it("getConversationsSince orders by last_active_at ASC", () => {
    const id1 = moteDb.conversationStore.createConversation("mote-abc");
    const id2 = moteDb.conversationStore.createConversation("mote-abc");
    // Append to id2 first so it has a later last_active_at
    moteDb.conversationStore.appendMessage(id1, "mote-abc", { role: "user", content: "first" });
    moteDb.conversationStore.appendMessage(id2, "mote-abc", { role: "user", content: "second" });

    const results = moteDb.conversationStore.getConversationsSince("mote-abc", 0);
    expect(results.length).toBe(2);
    expect(results[0]!.lastActiveAt).toBeLessThanOrEqual(results[1]!.lastActiveAt);
  });

  // ============================================================
  // Sync methods — getMessagesSince
  // ============================================================

  it("getMessagesSince returns messages created after timestamp", () => {
    const convId = moteDb.conversationStore.createConversation("mote-abc");
    const beforeMsg = Date.now();
    moteDb.conversationStore.appendMessage(convId, "mote-abc", {
      role: "user",
      content: "new message",
    });

    const results = moteDb.conversationStore.getMessagesSince(convId, beforeMsg - 1);
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]!.content).toBe("new message");
  });

  it("getMessagesSince returns empty for future timestamp", () => {
    const convId = moteDb.conversationStore.createConversation("mote-abc");
    moteDb.conversationStore.appendMessage(convId, "mote-abc", {
      role: "user",
      content: "hello",
    });

    const results = moteDb.conversationStore.getMessagesSince(convId, Date.now() + 100000);
    expect(results).toHaveLength(0);
  });

  it("getMessagesSince orders by created_at ASC", () => {
    const convId = moteDb.conversationStore.createConversation("mote-abc");
    moteDb.conversationStore.appendMessage(convId, "mote-abc", { role: "user", content: "msg1" });
    moteDb.conversationStore.appendMessage(convId, "mote-abc", { role: "assistant", content: "msg2" });
    moteDb.conversationStore.appendMessage(convId, "mote-abc", { role: "user", content: "msg3" });

    const results = moteDb.conversationStore.getMessagesSince(convId, 0);
    expect(results).toHaveLength(3);
    for (let i = 1; i < results.length; i++) {
      expect(results[i]!.createdAt).toBeGreaterThanOrEqual(results[i - 1]!.createdAt);
    }
  });

  // ============================================================
  // Sync methods — upsertConversation
  // ============================================================

  it("upsertConversation inserts new conversation", () => {
    const conv: Conversation = {
      conversationId: "sync-conv-1",
      motebitId: "mote-abc",
      startedAt: 1000,
      lastActiveAt: 2000,
      title: "Synced title",
      summary: "Synced summary",
      messageCount: 5,
    };

    moteDb.conversationStore.upsertConversation(conv);
    const result = moteDb.conversationStore.getConversation("sync-conv-1");
    expect(result).not.toBeNull();
    expect(result!.title).toBe("Synced title");
    expect(result!.summary).toBe("Synced summary");
    expect(result!.messageCount).toBe(5);
  });

  it("upsertConversation uses last-writer-wins for metadata", () => {
    // Insert initial
    moteDb.conversationStore.upsertConversation({
      conversationId: "sync-conv-2",
      motebitId: "mote-abc",
      startedAt: 1000,
      lastActiveAt: 2000,
      title: "Old title",
      summary: "Old summary",
      messageCount: 3,
    });

    // Upsert with newer lastActiveAt
    moteDb.conversationStore.upsertConversation({
      conversationId: "sync-conv-2",
      motebitId: "mote-abc",
      startedAt: 1000,
      lastActiveAt: 3000, // newer
      title: "New title",
      summary: "New summary",
      messageCount: 7,
    });

    const result = moteDb.conversationStore.getConversation("sync-conv-2");
    expect(result!.lastActiveAt).toBe(3000); // MAX
    expect(result!.title).toBe("New title"); // from newer record
    expect(result!.summary).toBe("New summary"); // from newer record
    expect(result!.messageCount).toBe(7); // MAX
  });

  it("upsertConversation keeps existing metadata if incoming is older", () => {
    // Insert with newer timestamp first
    moteDb.conversationStore.upsertConversation({
      conversationId: "sync-conv-3",
      motebitId: "mote-abc",
      startedAt: 1000,
      lastActiveAt: 5000,
      title: "Latest title",
      summary: "Latest summary",
      messageCount: 10,
    });

    // Upsert with older lastActiveAt
    moteDb.conversationStore.upsertConversation({
      conversationId: "sync-conv-3",
      motebitId: "mote-abc",
      startedAt: 1000,
      lastActiveAt: 2000, // older
      title: "Stale title",
      summary: "Stale summary",
      messageCount: 3,
    });

    const result = moteDb.conversationStore.getConversation("sync-conv-3");
    expect(result!.lastActiveAt).toBe(5000); // MAX keeps the newer
    expect(result!.title).toBe("Latest title"); // keeps existing (newer)
    expect(result!.messageCount).toBe(10); // MAX keeps higher
  });

  it("upsertConversation handles null title and summary", () => {
    moteDb.conversationStore.upsertConversation({
      conversationId: "sync-null",
      motebitId: "mote-abc",
      startedAt: 1000,
      lastActiveAt: 2000,
      title: null,
      summary: null,
      messageCount: 0,
    });

    const result = moteDb.conversationStore.getConversation("sync-null");
    expect(result!.title).toBeNull();
    expect(result!.summary).toBeNull();
  });

  // ============================================================
  // Sync methods — upsertMessage
  // ============================================================

  it("upsertMessage inserts new message", () => {
    const convId = moteDb.conversationStore.createConversation("mote-abc");

    const msg: ConversationMessage = {
      messageId: "sync-msg-1",
      conversationId: convId,
      motebitId: "mote-abc",
      role: "user",
      content: "Synced message",
      toolCalls: null,
      toolCallId: null,
      createdAt: Date.now(),
      tokenEstimate: 4,
    };

    moteDb.conversationStore.upsertMessage(msg);
    const messages = moteDb.conversationStore.loadMessages(convId);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.content).toBe("Synced message");
    expect(messages[0]!.messageId).toBe("sync-msg-1");
  });

  it("upsertMessage ignores duplicate message_id", () => {
    const convId = moteDb.conversationStore.createConversation("mote-abc");

    const msg: ConversationMessage = {
      messageId: "dup-msg-1",
      conversationId: convId,
      motebitId: "mote-abc",
      role: "user",
      content: "Original",
      toolCalls: null,
      toolCallId: null,
      createdAt: Date.now(),
      tokenEstimate: 2,
    };

    moteDb.conversationStore.upsertMessage(msg);
    // Try inserting again with different content
    moteDb.conversationStore.upsertMessage({
      ...msg,
      content: "Duplicate attempt",
    });

    const messages = moteDb.conversationStore.loadMessages(convId);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.content).toBe("Original"); // first one wins
  });

  it("upsertMessage preserves tool call metadata", () => {
    const convId = moteDb.conversationStore.createConversation("mote-abc");

    moteDb.conversationStore.upsertMessage({
      messageId: "tool-msg-1",
      conversationId: convId,
      motebitId: "mote-abc",
      role: "assistant",
      content: "Using tool",
      toolCalls: '[{"id":"tc-1","name":"search"}]',
      toolCallId: null,
      createdAt: Date.now(),
      tokenEstimate: 3,
    });

    const messages = moteDb.conversationStore.loadMessages(convId);
    expect(messages[0]!.toolCalls).toBe('[{"id":"tc-1","name":"search"}]');
  });

  // ============================================================
  // Sync methods — getConversation
  // ============================================================

  it("getConversation returns null for non-existent ID", () => {
    const result = moteDb.conversationStore.getConversation("non-existent-id");
    expect(result).toBeNull();
  });

  it("getConversation returns conversation by ID", () => {
    const convId = moteDb.conversationStore.createConversation("mote-abc");
    moteDb.conversationStore.updateSummary(convId, "Test summary");

    const result = moteDb.conversationStore.getConversation(convId);
    expect(result).not.toBeNull();
    expect(result!.conversationId).toBe(convId);
    expect(result!.motebitId).toBe("mote-abc");
    expect(result!.summary).toBe("Test summary");
  });

  // ============================================================
  // Edge cases
  // ============================================================

  it("loadMessages returns empty for non-existent conversation", () => {
    const messages = moteDb.conversationStore.loadMessages("non-existent");
    expect(messages).toEqual([]);
  });

  it("conversation starts with messageCount 0", () => {
    moteDb.conversationStore.createConversation("mote-abc");
    const list = moteDb.conversationStore.listConversations("mote-abc");
    expect(list[0]!.messageCount).toBe(0);
  });

  it("conversation starts with null title and summary", () => {
    moteDb.conversationStore.createConversation("mote-abc");
    const list = moteDb.conversationStore.listConversations("mote-abc");
    expect(list[0]!.title).toBeNull();
    expect(list[0]!.summary).toBeNull();
  });
});
