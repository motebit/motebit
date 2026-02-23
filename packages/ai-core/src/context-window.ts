import type { ConversationMessage } from "@motebit/sdk";

export interface ContextBudget {
  /** Total token budget for conversation history. */
  maxTokens: number;
  /** Tokens reserved for the model's response. */
  reserveForResponse: number;
}

/** Rough token estimate: ~4 chars per token. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Trim conversation history to fit within a token budget.
 *
 * Keeps recent messages, drops oldest first. If messages were dropped and a
 * summary exists, prepends a synthetic system-context message so the model
 * knows the conversation continues from earlier.
 */
export function trimConversation(
  messages: ConversationMessage[],
  budget: ContextBudget,
  conversationSummary?: string | null,
): ConversationMessage[] {
  if (messages.length === 0) return [];

  const available = budget.maxTokens - budget.reserveForResponse;
  if (available <= 0) return [];

  // Walk from the end (newest), accumulate token counts
  let total = 0;
  let cutoff = messages.length; // index of first message to keep

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!;
    const tokens = estimateTokens(msg.content);
    if (total + tokens > available) {
      cutoff = i + 1;
      break;
    }
    total += tokens;
    if (i === 0) cutoff = 0;
  }

  const kept = messages.slice(cutoff);

  // Nothing was dropped — return as-is
  if (cutoff === 0) return kept;

  // Prepend context note about trimmed messages
  const contextNote = conversationSummary != null && conversationSummary !== ""
    ? `[Earlier in this conversation: ${conversationSummary}]`
    : `[This conversation continues from earlier. Some messages have been trimmed for context.]`;

  return [
    { role: "user" as const, content: contextNote },
    ...kept,
  ];
}
