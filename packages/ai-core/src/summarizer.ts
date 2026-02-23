import type { ConversationMessage, IntelligenceProvider } from "@motebit/sdk";
import { TrustMode, BatteryMode } from "@motebit/sdk";
import type { TaskRouter } from "./task-router.js";
import { withTaskConfig } from "./task-router.js";

// === Summarizer Configuration ===

export interface SummarizerConfig {
  /** Summarize after this many messages (default 20). */
  triggerAfterMessages: number;
  /** The AI provider to use for summarization. */
  provider: IntelligenceProvider;
}

// === Summarization Prompt ===

const SUMMARIZE_NEW_PROMPT = `Summarize this conversation concisely. Focus on:
- Key topics discussed
- Decisions made or conclusions reached
- User preferences, habits, or facts learned
- Any unresolved questions or pending tasks

Be concise — aim for 2-4 sentences. Write in third person ("The user asked about...", "They discussed...").`;

const SUMMARIZE_UPDATE_PROMPT = `Update the existing conversation summary with the new messages below. Integrate new information into the existing summary rather than starting from scratch. Focus on:
- New topics, decisions, or conclusions
- Updated or corrected user preferences
- Newly unresolved questions or pending tasks

Keep the summary concise — aim for 2-5 sentences. Write in third person.`;

// === Minimal state for summary calls ===

function minimalState() {
  return {
    attention: 0.5,
    processing: 0.5,
    confidence: 0.7,
    affect_valence: 0,
    affect_arousal: 0.1,
    social_distance: 0.5,
    curiosity: 0.5,
    trust_mode: TrustMode.Full,
    battery_mode: BatteryMode.Normal,
  };
}

// === Core Summarization Function ===

/**
 * Summarize a conversation, optionally updating an existing summary.
 *
 * Uses a short, focused AI call (max ~300 tokens worth of response) to
 * produce a concise summary for context window management.
 *
 * When a `TaskRouter` is provided, the provider's model/temperature/maxTokens
 * are temporarily switched to the "summarization" task config before calling
 * generate, then restored afterward.
 */
export async function summarizeConversation(
  messages: ConversationMessage[],
  existingSummary: string | null,
  provider: IntelligenceProvider,
  taskRouter?: TaskRouter,
): Promise<string> {
  if (messages.length === 0) return existingSummary ?? "";

  // Format messages into a readable block
  const formatted = messages
    .map((m) => {
      if (m.role === "tool") return `[tool result]: ${m.content.slice(0, 200)}`;
      return `${m.role}: ${m.content}`;
    })
    .join("\n");

  // Build the prompt
  let userMessage: string;
  if (existingSummary != null && existingSummary !== "") {
    userMessage = `${SUMMARIZE_UPDATE_PROMPT}\n\n[Existing Summary]\n${existingSummary}\n\n[New Messages]\n${formatted}`;
  } else {
    userMessage = `${SUMMARIZE_NEW_PROMPT}\n\n[Conversation]\n${formatted}`;
  }

  const doGenerate = async (p: IntelligenceProvider) => {
    const response = await p.generate({
      recent_events: [],
      relevant_memories: [],
      current_state: minimalState(),
      user_message: userMessage,
    });
    return response.text.trim();
  };

  if (taskRouter) {
    const taskConfig = taskRouter.resolve("summarization");
    return withTaskConfig(provider, taskConfig, doGenerate);
  }

  return doGenerate(provider);
}

/**
 * Check whether summarization should trigger based on message count.
 */
export function shouldSummarize(
  messageCount: number,
  triggerAfterMessages: number,
): boolean {
  if (triggerAfterMessages <= 0) return false;
  return messageCount > 0 && messageCount % triggerAfterMessages === 0;
}
