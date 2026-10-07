/**
 * Conversation manager — owns the desktop's conversation browsing,
 * loading, and summarization logic.
 *
 * Conversations are the visible thread of interaction — the body of
 * each exchange the user has had with the motebit. The manager wraps the
 * TauriConversationStore with the product-level semantics the desktop UI
 * needs: "show me recent threads", "load this one", "summarize this one".
 *
 * Auto-titling is not the desktop's concern — `@motebit/runtime` fires
 * `autoTitle` from `pushExchange` internally, so every surface gets
 * identical behavior without inline orchestration.
 *
 * ### Deps getter pattern
 *
 * Runtime and conversation store are both nullable until after `initAI`
 * has completed. Read lazily via getter closures so DesktopApp never has
 * to re-bind the manager.
 */

import { readDerivedText } from "@motebit/ai-core";
import type { MotebitRuntime } from "@motebit/runtime";
import type { TauriConversationStore } from "./tauri-storage.js";

export interface ConversationSummary {
  conversationId: string;
  startedAt: number;
  lastActiveAt: number;
  title: string | null;
  summary: string | null;
  messageCount: number;
}

export interface ConversationManagerDeps {
  getRuntime: () => MotebitRuntime | null;
  getMotebitId: () => string;
  getConversationStore: () => TauriConversationStore | null;
}

export class ConversationManager {
  constructor(private deps: ConversationManagerDeps) {}

  /** List recent conversations (async, for UI). Returns empty array if no conversation store. */
  async listConversationsAsync(limit = 20): Promise<ConversationSummary[]> {
    const store = this.deps.getConversationStore();
    if (!store) return [];
    return store.listConversationsAsync(this.deps.getMotebitId(), limit);
  }

  /** Load a past conversation by ID — replaces the current chat. Returns the message list. */
  async loadConversationById(
    conversationId: string,
  ): Promise<Array<{ role: string; content: string }>> {
    const runtime = this.deps.getRuntime();
    const store = this.deps.getConversationStore();
    if (!runtime || !store) return [];

    // Load messages asynchronously into the cache
    await store.loadMessagesAsync(conversationId);

    // Now the sync loadMessages() call inside runtime will work from cache
    runtime.loadConversation(conversationId);

    return runtime.getConversationHistory();
  }

  /** Start a new conversation (clears current). */
  startNewConversation(): void {
    this.deps.getRuntime()?.resetConversation();
  }

  /** Get the current conversation ID. */
  getCurrentConversationId(): string | null {
    return this.deps.getRuntime()?.getConversationId() ?? null;
  }

  /**
   * Get the summary for a specific conversation by ID, for display.
   * Returns null if no summary exists or conversation store is unavailable.
   * The stored summary carries its sensitivity stamp; display reads the
   * text only.
   */
  async getConversationSummary(conversationId: string): Promise<string | null> {
    const store = this.deps.getConversationStore();
    if (!store) return null;
    const conversations = await store.listConversationsAsync(this.deps.getMotebitId(), 100);
    const conv = conversations.find((c) => c.conversationId === conversationId);
    return conv?.summary != null ? readDerivedText(conv.summary).text : null;
  }

  /**
   * Manually trigger summarization of the current conversation. Routes
   * through the runtime, which sends only the tier-filtered history and
   * stored summary and persists the result with its sensitivity stamp —
   * never the raw history through a side-channel completion.
   * Returns the generated summary, or null if there's nothing to summarize.
   */
  async summarizeConversation(): Promise<string | null> {
    const runtime = this.deps.getRuntime();
    if (!runtime) return null;
    return runtime.summarizeCurrentConversation();
  }
}
