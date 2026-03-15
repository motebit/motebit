/**
 * Conversation lifecycle management — history, persistence, trimming,
 * summarization, auto-titling.
 *
 * Extracted from MotebitRuntime to keep the orchestrator focused on
 * wiring rather than conversation bookkeeping.
 */

import type { ConversationMessage, ConversationStoreAdapter } from "@motebit/sdk";
import type { StreamingProvider, ContextBudget, TaskType } from "@motebit/ai-core";
import { trimConversation, summarizeConversation, shouldSummarize } from "@motebit/ai-core";
import type { TaskRouter } from "@motebit/ai-core";

/** Dependencies injected by the runtime. */
export interface ConversationDeps {
  motebitId: string;
  maxHistory: number;
  summarizeAfterMessages: number;
  store: ConversationStoreAdapter | null;
  /** Resolve current AI provider (may change over lifetime). */
  getProvider(): StreamingProvider | null;
  /** Resolve current task router (may change over lifetime). */
  getTaskRouter(): TaskRouter | null;
  /** Generate a plain text completion for titling. */
  generateCompletion(prompt: string, taskType?: TaskType): Promise<string>;
}

/** Default context window budget — conservative to fit most models. */
const CONVERSATION_BUDGET: ContextBudget = {
  maxTokens: 8000,
  reserveForResponse: 1024,
};

export class ConversationManager {
  private history: ConversationMessage[] = [];
  private currentId: string | null = null;
  private sessionInfo: { continued: boolean; lastActiveAt: number } | null = null;

  constructor(private readonly deps: ConversationDeps) {}

  // --- Bootstrap ---

  /** Resume active conversation from store (called once at startup). */
  resumeActiveConversation(): void {
    const { store } = this.deps;
    if (!store) return;
    const active = store.getActiveConversation(this.deps.motebitId);
    if (!active) return;

    this.currentId = active.conversationId;
    const messages = store.loadMessages(active.conversationId);
    for (const msg of messages) {
      if (msg.role === "user" || msg.role === "assistant") {
        this.history.push({ role: msg.role, content: msg.content });
      }
    }
    if (this.history.length > 0) {
      this.sessionInfo = { continued: true, lastActiveAt: active.lastActiveAt };
    }
  }

  // --- Accessors ---

  getHistory(): ConversationMessage[] {
    return [...this.history];
  }

  getId(): string | null {
    return this.currentId;
  }

  getSessionInfo(): { continued: boolean; lastActiveAt: number } | null {
    return this.sessionInfo;
  }

  clearSessionInfo(): void {
    this.sessionInfo = null;
  }

  // --- Lifecycle ---

  reset(): void {
    this.history = [];
    this.currentId = null;
  }

  load(conversationId: string): void {
    const { store } = this.deps;
    if (!store) return;
    const messages = store.loadMessages(conversationId);
    this.history = [];
    for (const msg of messages) {
      if (msg.role === "user" || msg.role === "assistant") {
        this.history.push({ role: msg.role, content: msg.content });
      }
    }
    this.currentId = conversationId;
  }

  list(limit?: number): Array<{
    conversationId: string;
    startedAt: number;
    lastActiveAt: number;
    title: string | null;
    messageCount: number;
  }> {
    const { store } = this.deps;
    if (!store) return [];
    return store.listConversations(this.deps.motebitId, limit);
  }

  // --- Context window ---

  /** Return history trimmed to fit within the token budget. */
  trimmed(): ConversationMessage[] {
    const summary = this.getStoredSummary();
    return trimConversation(this.history, CONVERSATION_BUDGET, summary);
  }

  // --- Push + auto-summarize ---

  pushExchange(userMessage: string, assistantResponse: string): void {
    this.history.push(
      { role: "user", content: userMessage },
      { role: "assistant", content: assistantResponse },
    );
    if (this.history.length > this.deps.maxHistory) {
      this.history = this.history.slice(-this.deps.maxHistory);
    }

    const { store } = this.deps;
    if (store != null) {
      if (this.currentId == null || this.currentId === "") {
        this.currentId = store.createConversation(this.deps.motebitId);
      }
      store.appendMessage(this.currentId, this.deps.motebitId, {
        role: "user",
        content: userMessage,
      });
      store.appendMessage(this.currentId, this.deps.motebitId, {
        role: "assistant",
        content: assistantResponse,
      });
    }

    // Trigger background summarization at message-count intervals
    if (
      this.deps.getProvider() &&
      store != null &&
      this.currentId != null &&
      this.currentId !== "" &&
      shouldSummarize(this.history.length, this.deps.summarizeAfterMessages)
    ) {
      void this.runSummarization();
    }
  }

