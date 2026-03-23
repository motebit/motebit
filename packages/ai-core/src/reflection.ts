import type { ConversationMessage, IntelligenceProvider } from "@motebit/sdk";
import { TrustMode, BatteryMode } from "@motebit/sdk";
import type { TaskRouter } from "./task-router.js";
import { withTaskConfig } from "./task-router.js";

// === Reflection Result ===

export interface ReflectionResult {
  /** What the agent learned from the conversation. */
  insights: string[];
  /** Suggested changes to approach or behavior. */
  planAdjustments: string[];
  /** Recurring patterns detected across past reflections. */
  patterns: string[];
  /** Brief self-evaluation of performance. */
  selfAssessment: string;
}

// === Reflection Prompt ===

const REFLECTION_PROMPT = `You are reflecting on your recent interactions. Review the conversation context, your goals, and your memories. Think about:

1. INSIGHTS — What did you learn? About the user, about the topic, about yourself?
2. PLAN ADJUSTMENTS — Should you change your approach? Be more/less concise? Ask different questions? Use tools differently?
3. SELF-ASSESSMENT — How well did you serve the user? What went well? What could improve?

If past reflections are provided, look for PATTERNS across them:
- Recurring insights that suggest a deeper principle
- Adjustments you've made before that you're still making (not yet internalized)
- Improvements or regressions in your self-assessment over time
Surface these patterns explicitly — "I keep noting X" is more valuable than a fresh observation.

If a memory audit is provided, note any beliefs you hold without corroboration and any contradictions in your knowledge.

Respond in this exact format (keep each section concise):

INSIGHTS:
- [insight 1]
- [insight 2]

ADJUSTMENTS:
- [adjustment 1]
- [adjustment 2]

PATTERNS:
- [recurring pattern, if any — omit section if none detected]

ASSESSMENT:
[1-2 sentence self-evaluation]`;

/** A previous reflection result with timestamp, for trajectory analysis. */
export interface PastReflection {
  timestamp: number;
  insights: string[];
  planAdjustments: string[];
  selfAssessment: string;
}

// === Minimal state for reflection calls ===

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

// === Parsing ===

/**
 * Parse the structured reflection response into a ReflectionResult.
 * Gracefully handles malformed responses.
 */
export function parseReflectionResponse(text: string): ReflectionResult {
  const result: ReflectionResult = {
    insights: [],
    planAdjustments: [],
    patterns: [],
    selfAssessment: "",
  };

  // Split into sections by known headers
  const sectionPattern = /^(INSIGHTS|ADJUSTMENTS|PATTERNS|ASSESSMENT):\s*$/im;
  const lines = text.split("\n");
  const sections: Record<string, string[]> = {};
  let currentSection: string | null = null;

  for (const line of lines) {
    const headerMatch = line.match(sectionPattern);
    if (headerMatch) {
      currentSection = headerMatch[1]!.toUpperCase();
      sections[currentSection] = [];
    } else if (currentSection != null && currentSection !== "") {
      sections[currentSection]!.push(line);
    }
  }

  if (sections["INSIGHTS"]) {
    result.insights = parseBulletList(sections["INSIGHTS"].join("\n"));
  }

  if (sections["ADJUSTMENTS"]) {
    result.planAdjustments = parseBulletList(sections["ADJUSTMENTS"].join("\n"));
  }

  if (sections["PATTERNS"]) {
    result.patterns = parseBulletList(sections["PATTERNS"].join("\n"));
  }

  if (sections["ASSESSMENT"]) {
    result.selfAssessment = sections["ASSESSMENT"].join("\n").trim();
  }

  // Fallback: if parsing completely failed, treat whole text as assessment
  if (
    result.insights.length === 0 &&
    result.planAdjustments.length === 0 &&
    !result.selfAssessment
  ) {
    result.selfAssessment = text.trim();
  }

  return result;
}

function formatReflectionAge(ms: number): string {
  const hours = ms / (1000 * 60 * 60);
  if (hours < 1) return `${Math.round(hours * 60)}m`;
  if (hours < 48) return `${Math.round(hours)}h`;
  return `${Math.round(hours / 24)}d`;
}

function parseBulletList(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.replace(/^\s*[-*]\s*/, "").trim())
    .filter((line) => line.length > 0);
}

// === Core Reflection Function ===

/**
 * Perform a reflection on recent conversation, goals, and memories.
 *
 * This is a meta-cognitive loop — the agent thinking about its own
 * performance and what it has learned.
 *
 * When a `TaskRouter` is provided, the provider's model/temperature/maxTokens
 * are temporarily switched to the "reflection" task config before calling
 * generate, then restored afterward.
 */
export async function reflect(
  conversationSummary: string | null,
  recentMessages: ConversationMessage[],
  activeGoals: Array<{ description: string; status: string }>,
  memories: Array<{ content: string }>,
  provider: IntelligenceProvider,
  taskRouter?: TaskRouter,
  pastReflections?: PastReflection[],
  auditSummary?: string,
): Promise<ReflectionResult> {
  // Build context sections
  const sections: string[] = [REFLECTION_PROMPT];

  if (conversationSummary != null && conversationSummary !== "") {
    sections.push(`[Conversation Summary]\n${conversationSummary}`);
  }

  if (recentMessages.length > 0) {
    const formatted = recentMessages
      .slice(-20) // Last 20 messages max
      .map((m) => {
        if (m.role === "tool") return `[tool result]: ${m.content.slice(0, 200)}`;
        return `${m.role}: ${m.content}`;
      })
      .join("\n");
    sections.push(`[Recent Messages]\n${formatted}`);
  }

  if (activeGoals.length > 0) {
    const goalList = activeGoals.map((g) => `- ${g.description} (${g.status})`).join("\n");
    sections.push(`[Active Goals]\n${goalList}`);
  }

  if (memories.length > 0) {
    const memList = memories
      .slice(0, 10) // Cap at 10
      .map((m) => `- ${m.content}`)
      .join("\n");
    sections.push(`[Relevant Memories]\n${memList}`);
  }

  if (pastReflections && pastReflections.length > 0) {
    const refList = pastReflections.map((r) => {
      const ago = formatReflectionAge(Date.now() - r.timestamp);
      const parts: string[] = [`(${ago} ago)`];
      if (r.insights.length > 0) parts.push(`Insights: ${r.insights.join("; ")}`);
      if (r.planAdjustments.length > 0) parts.push(`Adjustments: ${r.planAdjustments.join("; ")}`);
      if (r.selfAssessment) parts.push(`Assessment: ${r.selfAssessment}`);
      return parts.join("\n  ");
    });
    sections.push(`[Past Reflections — look for recurring patterns]\n${refList.join("\n\n")}`);
  }

  if (auditSummary != null && auditSummary !== "") {
    sections.push(`[Memory Audit]\n${auditSummary}`);
  }

  const userMessage = sections.join("\n\n");

  const doGenerate = async (p: IntelligenceProvider) => {
    const response = await p.generate({
      recent_events: [],
      relevant_memories: [],
      current_state: minimalState(),
      user_message: userMessage,
    });
    return parseReflectionResponse(response.text);
  };

  if (taskRouter) {
    const taskConfig = taskRouter.resolve("reflection");
    return withTaskConfig(provider, taskConfig, doGenerate);
  }

  return doGenerate(provider);
}
