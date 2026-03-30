/**
 * Tests for EncryptedConversationSyncAdapter — field-level encryption
 * for conversation sync at the relay boundary.
 */
import { describe, it, expect, beforeEach } from "vitest";
import type {
  SyncConversation,
  SyncConversationMessage,
  MotebitId,
  ConversationId,
} from "@motebit/sdk";
import {
  EncryptedConversationSyncAdapter,
  decryptConversationMessage,
  decryptSyncConversation,
} from "../encrypted-conversation-adapter.js";
import type { ConversationSyncRemoteAdapter } from "../conversation-sync.js";

// Deterministic 256-bit test key
const TEST_KEY = new Uint8Array(32);
for (let i = 0; i < 32; i++) TEST_KEY[i] = i;

const MOTEBIT_ID = "test-agent-001" as MotebitId;
const CONV_ID = "conv-001" as ConversationId;

/** In-memory remote adapter that captures what gets pushed (the encrypted data). */
class CapturingRemoteAdapter implements ConversationSyncRemoteAdapter {
  pushedConversations: SyncConversation[] = [];
  pushedMessages: SyncConversationMessage[] = [];
  pullableConversations: SyncConversation[] = [];
  pullableMessages: SyncConversationMessage[] = [];

  async pushConversations(_motebitId: string, conversations: SyncConversation[]): Promise<number> {
    this.pushedConversations.push(...conversations);
    return conversations.length;
  }

  async pullConversations(_motebitId: string, _since: number): Promise<SyncConversation[]> {
    return this.pullableConversations;
  }

  async pushMessages(_motebitId: string, messages: SyncConversationMessage[]): Promise<number> {
    this.pushedMessages.push(...messages);
    return messages.length;
  }

  async pullMessages(
    _motebitId: string,
    _conversationId: string,
    _since: number,
  ): Promise<SyncConversationMessage[]> {
    return this.pullableMessages;
  }
}

function makeConversation(title: string | null, summary: string | null): SyncConversation {
  return {
    conversation_id: CONV_ID,
    motebit_id: MOTEBIT_ID,
    started_at: 1000,
    last_active_at: 2000,
    title,
    summary,
    message_count: 1,
  };
}

function makeMessage(content: string, toolCalls: string | null = null): SyncConversationMessage {
  return {
    message_id: "msg-001",
    conversation_id: CONV_ID,
    motebit_id: MOTEBIT_ID,
    role: "user",
    content,
    tool_calls: toolCalls,
    tool_call_id: null,
    created_at: 1500,
    token_estimate: 10,
  };
}