  // --- Summarization ---

  async summarize(): Promise<string | null> {
    const provider = this.deps.getProvider();
    const { store } = this.deps;
    if (provider == null || store == null || this.currentId == null || this.currentId === "")
      return null;
    const history = this.getHistory();
    if (history.length < 2) return null;
    const existingSummary = this.getStoredSummary();
    const summary = await summarizeConversation(
      history,
      existingSummary,
      provider,
      this.deps.getTaskRouter() ?? undefined,
    );
    if (summary && this.currentId) {
      store.updateSummary(this.currentId, summary);
    }
    return summary;
  }

  // --- Auto-title ---

  async autoTitle(): Promise<string | null> {
    const { store } = this.deps;
    if (store == null || this.currentId == null || this.currentId === "") return null;

    const convos = store.listConversations(this.deps.motebitId, 100);
    const current = convos.find((c) => c.conversationId === this.currentId);
    if (current?.title != null && current.title !== "") return null; // already titled

    const history = this.getHistory();
    if (history.length < 4) return null;

    const provider = this.deps.getProvider();
    if (provider) {
      try {
        const snippet = history
          .slice(0, 6)
          .map((m) => `${m.role}: ${m.content.slice(0, 200)}`)
          .join("\n");
        const prompt = `Generate a very short title (5-7 words max) for this conversation. Return ONLY the title, no quotes, no explanation.\n\n${snippet}`;
        const raw = await this.deps.generateCompletion(prompt, "title_generation");
        const title = raw
          .trim()
          .replace(/^["']|["']$/g, "")
          .slice(0, 100);
        if (title.length > 0 && title.length < 100) {
          store.updateTitle(this.currentId, title);
          return title;
        }
      } catch {
        // Fall through to heuristic
      }
    }

    // Heuristic fallback: first 7 words of first user message
    const first = history.find((m) => m.role === "user");
    if (first) {
      const words = first.content.split(/\s+/);
      let title = words.slice(0, 7).join(" ");
      if (words.length > 7) title += "...";
      if (title.length > 0) {
        store.updateTitle(this.currentId, title);
        return title;
      }
    }
    return null;
  }

  // --- Task isolation ---

  /** Save conversation state for isolated task execution. */
  saveContext(): { history: ConversationMessage[]; id: string | null } {
    return { history: [...this.history], id: this.currentId };
  }

  /** Restore conversation state after isolated task execution. */
  restoreContext(ctx: { history: ConversationMessage[]; id: string | null }): void {
    this.history = ctx.history;
    this.currentId = ctx.id;
  }

  /** Clear conversation for isolated execution (task context). */
  clearForTask(): void {
    this.history = [];
    this.currentId = null;
  }

  // --- Agentic loop support ---

  /**
   * Inject intermediate messages into the live history (e.g. tool call/result
   * pairs during the agentic loop). These are part of the context window for
   * continuation turns but are not individually persisted as conversation
   * messages — only the final user/assistant exchange is persisted via
   * pushExchange().
   */
  injectIntermediateMessages(...messages: ConversationMessage[]): void {
    this.history.push(...messages);
  }

  /** Return the raw live history reference for continuation turns. */
  get liveHistory(): ConversationMessage[] {
    return this.history;
  }

  // --- Internal helpers ---

  /** Get stored summary for the current conversation. */
  getStoredSummary(): string | null {
    const { store } = this.deps;
    if (this.currentId == null || this.currentId === "" || store == null) return null;
    return store.getActiveConversation(this.deps.motebitId)?.summary ?? null;
  }

  private async runSummarization(): Promise<void> {
    const provider = this.deps.getProvider();
    const { store } = this.deps;
    if (provider == null || store == null || this.currentId == null || this.currentId === "")
      return;
    try {
      const existingSummary = this.getStoredSummary();
      const summary = await summarizeConversation(
        this.history,
        existingSummary,
        provider,
        this.deps.getTaskRouter() ?? undefined,
      );
      if (summary && this.currentId) {
        store.updateSummary(this.currentId, summary);
      }
    } catch {
      // Summarization is best-effort — don't crash the runtime
    }
  }
}
