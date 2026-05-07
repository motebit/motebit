/**
 * Conversation lifecycle management — history, persistence, trimming,
 * summarization, auto-titling.
 *
 * Extracted from MotebitRuntime to keep the orchestrator focused on
 * wiring rather than conversation bookkeeping.
 */

import type { ConversationMessage, ConversationStoreAdapter } from "@motebit/sdk";
import { SensitivityLevel, maxSensitivity, sensitivityPermits } from "@motebit/sdk";
import type { StreamingProvider, ContextBudget, TaskType } from "@motebit/ai-core";
import { trimConversation, summarizeConversation, shouldSummarize } from "@motebit/ai-core";
import type { TaskRouter } from "@motebit/ai-core";
import {
  searchConversationMessages,
  type ConversationMessageRecord,
} from "./conversation-search.js";

/** Strip internal tags (state, thinking, memory) before persisting — display-only, not content. */
function stripInternalTags(text: string): string {
  return text
    .replace(/<state\s+[^>]*\/>/g, "")
    .replace(/<thinking>[\s\S]*?<\/thinking>/g, "")
    .replace(/<memory\s+[^>]*>[\s\S]*?<\/memory>/g, "")
    .replace(/<(?:state|thinking|memory)[^>]*$/g, "");
}

/**
 * Derive a short conversation title from the first user message. Used
 * when an AI title isn't available (no provider, timeout, error). Also
 * used by `backfillMissingTitles` to repair old conversations.
 *
 * Returns null when no user message exists or the message is empty —
 * the caller then leaves the title null and the UI renders its
 * "New conversation" fallback.
 */
