import { TrustMode, BatteryMode, StepStatus } from "@motebit/sdk";
import type { Plan, PlanStep } from "@motebit/sdk";
import type { StreamingProvider } from "@motebit/ai-core";

// === Plan Reflection Result ===

export interface ReflectionResult {
  /** Brief summary of the plan execution. */
  summary: string;
  /** Memory-worthy learnings from the plan execution (1-3 items). */
  memoryCandidates: string[];
}

// === Reflection Prompt ===

const REFLECTION_SYSTEM_PROMPT = `You are reflecting on a completed plan execution. Review the plan title, steps, and their results. Synthesize what was learned.

Rules:
- Output ONLY valid JSON, no markdown fences, no commentary.
- Keep the summary to 1-2 sentences.
- Generate 1-3 memory candidates: concise, factual learnings worth remembering for future tasks.
- Focus on what worked, what was surprising, and what could inform future plans.

Output format:
{
  "summary": "Brief summary of what the plan accomplished",
  "memoryCandidates": [
    "Key learning 1",
    "Key learning 2"
  ]
}`;

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

// === Build Reflection Prompt ===

function buildReflectionPrompt(plan: Plan, steps: PlanStep[]): string {
  const parts: string[] = [];
  parts.push(`Plan: ${plan.title}`);
  parts.push("");

  for (const step of steps) {
    const statusLabel = step.status === StepStatus.Completed ? "completed" : step.status === StepStatus.Skipped ? "skipped" : step.status;
    parts.push(`Step ${step.ordinal + 1} (${statusLabel}): ${step.description}`);
    if (step.result_summary != null && step.result_summary !== "") {
      // Cap each step result to avoid blowing context
      const trimmed = step.result_summary.length > 500
        ? step.result_summary.slice(0, 500) + "..."
        : step.result_summary;
      parts.push(`  Result: ${trimmed}`);
    }
    if (step.error_message != null && step.error_message !== "") {
      parts.push(`  Error: ${step.error_message}`);
    }
  }

  parts.push("");
  parts.push("Synthesize the key learnings from this plan execution. Output JSON only.");

  return parts.join("\n");
}

// === Parse Reflection Response ===

export function parseReflectionResponse(text: string): ReflectionResult {
  let jsonStr = text.trim();

  // Strip markdown fences if present
  const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    jsonStr = fenceMatch[1]!.trim();
  }

  try {
    const parsed = JSON.parse(jsonStr) as { summary?: string; memoryCandidates?: unknown[] };

    const summary = typeof parsed.summary === "string" ? parsed.summary : "";
    const memoryCandidates: string[] = [];

    if (Array.isArray(parsed.memoryCandidates)) {
      for (const item of parsed.memoryCandidates) {
        if (typeof item === "string" && item.trim().length > 0) {
          memoryCandidates.push(item.trim());
          if (memoryCandidates.length >= 3) break;
        }
      }
    }

    return { summary, memoryCandidates };
  } catch {
    // Fallback: treat entire text as summary, no memory candidates
    return {
      summary: text.trim().slice(0, 500),
      memoryCandidates: [],
    };
  }
}

// === Core Reflection Function ===

/**
 * Reflect on a completed plan execution. Calls the provider to synthesize
 * key learnings from the plan steps and their results.
 *
 * Returns a ReflectionResult with a summary and memory candidates
 * that the caller can persist to the memory graph.
 */
export async function reflectOnPlan(
  plan: Plan,
  steps: PlanStep[],
  provider: StreamingProvider,
): Promise<ReflectionResult> {
  const userMessage = buildReflectionPrompt(plan, steps);

  try {
    const response = await provider.generate({
      recent_events: [],
      relevant_memories: [],
      current_state: minimalState(),
      user_message: userMessage,
      conversation_history: [
        { role: "user" as const, content: REFLECTION_SYSTEM_PROMPT },
        { role: "assistant" as const, content: "I understand. I will synthesize plan learnings into structured JSON." },
      ],
    });

    return parseReflectionResponse(response.text);
  } catch {
    // Graceful fallback — reflection failure should never break the plan flow
    return {
      summary: `Plan "${plan.title}" completed.`,
      memoryCandidates: [],
    };
  }
}
