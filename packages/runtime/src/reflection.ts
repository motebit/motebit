/**
 * Reflection engine — agent self-assessment, insight storage, and audit logging.
 *
 * Extracted from MotebitRuntime. The agent reviews its conversation performance,
 * extracts insights, stores them as memories, and logs the reflection event.
 */

import { SensitivityLevel, EventType } from "@motebit/sdk";
import type { ConversationMessage } from "@motebit/sdk";
import type { ReflectionResult, StreamingProvider, TaskRouter } from "@motebit/ai-core";
import { reflect as aiReflect } from "@motebit/ai-core";
import { embedText } from "@motebit/memory-graph";
import type { MemoryGraph } from "@motebit/memory-graph";
import type { EventStore } from "@motebit/event-log";
import type { StateVectorEngine } from "@motebit/state-vector";
import { MemoryClass } from "@motebit/policy";
import type { MemoryGovernor } from "@motebit/policy";

/** Dependencies injected by the runtime. */
export interface ReflectionDeps {
  motebitId: string;
  memory: MemoryGraph;
  events: EventStore;
  state: StateVectorEngine;
  memoryGovernor: MemoryGovernor;
  /** Resolve current AI provider (may change over lifetime). */
  getProvider(): StreamingProvider | null;
  /** Resolve current task router (may change over lifetime). */
  getTaskRouter(): TaskRouter | null;
  /** Get conversation summary from the conversation manager. */
  getConversationSummary(): string | null;
  /** Get current conversation history. */
  getConversationHistory(): ConversationMessage[];
}

/**
 * Trigger a reflection on the current conversation.
 * The agent reviews its performance, learns insights, and stores them as memories.
 */
export async function performReflection(
  deps: ReflectionDeps,
  goals?: Array<{ description: string; status: string }>,
): Promise<ReflectionResult> {
  const provider = deps.getProvider();
  if (!provider) throw new Error("No AI provider configured");

  const summary = deps.getConversationSummary();

  const recentMemories = await deps.memory.exportAll();
  const memories = recentMemories.nodes.slice(0, 10).map((n) => ({ content: n.content }));

  const result = await aiReflect(
    summary,
    deps.getConversationHistory(),
    goals ?? [],
    memories,
    provider,
    deps.getTaskRouter() ?? undefined,
  );

  // Store insights and plan adjustments as memories
  await storeReflectionInsights(deps, result);

  // Audit: log that reflection occurred
  void logReflectionCompleted(deps, result);

  return result;
}

/** Best-effort reflection — swallows errors to avoid crashing the runtime. */
export async function runReflectionSafe(deps: ReflectionDeps): Promise<void> {
  try {
    await performReflection(deps);
  } catch {
    // Reflection is best-effort — don't crash the runtime
  }
}

async function storeReflectionInsights(
  deps: ReflectionDeps,
  result: ReflectionResult,
): Promise<void> {
  for (const insight of result.insights) {
    try {
      const candidate = {
        content: `[reflection] ${insight}`,
        confidence: 0.7,
        sensitivity: SensitivityLevel.None,
      };
      const [decision] = deps.memoryGovernor.evaluate([candidate]);
      if (decision && decision.memoryClass === MemoryClass.REJECTED) {
        continue;
      }
      const embedding = await embedText(candidate.content);
      await deps.memory.formMemory(candidate, embedding);
      // Memory formed — brief confidence + warmth spike visible through glass
      const cur = deps.state.getState();
      deps.state.pushUpdate({
        confidence: Math.min(1, cur.confidence + 0.2),
        affect_valence: Math.min(1, cur.affect_valence + 0.15),
      });
    } catch {
      // Memory formation is best-effort during reflection
    }
  }

  // Store plan adjustments as memories — behavioral learnings for future planning
  for (const adjustment of result.planAdjustments) {
    try {
      const candidate = {
        content: `[plan_adjustment] ${adjustment}`,
        confidence: 0.6,
        sensitivity: SensitivityLevel.None,
      };
      const [decision] = deps.memoryGovernor.evaluate([candidate]);
      if (decision && decision.memoryClass === MemoryClass.REJECTED) {
        continue;
      }
      const embedding = await embedText(candidate.content);
      await deps.memory.formMemory(candidate, embedding);
    } catch {
      // Memory formation is best-effort during reflection
    }
  }
}

async function logReflectionCompleted(
  deps: ReflectionDeps,
  result: ReflectionResult,
): Promise<void> {
  try {
    await deps.events.appendWithClock({
      event_id: crypto.randomUUID(),
      motebit_id: deps.motebitId,
      timestamp: Date.now(),
      event_type: EventType.ReflectionCompleted,
      payload: {
        source: "runtime_reflect",
        insights_count: result.insights.length,
        adjustments_count: result.planAdjustments.length,
        self_assessment_preview: result.selfAssessment.slice(0, 100),
      },
      tombstoned: false,
    });
  } catch {
    // Audit logging is best-effort
  }
}
