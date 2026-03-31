import { describe, it, expect, beforeEach } from "vitest";
import { openMotebitDB } from "../idb.js";
import { IdbConversationStore } from "../conversation-store.js";
import { IdbConversationSyncStore } from "../conversation-sync-store.js";

describe("IdbConversationSyncStore", () => {
  let convStore: IdbConversationStore;
  let syncStore: IdbConversationSyncStore;
  const motebitId = "m-test-sync";

  beforeEach(async () => {
    const db = await openMotebitDB(`test-conv-sync-${crypto.randomUUID()}`);
    convStore = new IdbConversationStore(db);
    syncStore = new IdbConversationSyncStore(convStore, motebitId);
  });

  it("getConversationsSince filters by lastActiveAt > since", () => {
    convStore.createConversation(motebitId);
    // Small delay to ensure different timestamps
    const since = Date.now() + 1000;

    // All conversations should have lastActiveAt < since (just created)
    const results = syncStore.getConversationsSince(motebitId, since);
    expect(results).toHaveLength(0);

    // Conversations before now should be returned
    const allResults = syncStore.getConversationsSince(motebitId, 0);
    expect(allResults).toHaveLength(1);
  });

  it("getConversationsSince maps to snake_case fields", () => {
    convStore.createConversation(motebitId);
    const results = syncStore.getConversationsSince(motebitId, 0);
    expect(results).toHaveLength(1);

    const conv = results[0]!;
    // snake_case fields
    expect(conv).toHaveProperty("conversation_id");
    expect(conv).toHaveProperty("motebit_id");
    expect(conv).toHaveProperty("started_at");
    expect(conv).toHaveProperty("last_active_at");
    expect(conv).toHaveProperty("message_count");
    expect(conv.motebit_id).toBe(motebitId);
  });

  it("getMessagesSince filters by createdAt > since", () => {
    const convId = convStore.createConversation(motebitId);
    convStore.appendMessage(convId, motebitId, { role: "user", content: "old msg" });

    const since = Date.now() + 1000;

    // Messages before since should not appear
    const results = syncStore.getMessagesSince(convId, since);
    expect(results).toHaveLength(0);

    // All messages should appear with since=0
    const allResults = syncStore.getMessagesSince(convId, 0);
    expect(allResults).toHaveLength(1);
  });

  it("getMessagesSince maps to snake_case fields", () => {
    const convId = convStore.createConversation(motebitId);
    convStore.appendMessage(convId, motebitId, { role: "user", content: "test" });

    const results = syncStore.getMessagesSince(convId, 0);
    expect(results).toHaveLength(1);

    const msg = results[0]!;
    // snake_case fields
    expect(msg).toHaveProperty("message_id");
    expect(msg).toHaveProperty("conversation_id");
    expect(msg).toHaveProperty("motebit_id");
    expect(msg).toHaveProperty("tool_calls");
    expect(msg).toHaveProperty("tool_call_id");
    expect(msg).toHaveProperty("created_at");
    expect(msg).toHaveProperty("token_estimate");
    expect(msg.role).toBe("user");
    expect(msg.content).toBe("test");
  });

  it("upsertConversation writes through to convStore", () => {
    // Need list cache to exist first
    convStore.createConversation(motebitId);
    const now = Date.now();

    syncStore.upsertConversation({
      conversation_id: "sync-c1" as never,
      motebit_id: motebitId as never,
      started_at: now - 1000,
      last_active_at: now,
      title: "Synced",
      summary: null,
      message_count: 3,
    });

    const list = convStore.listConversations(motebitId);
    const found = list.find((c) => c.conversationId === "sync-c1");
    expect(found).toBeDefined();
    expect(found!.title).toBe("Synced");
  });

  it("upsertMessage writes through to convStore", () => {
    const convId = convStore.createConversation(motebitId);
    const now = Date.now();

    syncStore.upsertMessage({
      message_id: "sync-m1",
      conversation_id: convId as never,
      motebit_id: motebitId as never,
      role: "assistant",
      content: "synced message",
      tool_calls: null,
      tool_call_id: null,
      created_at: now,
      token_estimate: 4,
    });

    const msgs = convStore.loadMessages(convId);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.content).toBe("synced message");
  });
});
