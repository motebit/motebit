import type {
  SyncConversation,
  SyncConversationMessage,
  ConversationSyncResult,
} from "@motebit/sdk";

// === Conversation Sync Store Adapter ===

/**
 * Adapter interface for conversation sync storage.
 * Abstracts the local conversation store for the sync engine.
 */
export interface ConversationSyncStoreAdapter {
  /** Get conversations updated since a given timestamp. */
  getConversationsSince(motebitId: string, since: number): SyncConversation[];
  /** Get messages for a conversation created since a given timestamp. */
  getMessagesSince(conversationId: string, since: number): SyncConversationMessage[];
  /** Upsert a conversation from sync (last-writer-wins on metadata). */
  upsertConversation(conv: SyncConversation): void;
  /** Upsert a message from sync (append-only, ignore duplicates). */
  upsertMessage(msg: SyncConversationMessage): void;
}

// === Conversation Sync Remote Adapter ===

/**
 * Remote adapter for conversation sync — calls the relay server over HTTP.
 */
export interface ConversationSyncRemoteAdapter {
  pushConversations(motebitId: string, conversations: SyncConversation[]): Promise<number>;
  pullConversations(motebitId: string, since: number): Promise<SyncConversation[]>;
  pushMessages(motebitId: string, messages: SyncConversationMessage[]): Promise<number>;
  pullMessages(motebitId: string, conversationId: string, since: number): Promise<SyncConversationMessage[]>;
}

// === HTTP Conversation Sync Adapter ===

export interface HttpConversationSyncConfig {
  baseUrl: string;
  motebitId: string;
  authToken?: string;
}

/**
 * HTTP adapter that talks to the relay server's conversation sync endpoints.
 */
export class HttpConversationSyncAdapter implements ConversationSyncRemoteAdapter {
  private baseUrl: string;
  private authToken: string | undefined;

  constructor(config: HttpConversationSyncConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.authToken = config.authToken;
  }

  async pushConversations(motebitId: string, conversations: SyncConversation[]): Promise<number> {
    const url = `${this.baseUrl}/sync/${motebitId}/conversations`;
    const res = await fetch(url, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ conversations }),
    });
    if (!res.ok) {
      throw new Error(`Push conversations failed: ${res.status} ${res.statusText}`);
    }
    const body = (await res.json()) as { accepted: number };
    return body.accepted;
  }

  async pullConversations(motebitId: string, since: number): Promise<SyncConversation[]> {
    const url = `${this.baseUrl}/sync/${motebitId}/conversations?since=${since}`;
    const res = await fetch(url, {
      method: "GET",
      headers: this.headers(),
    });
    if (!res.ok) {
      throw new Error(`Pull conversations failed: ${res.status} ${res.statusText}`);
    }
    const body = (await res.json()) as { conversations: SyncConversation[] };
    return body.conversations;
  }

  async pushMessages(motebitId: string, messages: SyncConversationMessage[]): Promise<number> {
    const url = `${this.baseUrl}/sync/${motebitId}/messages`;
    const res = await fetch(url, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ messages }),
    });
    if (!res.ok) {
      throw new Error(`Push messages failed: ${res.status} ${res.statusText}`);
    }
    const body = (await res.json()) as { accepted: number };
    return body.accepted;
  }

  async pullMessages(motebitId: string, conversationId: string, since: number): Promise<SyncConversationMessage[]> {
    const url = `${this.baseUrl}/sync/${motebitId}/messages?conversation_id=${conversationId}&since=${since}`;
    const res = await fetch(url, {
      method: "GET",
      headers: this.headers(),
    });
    if (!res.ok) {
      throw new Error(`Pull messages failed: ${res.status} ${res.statusText}`);
    }
    const body = (await res.json()) as { messages: SyncConversationMessage[] };
    return body.messages;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (this.authToken) {
      h["Authorization"] = `Bearer ${this.authToken}`;
    }
    return h;
  }
}

// === In-Memory Conversation Sync Store (for testing) ===

export class InMemoryConversationSyncStore implements ConversationSyncStoreAdapter {
  conversations: Map<string, SyncConversation> = new Map();
  messages: Map<string, SyncConversationMessage> = new Map();

  getConversationsSince(motebitId: string, since: number): SyncConversation[] {
    return Array.from(this.conversations.values())
      .filter((c) => c.motebit_id === motebitId && c.last_active_at > since)
      .sort((a, b) => a.last_active_at - b.last_active_at);
  }

  getMessagesSince(conversationId: string, since: number): SyncConversationMessage[] {
    return Array.from(this.messages.values())
      .filter((m) => m.conversation_id === conversationId && m.created_at > since)
      .sort((a, b) => a.created_at - b.created_at);
  }

  upsertConversation(conv: SyncConversation): void {
    const existing = this.conversations.get(conv.conversation_id);
    if (!existing) {
      this.conversations.set(conv.conversation_id, { ...conv });
      return;
    }
    // Last-writer-wins on metadata
    if (conv.last_active_at >= existing.last_active_at) {
      this.conversations.set(conv.conversation_id, {
        ...existing,
        last_active_at: conv.last_active_at,
        title: conv.title,
        summary: conv.summary,
        message_count: Math.max(conv.message_count, existing.message_count),
      });
    } else {
      this.conversations.set(conv.conversation_id, {
        ...existing,
        last_active_at: Math.max(conv.last_active_at, existing.last_active_at),
        message_count: Math.max(conv.message_count, existing.message_count),
      });
    }
  }

