import type { SyncConversation, SyncConversationMessage } from "@motebit/sdk";
import type { IdbConversationStore } from "./conversation-store.js";

/**
 * IDB-backed conversation sync store adapter.
 * Bridges IdbConversationStore to the ConversationSyncEngine's sync interface.
 *
 * Uses the IdbConversationStore's in-memory cache for reads (preloaded at bootstrap).
 * Write-through to IDB on upserts.
 *
 * Duck-typed to match ConversationSyncStoreAdapter from @motebit/sync-engine
 * (browser-persistence doesn't depend on sync-engine).
 */
export class IdbConversationSyncStore {
  constructor(
    private convStore: IdbConversationStore,
    private motebitId: string,
  ) {}

  getConversationsSince(_motebitId: string, since: number): SyncConversation[] {
    const all = this.convStore.listConversations(this.motebitId);
    return all
      .filter((c) => c.lastActiveAt > since)
      .map((c) => ({
        conversation_id: c.conversationId as SyncConversation["conversation_id"],
        motebit_id: this.motebitId as SyncConversation["motebit_id"],
        started_at: c.startedAt,
        last_active_at: c.lastActiveAt,
        title: c.title,
        summary: null, // listConversations doesn't return summary
        message_count: c.messageCount,
      }));
  }

  getMessagesSince(conversationId: string, since: number): SyncConversationMessage[] {
    const msgs = this.convStore.loadMessages(conversationId);
    return msgs
      .filter((m) => m.createdAt > since)
      .map((m) => ({
        message_id: m.messageId,
        conversation_id: m.conversationId as SyncConversationMessage["conversation_id"],
        motebit_id: m.motebitId as SyncConversationMessage["motebit_id"],
        role: m.role,
        content: m.content,
        tool_calls: m.toolCalls,
        tool_call_id: m.toolCallId,
        created_at: m.createdAt,
        token_estimate: m.tokenEstimate,
      }));
  }

  upsertConversation(conv: SyncConversation): void {
    this.convStore.upsertSyncConversation(conv);
  }

  upsertMessage(msg: SyncConversationMessage): void {
    this.convStore.upsertSyncMessage(msg);
  }
}
