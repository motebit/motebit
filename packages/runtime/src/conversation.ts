/**
 * Conversation lifecycle management — history, persistence, trimming,
 * summarization, auto-titling.
 *
 * Extracted from MotebitRuntime to keep the orchestrator focused on
 * wiring rather than conversation bookkeeping.
 */

import type {
  ConversationMessage,
  ConversationStoreAdapter,
  SensitivityCleared,
  SensitivityGateEntry,
} from "@motebit/sdk";
import { SensitivityLevel, maxSensitivity, sensitivityPermits } from "@motebit/sdk";
import type { TurnPrincipal } from "./turn-principal.js";
import type { StreamingProvider, TaskType, MotebitLoopDependencies } from "@motebit/ai-core";
import {
  trimConversation,
  estimateTokens,
  historyBudgetForWindow,
  DEFAULT_HISTORY_CEILING_TOKENS,
  summarizeConversation,
  shouldSummarize,
  projectProviderClearance,
} from "@motebit/ai-core";
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
  /**
   * Optional message-count cap on the in-memory history. Absent ⇒ no count
   * cap: the token bound below and the per-turn budget in `trimmed()` decide.
   * When set it applies on every path (`load`, `resumeActiveConversation`,
   * `pushExchange`, `pushActivation`), so a resumed conversation and a live
   * one hold the same messages.
   */
  maxHistory?: number;
  /**
   * The current model's context window, or `undefined` when not known
   * (unknown ⇒ the fixed history floor). Read per call: the model can change
   * mid-session.
   */
  getContextWindowTokens?: () => number | undefined;
  /** Policy ceiling on history tokens for the current model. Default 64,000. */
  getHistoryCeilingTokens?: () => number;
  /** Tokens held back for the response when sizing history. Default 8,192. */
  outputReserveTokens?: number;
  /**
   * Token bound on the in-memory history: the oldest messages beyond the
   * newest `historyBoundTokens` are released (the newest exchange always
   * stays). Must be at least every
   * ceiling `getHistoryCeilingTokens` can return, so the bound never
   * removes a message the per-turn budget would send. Applied on every path
   * like `maxHistory`. Default {@link DEFAULT_HISTORY_BOUND_TOKENS}.
   */
  historyBoundTokens?: number;
  summarizeAfterMessages: number;
  store: ConversationStoreAdapter | null;
  /**
   * Resolve current AI provider (may change over lifetime).
   *
   * Returns the raw (unbranded) provider — used for nullability /
   * configuration checks ("is a provider wired?"). Bytes-leave call
   * sites do NOT use this; they call
   * `assertSensitivityPermitsAiCall("summarizeConversation")` and
   * project the cleared provider via
   * `projectProviderClearance(cleared)`. Reading the unbranded
   * provider for a pre-flight existence check before firing the
   * gate is fine — the gate's audit event correctly attributes
   * which call would have egressed.
   */
  getProvider(): StreamingProvider | null;
  /** Resolve current task router (may change over lifetime). */
  getTaskRouter(): TaskRouter | null;
  /** Generate a plain text completion for titling. */
  generateCompletion(prompt: string, taskType?: TaskType): Promise<string>;
  /**
   * Fire the runtime's sensitivity gate and return branded loop deps.
   * Single authorized path to summarization's AI-call site — the
   * brand is unforgeable outside the runtime, so every
   * `summarizeConversation` invocation is rooted in a gate firing.
   * Closes the cross-package off-gate path the static
   * `check-sensitivity-routing` cannot scan (this file lives in
   * `@motebit/runtime`, the static gate scans only
   * `motebit-runtime.ts`).
   */
  assertSensitivityPermitsAiCall(
    entry: SensitivityGateEntry,
    toolName?: string,
  ): SensitivityCleared<MotebitLoopDependencies>;
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

/**
 * Non-history tokens assumed when a caller asks for trimmed history without
 * measuring its turn: system prompt + tool schemas + context pack + current
 * message (~9.5k witnessed in intelligence-pluggability-contract.md, rounded
 * up). The turn path measures instead — see `TurnOptions.budgetConversationHistory`.
 */
export const UNMEASURED_NON_HISTORY_TOKENS = 12_000;

/**
 * Default token bound on the in-memory history: twice the default history
 * ceiling, so skip-not-stop trimming still has older permitted messages to
 * reach past a skipped paste or a filtered message.
 */
export const DEFAULT_HISTORY_BOUND_TOKENS = 2 * DEFAULT_HISTORY_CEILING_TOKENS;

/** The token bound never releases the newest exchange. */
const MIN_BOUND_MESSAGES = 2;

