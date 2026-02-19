import { describe, it, expect, beforeEach } from "vitest";
import { createMotebitDatabase, type MotebitDatabase } from "../index.js";

describe("SqliteConversationStore", () => {
  let moteDb: MotebitDatabase;

  beforeEach(() => {
    moteDb = createMotebitDatabase(":memory:");
  });

  it("creates a conversation and returns a UUID", () => {
    const id = moteDb.conversationStore.createConversation("mote-abc");
    expect(id).toBeTruthy();
    expect(id.length).toBe(36); // UUID format
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
    expect(messages[0]!.tokenEstimate).toBe(25); // ceil(100/4)
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
    // Small delay to ensure different timestamps
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
    // Most recent first
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
});
