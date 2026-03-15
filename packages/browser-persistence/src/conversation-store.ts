import type { ConversationStoreAdapter } from "@motebit/sdk";
import { idbRequest } from "./idb.js";

const ACTIVE_CONVERSATION_WINDOW_MS = 4 * 60 * 60 * 1000; // 4 hours

interface ConversationRecord {
  conversationId: string;
  motebitId: string;
  startedAt: number;
  lastActiveAt: number;
  title: string | null;
  summary: string | null;
  messageCount: number;
}

interface MessageRecord {
  messageId: string;
  conversationId: string;
  motebitId: string;
  role: string;
  content: string;
  toolCalls: string | null;
  toolCallId: string | null;
  createdAt: number;
  tokenEstimate: number;
}

export class IdbConversationStore implements ConversationStoreAdapter {
  constructor(private db: IDBDatabase) {}

  createConversation(motebitId: string): string {
    const conversationId = crypto.randomUUID();
    const now = Date.now();
    const record: ConversationRecord = {
      conversationId,
      motebitId,
      startedAt: now,
      lastActiveAt: now,
      title: null,
      summary: null,
      messageCount: 0,
    };
    const tx = this.db.transaction("conversations", "readwrite");
    tx.objectStore("conversations").add(record);
    return conversationId;
  }

  appendMessage(
    conversationId: string,
    motebitId: string,
    msg: {
      role: string;
      content: string;
      toolCalls?: string;
      toolCallId?: string;
    },
  ): void {
    const now = Date.now();
    const messageId = crypto.randomUUID();
    const record: MessageRecord = {
      messageId,
      conversationId,
      motebitId,
      role: msg.role,
      content: msg.content,
      toolCalls: msg.toolCalls ?? null,
      toolCallId: msg.toolCallId ?? null,
      createdAt: now,
      tokenEstimate: Math.ceil(msg.content.length / 4),
    };

    const tx = this.db.transaction(["conversation_messages", "conversations"], "readwrite");
    tx.objectStore("conversation_messages").add(record);

    // Update conversation metadata
    const convStore = tx.objectStore("conversations");
    const getReq = convStore.get(conversationId);
    getReq.onsuccess = () => {
      const conv = getReq.result as ConversationRecord | undefined;
      if (conv) {
        conv.lastActiveAt = now;
        conv.messageCount += 1;
        convStore.put(conv);
      }
    };
  }

  loadMessages(conversationId: string, limit?: number): MessageRecord[] {
    // IDB is async — this adapter uses a preload cache pattern.
    // For browser contexts that need sync access, preload must be called first.
    // For simplicity, return from the sync cache if available.
    const cached = this._messageCache.get(conversationId);
    if (cached) {
      return limit != null ? cached.slice(-limit) : cached;
    }
    return [];
  }

  getActiveConversation(motebitId: string): {
    conversationId: string;
    startedAt: number;
    lastActiveAt: number;
    summary: string | null;
  } | null {
    // Return from preloaded cache
    return this._activeConversationCache.get(motebitId) ?? null;
  }

  updateSummary(conversationId: string, summary: string): void {
    const tx = this.db.transaction("conversations", "readwrite");
    const store = tx.objectStore("conversations");
    const getReq = store.get(conversationId);
    getReq.onsuccess = () => {
      const conv = getReq.result as ConversationRecord | undefined;
      if (conv) {
        conv.summary = summary;
        store.put(conv);
      }
    };
  }

  updateTitle(conversationId: string, title: string): void {
    const tx = this.db.transaction("conversations", "readwrite");
    const store = tx.objectStore("conversations");
    const getReq = store.get(conversationId);
    getReq.onsuccess = () => {
      const conv = getReq.result as ConversationRecord | undefined;
      if (conv) {
        conv.title = title;
        store.put(conv);
      }
    };
  }

  listConversations(
    motebitId: string,
    limit?: number,
  ): Array<{
    conversationId: string;
    startedAt: number;
    lastActiveAt: number;
    title: string | null;
    messageCount: number;
  }> {
    // Return from preloaded cache
    const cached = this._conversationListCache.get(motebitId);
    if (cached) {
      return limit != null ? cached.slice(0, limit) : cached;
    }
    return [];
  }

  deleteConversation(conversationId: string): void {
    const tx = this.db.transaction(["conversations", "conversation_messages"], "readwrite");
    tx.objectStore("conversations").delete(conversationId);
    // Delete all messages for this conversation via index cursor
    const msgStore = tx.objectStore("conversation_messages");
    const index = msgStore.index("conversation_id");
    const req = index.openCursor(conversationId);
    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
      }
    };
    // Invalidate caches
    this._messageCache.delete(conversationId);
    for (const [motebitId, list] of this._conversationListCache) {
      this._conversationListCache.set(
        motebitId,
        list.filter((c) => c.conversationId !== conversationId),
      );
    }
    for (const [motebitId, active] of this._activeConversationCache) {
      if (active.conversationId === conversationId) {
        this._activeConversationCache.delete(motebitId);
      }
    }
  }

  // === Preload / Cache ===

  private _messageCache = new Map<string, MessageRecord[]>();
  private _activeConversationCache = new Map<
    string,
    {
      conversationId: string;
      startedAt: number;
      lastActiveAt: number;
      summary: string | null;
    }
  >();
  private _conversationListCache = new Map<
    string,
    Array<{
      conversationId: string;
      startedAt: number;
      lastActiveAt: number;
      title: string | null;
      messageCount: number;
    }>
  >();

  /** Preload conversation data from IDB into sync caches. Call before runtime construction. */
  async preload(motebitId: string): Promise<void> {
    const tx = this.db.transaction(["conversations", "conversation_messages"], "readonly");
    const convStore = tx.objectStore("conversations");
    const msgStore = tx.objectStore("conversation_messages");

    // Load all conversations for this motebit
    const convIndex = convStore.index("motebit_id");
    const allConvs = (await idbRequest(convIndex.getAll(motebitId))) as ConversationRecord[];

    // Sort by lastActiveAt descending
    allConvs.sort((a, b) => b.lastActiveAt - a.lastActiveAt);

    // Cache conversation list
    this._conversationListCache.set(
      motebitId,
      allConvs.map((c) => ({
        conversationId: c.conversationId,
        startedAt: c.startedAt,
        lastActiveAt: c.lastActiveAt,
        title: c.title,
        messageCount: c.messageCount,
      })),
    );

    // Find active conversation (within 4h window)
    const cutoff = Date.now() - ACTIVE_CONVERSATION_WINDOW_MS;
    const active = allConvs.find((c) => c.lastActiveAt > cutoff);

    if (active) {
      this._activeConversationCache.set(motebitId, {
        conversationId: active.conversationId,
        startedAt: active.startedAt,
        lastActiveAt: active.lastActiveAt,
        summary: active.summary,
      });

      // Load messages for the active conversation
      const msgIndex = msgStore.index("conversation_id");
      const msgs = (await idbRequest(msgIndex.getAll(active.conversationId))) as MessageRecord[];
      msgs.sort((a, b) => a.createdAt - b.createdAt);
      this._messageCache.set(active.conversationId, msgs);
    }
  }
}
