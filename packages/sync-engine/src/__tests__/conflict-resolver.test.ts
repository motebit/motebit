import { describe, it, expect, vi } from "vitest";
import {
  LastWriterWinsResolver,
  AppendOnlyMergeResolver,
  ConflictTracker,
} from "../conflict-resolver.js";
import type { Versioned, ConflictLogger, ConversationWithMessages } from "../conflict-resolver.js";
import type { SyncConversation, SyncConversationMessage } from "@motebit/sdk";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MOTEBIT_ID = "motebit-conflict-test";

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

function makeMessage(
  conversationId: string,
  overrides: Partial<SyncConversationMessage> = {},
): SyncConversationMessage {
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

function versioned<T>(data: T, v: Partial<Versioned> = {}): T & Versioned {
  return {
    ...data,
    version: v.version ?? 1,
    timestamp: v.timestamp ?? Date.now(),
    device_id: v.device_id ?? "device-a",
  };
}

// ---------------------------------------------------------------------------
// LastWriterWinsResolver
// ---------------------------------------------------------------------------

describe("LastWriterWinsResolver", () => {
  const resolver = new LastWriterWinsResolver<{ value: string }>();

  it("returns local_wins when identical", () => {
    const data = { value: "same" };
    const v: Versioned = { version: 1, timestamp: 1000, device_id: "d1" };
    const result = resolver.resolve({ ...data, ...v }, { ...data, ...v });

    expect(result.strategy).toBe("local_wins");
    expect(result.conflicted).toBe(false);
    expect(result.resolved.value).toBe("same");
  });

  it("higher version wins", () => {
    const local = versioned({ value: "local" }, { version: 2, timestamp: 1000, device_id: "d1" });
    const remote = versioned({ value: "remote" }, { version: 5, timestamp: 900, device_id: "d2" });
    const result = resolver.resolve(local, remote);

    expect(result.strategy).toBe("remote_wins");
    expect(result.conflicted).toBe(true);
    expect(result.resolved.value).toBe("remote");
  });

  it("local higher version wins", () => {
    const local = versioned({ value: "local" }, { version: 10, timestamp: 1000, device_id: "d1" });
    const remote = versioned({ value: "remote" }, { version: 3, timestamp: 2000, device_id: "d2" });
    const result = resolver.resolve(local, remote);

    expect(result.strategy).toBe("local_wins");
    expect(result.conflicted).toBe(true);
    expect(result.resolved.value).toBe("local");
  });

  it("equal version, later timestamp wins", () => {
    const local = versioned({ value: "local" }, { version: 5, timestamp: 2000, device_id: "d1" });
    const remote = versioned({ value: "remote" }, { version: 5, timestamp: 1000, device_id: "d2" });
    const result = resolver.resolve(local, remote);

    expect(result.strategy).toBe("local_wins");
    expect(result.conflicted).toBe(false); // same version = no divergence
    expect(result.resolved.value).toBe("local");
  });

  it("equal version and timestamp, lexicographically greater device_id wins", () => {
    const local = versioned(
      { value: "local" },
      { version: 5, timestamp: 1000, device_id: "device-b" },
    );
    const remote = versioned(
      { value: "remote" },
      { version: 5, timestamp: 1000, device_id: "device-a" },
    );
    const result = resolver.resolve(local, remote);

    expect(result.strategy).toBe("local_wins");
    expect(result.resolved.value).toBe("local");
  });

  it("equal version and timestamp, remote wins when it has greater device_id", () => {
    const local = versioned(
      { value: "local" },
      { version: 5, timestamp: 1000, device_id: "device-a" },
    );
    const remote = versioned(
      { value: "remote" },
      { version: 5, timestamp: 1000, device_id: "device-z" },
    );
    const result = resolver.resolve(local, remote);

    expect(result.strategy).toBe("remote_wins");
    expect(result.resolved.value).toBe("remote");
  });

  it("strips versioned metadata from resolved value", () => {
    const local = versioned({ value: "local" }, { version: 2, timestamp: 1000, device_id: "d1" });
    const remote = versioned({ value: "remote" }, { version: 1, timestamp: 900, device_id: "d2" });
    const result = resolver.resolve(local, remote);

    expect(result.resolved).toEqual({ value: "local" });
    expect("version" in result.resolved).toBe(false);
    expect("timestamp" in result.resolved).toBe(false);
    expect("device_id" in result.resolved).toBe(false);
  });

  it("works with complex objects (SyncConversation shape)", () => {
    const resolver = new LastWriterWinsResolver<SyncConversation>();
    const convId = "conv-lww";

    const local = versioned(
      makeConversation({ conversation_id: convId, title: "Local title", last_active_at: 2000 }),
      { version: 3, timestamp: 2000, device_id: "desktop" },
    );
    const remote = versioned(
      makeConversation({ conversation_id: convId, title: "Remote title", last_active_at: 1500 }),
      { version: 5, timestamp: 1500, device_id: "mobile" },
    );

    const result = resolver.resolve(local, remote);
    expect(result.strategy).toBe("remote_wins");
    expect(result.resolved.title).toBe("Remote title");
    expect(result.conflicted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AppendOnlyMergeResolver
// ---------------------------------------------------------------------------

describe("AppendOnlyMergeResolver", () => {
  const resolver = new AppendOnlyMergeResolver();

  it("merges disjoint message sets", () => {
    const convId = "conv-merge";
    const conv = makeConversation({ conversation_id: convId });

    const msgA = makeMessage(convId, { message_id: "msg-a", created_at: 1000, content: "A" });
    const msgB = makeMessage(convId, { message_id: "msg-b", created_at: 2000, content: "B" });

    const local: ConversationWithMessages & Versioned = {
      conversation: conv,
      messages: [msgA],
      version: 1,
      timestamp: 1000,
      device_id: "device-a",
    };
    const remote: ConversationWithMessages & Versioned = {
      conversation: conv,
      messages: [msgB],
      version: 1,
      timestamp: 2000,
      device_id: "device-b",
    };

    const result = resolver.resolve(local, remote);
    expect(result.strategy).toBe("merge");
    expect(result.conflicted).toBe(true);
    expect(result.resolved.messages).toHaveLength(2);
    expect(result.resolved.messages[0]!.message_id).toBe("msg-a");
    expect(result.resolved.messages[1]!.message_id).toBe("msg-b");
    expect(result.resolved.conversation.message_count).toBe(2);
  });

  it("deduplicates messages by message_id", () => {
    const convId = "conv-dedup";
    const conv = makeConversation({ conversation_id: convId });
    const sharedMsg = makeMessage(convId, { message_id: "msg-shared", created_at: 1000 });

    const local: ConversationWithMessages & Versioned = {
      conversation: conv,
      messages: [sharedMsg],
      version: 1,
      timestamp: 1000,
      device_id: "device-a",
    };
    const remote: ConversationWithMessages & Versioned = {
      conversation: conv,
      messages: [sharedMsg],
      version: 1,
      timestamp: 1000,
      device_id: "device-b",
    };

    const result = resolver.resolve(local, remote);
    expect(result.resolved.messages).toHaveLength(1);
    expect(result.strategy).not.toBe("merge"); // no unique messages from either side
    expect(result.resolved.conversation.message_count).toBe(1);
  });

  it("sorts messages by created_at, then message_id", () => {
    const convId = "conv-sort";
    const conv = makeConversation({ conversation_id: convId });

    // Same timestamp, different IDs
    const msgA = makeMessage(convId, { message_id: "msg-b", created_at: 1000, content: "B" });
    const msgB = makeMessage(convId, { message_id: "msg-a", created_at: 1000, content: "A" });

    const local: ConversationWithMessages & Versioned = {
      conversation: conv,
      messages: [msgA],
      version: 1,
      timestamp: 1000,
      device_id: "device-a",
    };
    const remote: ConversationWithMessages & Versioned = {
      conversation: conv,
      messages: [msgB],
      version: 1,
      timestamp: 1000,
      device_id: "device-b",
    };

    const result = resolver.resolve(local, remote);
    expect(result.resolved.messages[0]!.message_id).toBe("msg-a");
    expect(result.resolved.messages[1]!.message_id).toBe("msg-b");
  });

  it("uses LWW for conversation metadata", () => {
    const convId = "conv-meta";
    const localConv = makeConversation({
      conversation_id: convId,
      title: "Local",
      last_active_at: 1000,
    });
    const remoteConv = makeConversation({
      conversation_id: convId,
      title: "Remote",
      last_active_at: 2000,
    });

    const local: ConversationWithMessages & Versioned = {
      conversation: localConv,
      messages: [],
      version: 1,
      timestamp: 1000,
      device_id: "device-a",
    };
    const remote: ConversationWithMessages & Versioned = {
      conversation: remoteConv,
      messages: [],
      version: 3,
      timestamp: 2000,
      device_id: "device-b",
    };

    const result = resolver.resolve(local, remote);
    expect(result.resolved.conversation.title).toBe("Remote");
  });

  it("reports non-merge when only one side has unique messages", () => {
    const convId = "conv-one-side";
    const conv = makeConversation({ conversation_id: convId });
    const shared = makeMessage(convId, { message_id: "shared", created_at: 1000 });
    const extra = makeMessage(convId, { message_id: "extra", created_at: 2000 });

    const local: ConversationWithMessages & Versioned = {
      conversation: conv,
      messages: [shared],
      version: 1,
      timestamp: 1000,
      device_id: "device-a",
    };
    const remote: ConversationWithMessages & Versioned = {
      conversation: conv,
      messages: [shared, extra],
      version: 2,
      timestamp: 2000,
      device_id: "device-b",
    };

    const result = resolver.resolve(local, remote);
    // Only remote has unique messages, not both sides
    expect(result.strategy).not.toBe("merge");
    expect(result.resolved.messages).toHaveLength(2);
  });

  it("handles empty message arrays", () => {
    const convId = "conv-empty";
    const conv = makeConversation({ conversation_id: convId });

    const local: ConversationWithMessages & Versioned = {
      conversation: conv,
      messages: [],
      version: 1,
      timestamp: 1000,
      device_id: "device-a",
    };
    const remote: ConversationWithMessages & Versioned = {
      conversation: conv,
      messages: [],
      version: 1,
      timestamp: 1000,
      device_id: "device-b",
    };

    const result = resolver.resolve(local, remote);
    expect(result.resolved.messages).toHaveLength(0);
    expect(result.resolved.conversation.message_count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// ConflictTracker
// ---------------------------------------------------------------------------

describe("ConflictTracker", () => {
  it("records and retrieves conflict events", () => {
    const tracker = new ConflictTracker({ logger: { warn: vi.fn() } });

    const event = tracker.record({
      data_type: "conversation",
      strategy: "remote_wins",
      conflicted: true,
      local_version: 3,
      remote_version: 5,
      local_device_id: "desktop",
      remote_device_id: "mobile",
    });

    expect(event.conflict_id).toBeDefined();
    expect(event.resolved_at).toBeGreaterThan(0);

    const events = tracker.getEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toBe(event);
  });

  it("getLastConflict returns the most recent event", () => {
    const tracker = new ConflictTracker({ logger: { warn: vi.fn() } });

    tracker.record({
      data_type: "conversation",
      strategy: "local_wins",
      conflicted: true,
      local_version: 1,
      remote_version: 2,
      local_device_id: "d1",
      remote_device_id: "d2",
    });
    const second = tracker.record({
      data_type: "plan",
      strategy: "remote_wins",
      conflicted: true,
      local_version: 3,
      remote_version: 4,
      local_device_id: "d1",
      remote_device_id: "d2",
    });

    expect(tracker.getLastConflict()).toBe(second);
  });

  it("getLastConflict returns null when empty", () => {
    const tracker = new ConflictTracker();
    expect(tracker.getLastConflict()).toBeNull();
  });

  it("logs warnings for conflicted events", () => {
    const mockLogger: ConflictLogger = { warn: vi.fn() };
    const tracker = new ConflictTracker({ logger: mockLogger });

    tracker.record({
      data_type: "conversation",
      strategy: "remote_wins",
      conflicted: true,
      local_version: 1,
      remote_version: 2,
      local_device_id: "d1",
      remote_device_id: "d2",
    });

    expect(mockLogger.warn).toHaveBeenCalledTimes(1);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      "sync conflict resolved",
      expect.objectContaining({ data_type: "conversation", strategy: "remote_wins" }),
    );
  });

  it("does not log for non-conflicted events", () => {
    const mockLogger: ConflictLogger = { warn: vi.fn() };
    const tracker = new ConflictTracker({ logger: mockLogger });

    tracker.record({
      data_type: "conversation",
      strategy: "local_wins",
      conflicted: false,
      local_version: 1,
      remote_version: 1,
      local_device_id: "d1",
      remote_device_id: "d1",
    });

    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  it("evicts oldest events when maxEvents exceeded", () => {
    const tracker = new ConflictTracker({ maxEvents: 3, logger: { warn: vi.fn() } });

    for (let i = 0; i < 5; i++) {
      tracker.record({
        data_type: `type-${i}`,
        strategy: "local_wins",
        conflicted: true,
        local_version: i,
        remote_version: i + 1,
        local_device_id: "d1",
        remote_device_id: "d2",
      });
    }

    const events = tracker.getEvents();
    expect(events).toHaveLength(3);
    expect(events[0]!.data_type).toBe("type-2");
    expect(events[2]!.data_type).toBe("type-4");
  });

  it("clear removes all events", () => {
    const tracker = new ConflictTracker({ logger: { warn: vi.fn() } });

    tracker.record({
      data_type: "conversation",
      strategy: "local_wins",
      conflicted: true,
      local_version: 1,
      remote_version: 2,
      local_device_id: "d1",
      remote_device_id: "d2",
    });

    tracker.clear();
    expect(tracker.getEvents()).toHaveLength(0);
    expect(tracker.getLastConflict()).toBeNull();
  });
});