describe("EncryptedConversationSyncAdapter", () => {
  let inner: CapturingRemoteAdapter;
  let adapter: EncryptedConversationSyncAdapter;

  beforeEach(() => {
    inner = new CapturingRemoteAdapter();
    adapter = new EncryptedConversationSyncAdapter({ inner, key: TEST_KEY });
  });

  // ── Push encryption ───────────────────────────────────────────────

  describe("pushConversations", () => {
    it("encrypts title and summary", async () => {
      const conv = makeConversation("My medical appointment", "Discussed blood work results");
      await adapter.pushConversations(MOTEBIT_ID, [conv]);

      expect(inner.pushedConversations).toHaveLength(1);
      const pushed = inner.pushedConversations[0]!;

      // Title and summary should be encrypted (not readable)
      expect(pushed.title).not.toBe("My medical appointment");
      expect(pushed.summary).not.toBe("Discussed blood work results");
      expect(pushed.title).toContain("\0ENC:");
      expect(pushed.summary).toContain("\0ENC:");

      // Metadata stays in cleartext (relay needs it for indexing)
      expect(pushed.conversation_id).toBe(CONV_ID);
      expect(pushed.motebit_id).toBe(MOTEBIT_ID);
      expect(pushed.started_at).toBe(1000);
      expect(pushed.last_active_at).toBe(2000);
      expect(pushed.message_count).toBe(1);
    });

    it("passes through null title/summary", async () => {
      const conv = makeConversation(null, null);
      await adapter.pushConversations(MOTEBIT_ID, [conv]);

      const pushed = inner.pushedConversations[0]!;
      expect(pushed.title).toBeNull();
      expect(pushed.summary).toBeNull();
    });
  });

  describe("pushMessages", () => {
    it("encrypts content and tool_calls", async () => {
      const msg = makeMessage("What are my blood test results?", '{"name":"lookup"}');
      await adapter.pushMessages(MOTEBIT_ID, [msg]);

      expect(inner.pushedMessages).toHaveLength(1);
      const pushed = inner.pushedMessages[0]!;

      expect(pushed.content).not.toBe("What are my blood test results?");
      expect(pushed.content).toContain("\0ENC:");
      expect(pushed.tool_calls).not.toBe('{"name":"lookup"}');
      expect(pushed.tool_calls).toContain("\0ENC:");

      // Metadata in cleartext
      expect(pushed.message_id).toBe("msg-001");
      expect(pushed.role).toBe("user");
      expect(pushed.created_at).toBe(1500);
    });

    it("passes through null tool_calls", async () => {
      const msg = makeMessage("hello", null);
      await adapter.pushMessages(MOTEBIT_ID, [msg]);

      const pushed = inner.pushedMessages[0]!;
      expect(pushed.tool_calls).toBeNull();
    });
  });

  // ── Pull decryption ───────────────────────────────────────────────

  describe("pullConversations — round-trip", () => {
    it("decrypts what was encrypted", async () => {
      const original = makeConversation("Secret meeting notes", "Discussed acquisition");
      await adapter.pushConversations(MOTEBIT_ID, [original]);

      // Simulate relay returning the encrypted data
      inner.pullableConversations = [...inner.pushedConversations];
      const pulled = await adapter.pullConversations(MOTEBIT_ID, 0);

      expect(pulled).toHaveLength(1);
      expect(pulled[0]!.title).toBe("Secret meeting notes");
      expect(pulled[0]!.summary).toBe("Discussed acquisition");
    });

    it("passes through unencrypted conversations (backward compat)", async () => {
      inner.pullableConversations = [makeConversation("Plain title", "Plain summary")];
      const pulled = await adapter.pullConversations(MOTEBIT_ID, 0);

      expect(pulled[0]!.title).toBe("Plain title");
      expect(pulled[0]!.summary).toBe("Plain summary");
    });
  });

  describe("pullMessages — round-trip", () => {
    it("decrypts what was encrypted", async () => {
      const original = makeMessage("My SSN is 123-45-6789", '{"tool":"sensitive"}');
      await adapter.pushMessages(MOTEBIT_ID, [original]);

      inner.pullableMessages = [...inner.pushedMessages];
      const pulled = await adapter.pullMessages(MOTEBIT_ID, CONV_ID, 0);

      expect(pulled).toHaveLength(1);
      expect(pulled[0]!.content).toBe("My SSN is 123-45-6789");
      expect(pulled[0]!.tool_calls).toBe('{"tool":"sensitive"}');
    });

    it("passes through unencrypted messages (backward compat)", async () => {
      inner.pullableMessages = [makeMessage("Plain text", null)];
      const pulled = await adapter.pullMessages(MOTEBIT_ID, CONV_ID, 0);

      expect(pulled[0]!.content).toBe("Plain text");
    });
  });

  // ── Different keys cannot decrypt ─────────────────────────────────

  it("wrong key cannot decrypt", async () => {
    const msg = makeMessage("secret content");
    await adapter.pushMessages(MOTEBIT_ID, [msg]);

    const wrongKey = new Uint8Array(32);
    wrongKey.fill(0xff);
    const wrongAdapter = new EncryptedConversationSyncAdapter({ inner, key: wrongKey });

    inner.pullableMessages = [...inner.pushedMessages];
    await expect(wrongAdapter.pullMessages(MOTEBIT_ID, CONV_ID, 0)).rejects.toThrow();
  });
});

// ── Standalone decryption helpers (for WebSocket messages) ──────────

describe("decryptConversationMessage", () => {
  it("decrypts an encrypted message", async () => {
    const inner = new CapturingRemoteAdapter();
    const adapter = new EncryptedConversationSyncAdapter({ inner, key: TEST_KEY });
    const original = makeMessage("Confidential data");
    await adapter.pushMessages(MOTEBIT_ID, [original]);

    const encrypted = inner.pushedMessages[0]!;
    const decrypted = await decryptConversationMessage(encrypted, TEST_KEY);
    expect(decrypted.content).toBe("Confidential data");
  });

  it("passes through unencrypted messages", async () => {
    const plain = makeMessage("Not encrypted");
    const result = await decryptConversationMessage(plain, TEST_KEY);
    expect(result.content).toBe("Not encrypted");
  });
});

describe("decryptSyncConversation", () => {
  it("decrypts an encrypted conversation", async () => {
    const inner = new CapturingRemoteAdapter();
    const adapter = new EncryptedConversationSyncAdapter({ inner, key: TEST_KEY });
    const original = makeConversation("Secret Title", "Secret Summary");
    await adapter.pushConversations(MOTEBIT_ID, [original]);

    const encrypted = inner.pushedConversations[0]!;
    const decrypted = await decryptSyncConversation(encrypted, TEST_KEY);
    expect(decrypted.title).toBe("Secret Title");
    expect(decrypted.summary).toBe("Secret Summary");
  });
});