  upsertMessage(msg: SyncConversationMessage): void {
    // Append-only: ignore duplicates
    if (!this.messages.has(msg.message_id)) {
      this.messages.set(msg.message_id, { ...msg });
    }
  }
}

// === Conversation Sync Engine ===

export interface ConversationSyncConfig {
  /** How often to attempt sync (ms) */
  sync_interval_ms: number;
  /** Retry attempts on failure */
  max_retries: number;
  /** Backoff base (ms) */
  retry_backoff_ms: number;
}

const DEFAULT_CONV_SYNC_CONFIG: ConversationSyncConfig = {
  sync_interval_ms: 30_000,
  max_retries: 3,
  retry_backoff_ms: 1_000,
};

export type ConversationSyncStatus = "idle" | "syncing" | "error" | "offline";

/**
 * Sync engine for conversations. Manages push/pull of conversation metadata
 * and messages between local store and remote relay.
 *
 * Conflict resolution:
 * - Conversation metadata: last-writer-wins (by last_active_at)
 * - Messages: append-only merge (ignore duplicates by message_id)
 */
export class ConversationSyncEngine {
  private config: ConversationSyncConfig;
  private localStore: ConversationSyncStoreAdapter;
  private remoteAdapter: ConversationSyncRemoteAdapter | null = null;
  private motebitId: string;
  private lastSyncTimestamp = 0;
  private status: ConversationSyncStatus = "idle";
  private statusListeners: Set<(status: ConversationSyncStatus) => void> = new Set();
  private syncInterval: ReturnType<typeof setInterval> | null = null;

  constructor(
    localStore: ConversationSyncStoreAdapter,
    motebitId: string,
    config: Partial<ConversationSyncConfig> = {},
  ) {
    this.config = { ...DEFAULT_CONV_SYNC_CONFIG, ...config };
    this.localStore = localStore;
    this.motebitId = motebitId;
  }

  /** Connect to a remote conversation sync adapter. */
  connectRemote(remoteAdapter: ConversationSyncRemoteAdapter): void {
    this.remoteAdapter = remoteAdapter;
  }

  /** Start background sync loop. */
  start(): void {
    if (this.syncInterval !== null) return;
    this.syncInterval = setInterval(() => {
      void this.sync();
    }, this.config.sync_interval_ms);
  }

  /** Stop background sync. */
  stop(): void {
    if (this.syncInterval !== null) {
      clearInterval(this.syncInterval);
      this.syncInterval = null;
    }
  }

  /** Perform a single sync cycle. */
  async sync(): Promise<ConversationSyncResult> {
    if (this.remoteAdapter === null) {
      this.setStatus("offline");
      return { conversations_pushed: 0, conversations_pulled: 0, messages_pushed: 0, messages_pulled: 0 };
    }

    this.setStatus("syncing");

    try {
      // Push local conversations updated since last sync
      const localConversations = this.localStore.getConversationsSince(this.motebitId, this.lastSyncTimestamp);
      let conversationsPushed = 0;
      if (localConversations.length > 0) {
        conversationsPushed = await this.remoteAdapter.pushConversations(this.motebitId, localConversations);
      }

      // Push local messages for those conversations
      let messagesPushed = 0;
      for (const conv of localConversations) {
        const localMessages = this.localStore.getMessagesSince(conv.conversation_id, this.lastSyncTimestamp);
        if (localMessages.length > 0) {
          messagesPushed += await this.remoteAdapter.pushMessages(this.motebitId, localMessages);
        }
      }

      // Pull remote conversations updated since last sync
      const remoteConversations = await this.remoteAdapter.pullConversations(this.motebitId, this.lastSyncTimestamp);
      let conversationsPulled = 0;
      for (const conv of remoteConversations) {
        this.localStore.upsertConversation(conv);
        conversationsPulled++;
      }

      // Pull remote messages for pulled conversations
      let messagesPulled = 0;
      for (const conv of remoteConversations) {
        const remoteMessages = await this.remoteAdapter.pullMessages(
          this.motebitId,
          conv.conversation_id,
          this.lastSyncTimestamp,
        );
        for (const msg of remoteMessages) {
          this.localStore.upsertMessage(msg);
          messagesPulled++;
        }
      }

      this.lastSyncTimestamp = Date.now();
      this.setStatus("idle");

      return {
        conversations_pushed: conversationsPushed,
        conversations_pulled: conversationsPulled,
        messages_pushed: messagesPushed,
        messages_pulled: messagesPulled,
      };
    } catch {
      this.setStatus("error");
      return { conversations_pushed: 0, conversations_pulled: 0, messages_pushed: 0, messages_pulled: 0 };
    }
  }

  /** Subscribe to status changes. */
  onStatusChange(listener: (status: ConversationSyncStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => { this.statusListeners.delete(listener); };
  }

  /** Get current sync status. */
  getStatus(): ConversationSyncStatus {
    return this.status;
  }

  /** Get the last sync timestamp. */
  getLastSyncTimestamp(): number {
    return this.lastSyncTimestamp;
  }

  private setStatus(status: ConversationSyncStatus): void {
    this.status = status;
    for (const listener of this.statusListeners) {
      listener(status);
    }
  }
}