function deriveHeuristicTitle(history: readonly ConversationMessage[]): string | null {
  const first = history.find((m) => m.role === "user");
  if (!first) return null;
  const words = first.content.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return null;
  let title = words.slice(0, 7).join(" ");
  if (words.length > 7) title += "...";
  return title.length > 0 ? title : null;
}

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
  /**
   * Default sensitivity tier stamped on every persisted message. Mirrors
   * the operator manifest's `pre_classification_default_sensitivity`
   * (docs/doctrine/retention-policy.md §"Decision 6b") — the runtime
   * resolves this from the relay's
   * `/.well-known/motebit-retention.json` at boot when available, and
   * defaults to `personal` otherwise. The flush phase lazy-classifies
   * any message whose tier turns out to be tighter than the default.
   */
  defaultSensitivity?: SensitivityLevel;
  /**
   * Optional getter returning the runtime's effective session
   * sensitivity at message-write time — composed from the explicit
   * session tier AND any tier-bounded slab items (drops, classified
   * tool outputs). When provided, the manager floors each persisted
   * message at `max(defaultSensitivity, effective)` so messages
   * written during a high-tier turn carry their actual provenance
   * tier rather than the static default.
   *
   * Closes the cross-device leak shape: a Secret-effective turn
   * persisting the user's reply at the static `personal` default,
   * synced to the relay, retrieved on another device whose session
   * is at None tier, included in trimmed history → BYOK egress.
   *
   * Doctrine: `motebit-computer.md` §"Mode contract" + the closure of
   * the egress-shape arc (the four prior moves shipped the same
   * pattern at session/drops/tools/memory-write boundaries; this
   * is the conversation-write boundary). Optional because in-tree
   * tests fixture without a runtime; production wiring threads
   * `runtime.getEffectiveSessionSensitivity` through.
   */
  getEffectiveSensitivity?: () => SensitivityLevel;
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
  private autoTitlePending = false;

  constructor(private readonly deps: ConversationDeps) {}

  /**
   * Compute the sensitivity tier to stamp on a newly-persisted
   * message. Floors the operator-manifest default at the runtime's
   * effective session sensitivity (`max(default, effective)`) so
   * messages written during a high-tier turn carry their actual
   * provenance tier rather than the static default. Closes the
   * conversation-write egress shape (parallel to memory-write floor
   * in `ai-core/loop.ts`).
   */
  private resolveMessageSensitivity(): SensitivityLevel {
    const baseline = this.deps.defaultSensitivity ?? SensitivityLevel.Personal;
    const effective = this.deps.getEffectiveSensitivity?.() ?? SensitivityLevel.None;
    return maxSensitivity(baseline, effective);
  }

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
        this.history.push({ role: msg.role, content: msg.content, sensitivity: msg.sensitivity });
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
        this.history.push({ role: msg.role, content: msg.content, sensitivity: msg.sensitivity });
      }
    }
    this.currentId = conversationId;
  }

  /**
   * Reset in-memory state when a conversation is erased. The runtime's
   * `deleteConversation` routes the durable side through the privacy
   * layer (signed `consolidation_flush` cert per message + audit +
   * `DeleteRequested` event) and then calls this to clear the active
   * history if the user just deleted the conversation they were
   * looking at. Storage is no longer this method's job.
   */
  delete(conversationId: string): void {
    if (this.currentId === conversationId) {
      this.history = [];
      this.currentId = null;
    }
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

  /**
   * Return history trimmed to fit within the token budget. When the
   * runtime supplies an effective tier, messages tagged above it are
   * filtered out before trimming — the read-side companion to the
   * write-side floor in `pushExchange` / `pushActivation`.
   *
   * Untagged messages (legacy data persisted before the v1 floor, or
   * fixtures without a runtime) flow through unchanged for backward
   * compat. Filter is dynamic by current effective tier (not a static
   * `CONTEXT_SAFE_SENSITIVITY` constant) so a session whose tier
   * elevates mid-conversation (e.g., a Secret-tier slab item arrives
   * via `classifyToolResult`) regains access to its own elevated
   * messages, and a session at None tier excludes Secret messages
   * even if they're load-bearing for the current turn — same posture
   * the pre-call AI gate enforces upstream.
   *
   * Closes the read side of the fifth (and final) egress-write
   * boundary: cross-device sync surfaces high-tier messages to a
   * low-tier session whose pre-call gate passes (None × None → None);
   * trimmed history would carry those persisted-at-Secret messages
   * into BYOK without this filter.
   */
  trimmed(): ConversationMessage[] {
    const summary = this.getStoredSummary();
    const effective = this.deps.getEffectiveSensitivity?.() ?? SensitivityLevel.None;
    const filtered = this.history.filter(
      (msg) => msg.sensitivity == null || sensitivityPermits(effective, msg.sensitivity),
    );
    return trimConversation(filtered, CONVERSATION_BUDGET, summary);
  }

  // --- Push + auto-summarize ---

  /** Record only an assistant message (no user message). Used for system-triggered
   *  generation like first-contact activation where there is no user input. */
  pushActivation(assistantResponse: string): void {
    const cleaned = stripInternalTags(assistantResponse).trim();
    const sensitivity = this.resolveMessageSensitivity();
    this.history.push({ role: "assistant", content: cleaned, sensitivity });
    if (this.history.length > this.deps.maxHistory) {
      this.history = this.history.slice(-this.deps.maxHistory);
    }
    const { store } = this.deps;
    if (store != null) {
      if (this.currentId == null || this.currentId === "") {
        this.currentId = store.createConversation(this.deps.motebitId);
      }
      store.appendMessage(this.currentId, this.deps.motebitId, {
        role: "assistant",
        content: cleaned,
        sensitivity,
      });
    }
  }

  pushExchange(userMessage: string, assistantResponse: string): void {
    const cleaned = stripInternalTags(assistantResponse).trim();
    const sensitivity = this.resolveMessageSensitivity();
    this.history.push(
      { role: "user", content: userMessage, sensitivity },
      { role: "assistant", content: cleaned, sensitivity },
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
        sensitivity,
      });
      store.appendMessage(this.currentId, this.deps.motebitId, {
        role: "assistant",
        content: cleaned,
        sensitivity,
      });
    }

    // Auto-title the conversation once enough context exists. Fires from
    // pushExchange — not from the UI — so currentId and history are both
    // guaranteed present. Idempotent: autoTitle checks for an existing
    // title and returns early if one is set.
    void this.autoTitle();

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

  /**
   * Timeout for the AI-generated title attempt. An unresponsive provider
   * (network stall, misrouted task type, relay hiccup) must not poison
   * the primitive: the heuristic fallback runs after this budget.
   *
   * 8s is long enough for a normal title-generation round-trip and short
   * enough that the user never sees a stuck "New conversation" for more
   * than a single turn on a slow network.
   */
  private static readonly AI_TITLE_TIMEOUT_MS = 8000;

  async autoTitle(): Promise<string | null> {
    const { store } = this.deps;
    if (store == null || this.currentId == null || this.currentId === "") return null;
    if (this.autoTitlePending) return null;

    const convos = store.listConversations(this.deps.motebitId, 100);
    const current = convos.find((c) => c.conversationId === this.currentId);
    if (current?.title != null && current.title !== "") return null; // already titled

    const history = this.getHistory();
    if (history.length < 2) return null;

    this.autoTitlePending = true;
    try {
      // Prefer an AI-generated title when a provider is configured, but
      // bound the wait. If the provider hangs, throws, or returns an
      // unusable string, the heuristic below always runs and always
      // writes — every conversation ends this call with a title.
      const provider = this.deps.getProvider();
      if (provider) {
        const aiTitle = await this.tryAiTitle(history);
        if (aiTitle != null) {
          store.updateTitle(this.currentId, aiTitle);
          return aiTitle;
        }
      }

      // Heuristic fallback: first 7 words of first user message.
      // Synchronous, provider-independent, always completes.
      const heuristic = deriveHeuristicTitle(history);
      if (heuristic != null) {
        store.updateTitle(this.currentId, heuristic);
        return heuristic;
      }
      return null;
    } finally {
      this.autoTitlePending = false;
    }
  }

  /**
   * Race the AI title generation against an 8s timeout. Returns the
   * cleaned title string on success; null on timeout, error, empty
   * result, or oversized output. Isolated from `autoTitle` so the
   * fallback path is reached on every non-success — no duplicated
   * catch blocks, no "the inner try-catch swallowed it" footguns.
   */
  private async tryAiTitle(history: readonly ConversationMessage[]): Promise<string | null> {
    const snippet = history
      .slice(0, 6)
      .map((m) => `${m.role}: ${m.content.slice(0, 200)}`)
      .join("\n");
    const prompt = `Generate a very short title (5-7 words max) for this conversation. Return ONLY the title, no quotes, no explanation.\n\n${snippet}`;

    try {
      const raw = await Promise.race([
        this.deps.generateCompletion(prompt, "title_generation"),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error("title generation timeout")),
            ConversationManager.AI_TITLE_TIMEOUT_MS,
          ),
        ),
      ]);
      const title = raw
        .trim()
        .replace(/^["']|["']$/g, "")
        .slice(0, 100);
      if (title.length === 0 || title.length >= 100) return null;
      return title;
    } catch {
      return null;
    }
  }

  // --- Layer-3 conversation search ---

  /**
   * BM25 search over every persisted message for this motebit. Used by
   * the `search_conversations` tool — the Layer-3 transcript retrieval
   * that complements Layer-1 (memory index) and Layer-2
   * (`recall_memories` embedding search). Returns ranked hits with
   * conversation id, timestamp, and a short snippet around the first
   * matching token.
   *
   * Uses only the sync ConversationStoreAdapter surface, so callers
   * with IDB-backed stores MUST preload message caches (e.g.
   * `preloadAllMessages` on web) before invoking. The default for
   * CLI/desktop/mobile with SQLite is sync all the way down and needs
   * no preload.
   */
  searchHistory(query: string, limit = 5): ReturnType<typeof searchConversationMessages> {
    const { store } = this.deps;
    if (store == null) return [];
    const convos = store.listConversations(this.deps.motebitId);
    const messages: ConversationMessageRecord[] = [];
    for (const c of convos) {
      const msgs = store.loadMessages(c.conversationId);
      for (const m of msgs) {
        if (m.role !== "user" && m.role !== "assistant") continue;
        messages.push({
          conversationId: c.conversationId,
          role: m.role,
          content: m.content,
          createdAt: m.createdAt,
        });
      }
    }
    return searchConversationMessages(messages, query, { limit });
  }

  /**
   * Heuristic-title every stored conversation whose title is currently
   * null or empty. Idempotent: conversations with existing titles are
   * skipped. Uses only the synchronous store API, so the caller is
   * responsible for preloading message caches if the adapter is
   * IDB-backed (web/mobile). Returns the count of conversations
   * titled.
   *
   * Shipped to close out the prior autoTitle regression: conversations
   * created before the AI-path hang was fixed carry `title: null`
   * forever. This pass gives them a legible heuristic title on next
   * app start without round-tripping the AI.
   */
  backfillMissingTitles(): number {
    const { store } = this.deps;
    if (store == null) return 0;
    const convos = store.listConversations(this.deps.motebitId);
    let fixed = 0;
    for (const c of convos) {
      if (c.title != null && c.title !== "") continue;
      const messages = store.loadMessages(c.conversationId);
      const history: ConversationMessage[] = [];
      for (const m of messages) {
        if (m.role === "user" || m.role === "assistant") {
          history.push({ role: m.role, content: m.content });
        }
      }
      const title = deriveHeuristicTitle(history);
      if (title != null) {
        store.updateTitle(c.conversationId, title);
        fixed += 1;
      }
    }
    return fixed;
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
