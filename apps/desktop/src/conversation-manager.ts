/**
 * Conversation manager — owns the desktop's conversation browsing,
 * loading, summarization, and auto-titling logic.
 *
 * Extracted from DesktopApp as Target 6 of the desktop extraction plan
 * (8 targets total). Conversations are the visible thread of interaction — the body of
 * each exchange the user has had with the motebit. The manager wraps the
 * TauriConversationStore with the product-level semantics the desktop UI
 * needs: "show me recent threads", "load this one", "name this one",
 * "summarize this one".
 *
 * ### State ownership
 *
 *   - `_autoTitlePending` — guard flag that prevents overlapping auto-title
 *     jobs. Auto-titling runs in the background whenever a conversation
 *     crosses 4 messages and doesn't yet have a title. If a second
 *     `generateTitleInBackground` call arrives while one is in flight,
 *     the second becomes a no-op to avoid duplicate AI calls.
 *
 * ### Deps getter pattern
 *
 * Runtime and conversation store are both nullable until after `initAI`
 * has completed. Read lazily via getter closures so DesktopApp never has
 * to re-bind the manager.
 */

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
  private _autoTitlePending = false;

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
   * Get the summary for a specific conversation by ID.
   * Returns null if no summary exists or conversation store is unavailable.
   */
  async getConversationSummary(conversationId: string): Promise<string | null> {
    const store = this.deps.getConversationStore();
    if (!store) return null;
    const conversations = await store.listConversationsAsync(this.deps.getMotebitId(), 100);
    const conv = conversations.find((c) => c.conversationId === conversationId);
    return conv?.summary ?? null;
  }

  /**
   * Manually trigger summarization of the current conversation.
   * Uses the AI provider via a side-channel call (no conversation pollution).
   * Returns the generated summary, or null if there's nothing to summarize.
   */
  async summarizeConversation(): Promise<string | null> {
    const runtime = this.deps.getRuntime();
    const store = this.deps.getConversationStore();
    if (!runtime || !store) return null;

    const conversationId = runtime.getConversationId();
    if (conversationId == null || conversationId === "") return null;

    const history = runtime.getConversationHistory();
    if (history.length < 2) return null;

    // Get existing summary if any
    const existingSummary = await this.getConversationSummary(conversationId);

    // Use the ai-core summarizeConversation via generateCompletion (side-channel)
    const formatted = history.map((m) => `${m.role}: ${m.content}`).join("\n");

    const prompt =
      existingSummary != null && existingSummary !== ""
        ? `Update this conversation summary with the new messages.\n\nExisting summary:\n${existingSummary}\n\nNew messages:\n${formatted}\n\nReturn ONLY the updated summary (2-4 sentences). No quotes, no explanation.`
        : `Summarize this conversation in 2-4 concise sentences. Return ONLY the summary, no quotes, no explanation.\n\n${formatted}`;

    const summary = await runtime.generateCompletion(prompt);
    const cleaned = summary.trim();

    if (cleaned.length > 0) {
      store.updateSummary(conversationId, cleaned);
      return cleaned;
    }

    return null;
  }

  /**
   * Generate a title for the current conversation when it reaches 4+ messages.
   * Uses the AI provider to produce a short (5-7 word) title from the first messages.
   * Non-blocking, fires in the background.
   */
  async maybeAutoTitle(): Promise<string | null> {
    const runtime = this.deps.getRuntime();
    const store = this.deps.getConversationStore();
    if (!runtime || !store || this._autoTitlePending) return null;

    const conversationId = runtime.getConversationId();
    if (conversationId == null || conversationId === "") return null;

    const history = runtime.getConversationHistory();
    if (history.length < 4) return null;

    // Check if already titled
    const convos = await store.listConversationsAsync(this.deps.getMotebitId(), 50);
    const current = convos.find((c) => c.conversationId === conversationId);
    if (current?.title != null && current.title !== "") return current.title;

    this._autoTitlePending = true;

    try {
      // Use a focused prompt to generate a short title
      const firstMessages = history
        .slice(0, 6)
        .map((m) => `${m.role}: ${m.content.slice(0, 200)}`)
        .join("\n");
      const titlePrompt = `Generate a very short title (5-7 words max) for this conversation. Return ONLY the title, no quotes, no explanation.\n\n${firstMessages}`;

      const result = await runtime.sendMessage(titlePrompt);
      const title = result.response
        .trim()
        .replace(/^["']|["']$/g, "")
        .slice(0, 100);

      if (title && title.length > 0 && title.length < 100) {
        store.updateTitle(conversationId, title);
        return title;
      }
    } catch {
      // Auto-titling is best-effort
    } finally {
      this._autoTitlePending = false;
    }

    return null;
  }

  /**
   * Generate a title using a lightweight AI call that doesn't affect conversation history.
   * Uses runtime.generateCompletion() (side-channel) so the title prompt never enters
   * the conversation. Falls back to heuristic (first 7 words) if the AI call fails.
   * Called after pushToHistory when message count crosses 4.
   */
  async generateTitleInBackground(): Promise<string | null> {
    const runtime = this.deps.getRuntime();
    const store = this.deps.getConversationStore();
    if (!runtime || !store) return null;

    const conversationId = runtime.getConversationId();
    if (conversationId == null || conversationId === "") return null;

    // Check message count
    const count = await store.getMessageCount(conversationId);
    if (count < 4) return null;

    // Check if already titled
    const convos = await store.listConversationsAsync(this.deps.getMotebitId(), 50);
    const current = convos.find((c) => c.conversationId === conversationId);
    if (current?.title != null && current.title !== "") return null; // Already has a title

    if (this._autoTitlePending) return null;
    this._autoTitlePending = true;

    try {
      const history = runtime.getConversationHistory();
      const firstMessages = history
        .slice(0, 6)
        .map((m) => `${m.role}: ${m.content.slice(0, 200)}`)
        .join("\n");

      // Try AI-generated title via side-channel (no conversation pollution)
      try {
        const prompt = `Generate a very short title (5-7 words max) for this conversation. Return ONLY the title, no quotes, no explanation.\n\n${firstMessages}`;
        const raw = await runtime.generateCompletion(prompt);
        const title = raw
          .trim()
          .replace(/^["']|["']$/g, "")
          .slice(0, 100);
        if (title.length > 0 && title.length < 100) {
          store.updateTitle(conversationId, title);
          return title;
        }
      } catch {
        // AI title generation failed — fall through to heuristic
      }

      // Heuristic fallback: first 7 words of first user message
      const firstUserMsg = history.find((m) => m.role === "user");
      if (firstUserMsg) {
        const words = firstUserMsg.content.split(/\s+/);
        let title = words.slice(0, 7).join(" ");
        if (words.length > 7) title += "...";
        if (title.length > 0) {
          store.updateTitle(conversationId, title);
          return title;
        }
      }
    } catch {
      // Best-effort
    } finally {
      this._autoTitlePending = false;
    }

    return null;
  }
}