/** The conversation as one turn sees it — see {@link ConversationManager.forTurn}. */
export interface TurnConversation {
  trimmed(nonHistoryTokens?: number): ConversationMessage[];
  getSessionInfo(): { continued: boolean; lastActiveAt: number } | null;
  clearSessionInfo(): void;
  pushExchange(userMessage: string, assistantResponse: string): void;
  pushActivation(assistantResponse: string): void;
  injectIntermediateMessages(...messages: ConversationMessage[]): void;
}

/** A foreign principal's view: nothing of the owner's, nothing written. */
const FOREIGN_TURN_CONVERSATION: TurnConversation = Object.freeze({
  trimmed: () => [],
  getSessionInfo: () => null,
  clearSessionInfo: () => {},
  pushExchange: () => {},
  pushActivation: () => {},
  injectIntermediateMessages: () => {},
});

export class ConversationManager {
  private history: ConversationMessage[] = [];
  private currentId: string | null = null;
  private sessionInfo: { continued: boolean; lastActiveAt: number } | null = null;
  private autoTitlePending = false;

  constructor(private readonly deps: ConversationDeps) {}

  /**
   * The conversation as ONE turn may see and write it (#904, #943 round 9).
   * Whose turn it is travels on the call path — the turn's entry decides its
   * `TurnPrincipal` and every turn path (the `sendMessage*` doors, stream
   * processing, the approval resume and timeout) reaches the conversation
   * only through this view, never through the manager's methods.
   *
   * A FOREIGN principal's view is empty and inert: no history, no stored
   * summary, no session facts (the owner's interior is never served to
   * another principal, #880), and every write is a no-op — a stranger's
   * words never enter the owner's history as `role:"user"`, are never
   * persisted, synced or summarized, and never consume the owner's
   * session marker. What a foreign turn did is recorded where it belongs:
   * the signed `ExecutionReceipt`, the tool audit, `peer_agent` memories.
   *
   * The OWNER's view is this manager. The manager itself no longer reads
   * any "is a foreign turn in flight" state: the owner's own concurrent
   * reads (a surface rendering `getHistory`, a reflection) are never
   * blanked because a stranger's task happens to be running.
   */
  forTurn(principal: TurnPrincipal): TurnConversation {
    if (principal.foreign) return FOREIGN_TURN_CONVERSATION;
    return {
      trimmed: (n) => this.trimmed(n),
      getSessionInfo: () => this.getSessionInfo(),
      clearSessionInfo: () => this.clearSessionInfo(),
      pushExchange: (u, a) => this.pushExchange(u, a),
      pushActivation: (a) => this.pushActivation(a),
      injectIntermediateMessages: (...m) => this.injectIntermediateMessages(...m),
    };
  }

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
    this.boundHistory();
    if (this.history.length > 0) {
      this.sessionInfo = { continued: true, lastActiveAt: active.lastActiveAt };
    }
  }

  // --- Accessors ---

  /**
   * Every message in the live history, every tier — for local rendering and
   * counts. Never hand this to a provider: egress reads `egressHistory` /
   * `trimmed` (enforced by `egress-history-gate.test.ts`).
   */
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
    this.boundHistory();
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
   *
   * Budget (docs/design/context-trimming-parity.md, P1): the filter runs
   * FIRST and is independent of the model; the budget then sizes the
   * permitted messages to the current model's window —
   * `clamp(window − nonHistoryTokens − outputReserve, 6,976, ceiling)`,
   * the floor when the window is unknown. A larger window changes how many
   * permitted messages fit, never which are permitted. `nonHistoryTokens`
   * is what the turn measured for its system prompt, tools and message;
   * absent ⇒ {@link UNMEASURED_NON_HISTORY_TOKENS}.
   */
  trimmed(nonHistoryTokens: number = UNMEASURED_NON_HISTORY_TOKENS): ConversationMessage[] {
    const summary = this.getStoredSummary();
    const filtered = this.egressHistory();
    const budget = historyBudgetForWindow({
      contextWindowTokens: this.deps.getContextWindowTokens?.(),
      nonHistoryTokens,
      outputReserveTokens: this.deps.outputReserveTokens,
      ceilingTokens: this.deps.getHistoryCeilingTokens?.(),
    });
    return trimConversation(filtered, budget, summary);
  }

  /**
   * The history a provider may receive: the live history filtered to the
   * session's effective tier AT SEND TIME (read per call — the tier and the
   * provider can change between turns). Every path that sends conversation
   * history off this manager reads through here: `trimmed` (turns, the
   * approval resume) budgets it; summarization, the AI title and reflection
   * send it whole. The raw history is never returned to a provider-reaching
   * caller — `getHistory` is for local rendering and counts only.
   */
  egressHistory(): ConversationMessage[] {
    const effective = this.deps.getEffectiveSensitivity?.() ?? SensitivityLevel.None;
    return this.history.filter(
      (msg) => msg.sensitivity == null || sensitivityPermits(effective, msg.sensitivity),
    );
  }

  /**
   * Release what no turn can send: the count cap when configured, then the
   * token bound (a newest-first suffix that always keeps the newest
   * exchange). Same function on every path that fills the history, so live
   * and resumed conversations hold the same messages. Never reorders or
   * rewrites what it keeps.
   */
  private boundHistory(): void {
    const { maxHistory } = this.deps;
    if (maxHistory != null && this.history.length > maxHistory) {
      this.history = this.history.slice(-maxHistory);
    }
    const bound = this.deps.historyBoundTokens ?? DEFAULT_HISTORY_BOUND_TOKENS;
    let total = 0;
    let start = this.history.length;
    while (start > 0) {
      total += estimateTokens(this.history[start - 1]!.content);
      if (total > bound && this.history.length - start >= MIN_BOUND_MESSAGES) break;
      start--;
    }
    if (start > 0) this.history = this.history.slice(start);
  }

  // --- Push + auto-summarize ---

  /** Record only an assistant message (no user message). Used for system-triggered
   *  generation like first-contact activation where there is no user input. */
  pushActivation(assistantResponse: string): void {
    const cleaned = stripInternalTags(assistantResponse).trim();
    const sensitivity = this.resolveMessageSensitivity();
    this.history.push({ role: "assistant", content: cleaned, sensitivity });
    this.boundHistory();
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
    this.boundHistory();

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
    const history = this.egressHistory();
    if (history.length < 2) return null;
    const existingSummary = this.getStoredSummary();
    // Fire the privacy gate before bytes leave for the
    // summarization completion. The unbranded `provider` above is
    // only used for the nullability check; the actual AI call
    // requires `SensitivityCleared<StreamingProvider>` projected
    // from the gate's cleared deps.
    const clearedProvider = projectProviderClearance(
      this.deps.assertSensitivityPermitsAiCall("summarizeConversation"),
    );
    const summary = await summarizeConversation(
      history,
      existingSummary,
      clearedProvider,
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
        const aiTitle = await this.tryAiTitle(this.egressHistory());
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
  searchHistory(
    query: string,
    limit = 5,
    /**
     * Egress ceiling for the results. Present ⇒ an EXTERNAL provider: include
     * only messages EXPLICITLY classified at one of these tiers; a message with
     * a `null`/unknown tier or one ≥ medical is withheld (fail-closed), so a past
     * transcript that may hold medical/financial/secret content never reaches
     * external AI. Absent ⇒ a SOVEREIGN (on-device) provider: search every tier,
     * the content never leaves the device. Owned by `runtime.searchConversations`.
     */
    sensitivityFilter?: readonly SensitivityLevel[],
  ): ReturnType<typeof searchConversationMessages> {
    const { store } = this.deps;
    if (store == null) return [];
    const convos = store.listConversations(this.deps.motebitId);
    const messages: ConversationMessageRecord[] = [];
    for (const c of convos) {
      const msgs = store.loadMessages(c.conversationId);
      for (const m of msgs) {
        if (m.role !== "user" && m.role !== "assistant") continue;
        if (
          sensitivityFilter != null &&
          (m.sensitivity == null || !sensitivityFilter.includes(m.sensitivity))
        ) {
          continue;
        }
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

  // --- Agentic loop support ---

  /**
   * Inject intermediate messages into the live history (e.g. tool call/result
   * pairs during the agentic loop). These are part of the context window for
   * continuation turns but are not individually persisted as conversation
   * messages — only the final user/assistant exchange is persisted via
   * pushExchange().
   */
  injectIntermediateMessages(...messages: ConversationMessage[]): void {
    // Stamped like an exchange, so a tool result read at a high tier is
    // filtered out of later turns once the tier drops.
    const sensitivity = this.resolveMessageSensitivity();
    this.history.push(...messages.map((m) => (m.sensitivity != null ? m : { ...m, sensitivity })));
    this.boundHistory();
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
      // Gate-then-project — see `summarize()` comment. The outer
      // try/catch covers both the gate's `SovereignTierRequiredError`
      // (sensitivity blocked the egress) and downstream provider
      // failures; the audit event still emits before the throw so a
      // blocked background summarization is observable in the
      // SensitivityGateFired log.
      const clearedProvider = projectProviderClearance(
        this.deps.assertSensitivityPermitsAiCall("summarizeConversation"),
      );
      const summary = await summarizeConversation(
        this.egressHistory(),
        existingSummary,
        clearedProvider,
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
