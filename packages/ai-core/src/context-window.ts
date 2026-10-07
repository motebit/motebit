import type { ConversationMessage } from "@motebit/sdk";

export interface ContextBudget {
  /** Total token budget for conversation history. */
  maxTokens: number;
  /** Tokens reserved for the model's response. */
  reserveForResponse: number;
}

/** Rough token estimate: ~4 chars per token. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * History tokens a turn may always carry, whatever the model: the fixed
 * budget every turn had before the window was consulted (8,000 − 1,024
 * reserved). An unknown or small window never trims harder than this.
 */
export const HISTORY_BUDGET_FLOOR_TOKENS = 6_976;

/**
 * Default policy ceiling on history tokens per turn. A 1M window does not
 * mean every turn ships 1M tokens: cost and time-to-first-token grow with
 * uncached input, and recall degrades at extreme lengths. Configurable per
 * capability tier (`RuntimeConfig.historyCeilingTokens`).
 */
export const DEFAULT_HISTORY_CEILING_TOKENS = 64_000;

/** Default tokens held back for the model's response when sizing history. */
export const DEFAULT_OUTPUT_RESERVE_TOKENS = 8_192;

/** Inputs to {@link historyBudgetForWindow}. */
export interface HistoryBudgetInput {
  /** The model's context window; `undefined` when not known. */
  contextWindowTokens?: number;
  /**
   * Tokens the turn needs besides history, measured for this turn: the
   * assembled system prompt (context pack rendered in), the tool schemas and
   * the current user message.
   */
  nonHistoryTokens: number;
  /** Held back for the response. Default {@link DEFAULT_OUTPUT_RESERVE_TOKENS}. */
  outputReserveTokens?: number;
  /** Policy ceiling. Default {@link DEFAULT_HISTORY_CEILING_TOKENS}. */
  ceilingTokens?: number;
}

/**
 * History budget for one turn, derived from the model's window:
 *
 *   clamp(window − nonHistory − outputReserve, floor, ceiling)
 *
 * with the floor at {@link HISTORY_BUDGET_FLOOR_TOKENS}. An unknown window
 * yields the floor. The floor wins over a ceiling configured below it, so no
 * model is trimmed harder than before the window was consulted. The budget
 * only sizes what is sent; WHICH messages may be sent is decided before
 * budgeting (the sensitivity filter in `ConversationManager.trimmed`).
 */
export function historyBudgetForWindow(input: HistoryBudgetInput): ContextBudget {
  const floor = HISTORY_BUDGET_FLOOR_TOKENS;
  const window = input.contextWindowTokens;
  if (window == null || !Number.isFinite(window) || window <= 0) {
    return { maxTokens: floor, reserveForResponse: 0 };
  }
  const reserve = input.outputReserveTokens ?? DEFAULT_OUTPUT_RESERVE_TOKENS;
  const ceiling = input.ceilingTokens ?? DEFAULT_HISTORY_CEILING_TOKENS;
  const fromWindow = Math.floor(window - Math.max(0, input.nonHistoryTokens) - reserve);
  const maxTokens = Math.max(floor, Math.min(ceiling, fromWindow));
  return { maxTokens, reserveForResponse: 0 };
}

function hasToolCalls(msg: ConversationMessage): boolean {
  return msg.role === "assistant" && msg.tool_calls != null && msg.tool_calls.length > 0;
}

/**
 * Trim conversation history to fit within a token budget.
 *
 * Walks newest → oldest and keeps each message that still fits. A message
 * that does not fit is skipped, not a stopping point: one large paste no
 * longer evicts every smaller message before it. Kept messages stay in
 * chronological order and are returned unmodified, so a history that grows
 * by appending keeps a stable prefix for prompt caching until the budget is
 * reached. If anything was dropped, a note is prepended — the stored summary
 * when one exists, otherwise a generic continuation note.
 */
export function trimConversation(
  messages: ConversationMessage[],
  budget: ContextBudget,
  conversationSummary?: string | null,
): ConversationMessage[] {
  if (messages.length === 0) return [];

  const available = budget.maxTokens - budget.reserveForResponse;
  if (available <= 0) return [];

  // Walk from the end (newest), keep whatever still fits. The unit is an
  // assistant tool-call message together with the tool results that answer
  // it: kept or skipped together, so a result never survives without the
  // call it answers (providers reject an orphaned tool result).
  let total = 0;
  const keep: boolean[] = new Array<boolean>(messages.length).fill(false);
  let dropped = 0;

  let end = messages.length;
  while (end > 0) {
    let start = end - 1;
    while (start > 0 && messages[start]!.role === "tool") start--;
    if (messages[start]!.role === "tool" || !hasToolCalls(messages[start]!)) {
      // Not a tool-call group: the unit is the single newest message.
      start = end - 1;
    }
    let tokens = 0;
    for (let i = start; i < end; i++) tokens += estimateTokens(messages[i]!.content);
    if (total + tokens > available) {
      dropped += end - start;
    } else {
      total += tokens;
      for (let i = start; i < end; i++) keep[i] = true;
    }
    end = start;
  }

  const kept = messages.filter((_, i) => keep[i]);

  // Nothing was dropped — return as-is
  if (dropped === 0) return kept;

  // Prepend context note about trimmed messages
  const contextNote =
    conversationSummary != null && conversationSummary !== ""
      ? `[Earlier in this conversation: ${conversationSummary}]`
      : `[This conversation continues from earlier. Some messages have been trimmed for context.]`;

  return [{ role: "user" as const, content: contextNote }, ...kept];
}
