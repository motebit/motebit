/**
 * Reflection engine — full pipeline: LLM call → insight storage → event log.
 *
 * This is the integration layer that wires the raw reflection capability
 * into the runtime's memory, event, and state systems. The engine handles
 * side effects; the conversation/plan modules are pure.
 */

import { SensitivityLevel, EventType } from "@motebit/sdk";
import type { ConversationMessage } from "@motebit/sdk";
import type {
  StreamingProvider,
  TaskRouter,
  ReflectionResult,
  PastReflection,
} from "@motebit/ai-core";
import { reflect } from "@motebit/ai-core";
import { embedText, auditMemoryGraph } from "@motebit/memory-graph";
import type { MemoryGraph, MemoryAuditResult } from "@motebit/memory-graph";
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

  // Query past reflections for trajectory — the creature sees its own reflection history
  const pastReflections = await loadPastReflections(deps, 5);

  // Run memory audit — surface phantom certainties, conflicts, near-death nodes
  const auditSummary = buildAuditSummary(recentMemories.nodes, recentMemories.edges);

  const result = await reflect(
    summary,
    deps.getConversationHistory(),
    goals ?? [],
    memories,
    provider,
    deps.getTaskRouter() ?? undefined,
    pastReflections.length > 0 ? pastReflections : undefined,
    auditSummary,
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

  // Store detected patterns as high-confidence memories — these are the trajectory
  // Patterns are recurring observations across multiple reflections, so they
  // deserve higher confidence than single-session insights (0.85 vs 0.7).
  for (const pattern of result.patterns) {
    try {
      const candidate = {
        content: `[pattern] ${pattern}`,
        confidence: 0.85,
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
        patterns_count: result.patterns.length,
        self_assessment_preview: result.selfAssessment.slice(0, 100),
        // Full reflection data for persistence across restarts
        insights: result.insights,
        plan_adjustments: result.planAdjustments,
        patterns: result.patterns,
        self_assessment: result.selfAssessment,
      },
      tombstoned: false,
    });
  } catch {
    // Audit logging is best-effort
  }
}

/**
 * Load past reflection results from the event log for trajectory analysis.
 * Returns most recent first, capped at `limit`.
 */
async function loadPastReflections(deps: ReflectionDeps, limit: number): Promise<PastReflection[]> {
  try {
    const events = await deps.events.query({
      motebit_id: deps.motebitId,
      event_types: [EventType.ReflectionCompleted],
      limit,
    });

    return events
      .filter((e) => Array.isArray(e.payload.insights) || Array.isArray(e.payload.plan_adjustments))
      .map((e) => ({
        timestamp: e.timestamp,
        insights: (e.payload.insights as string[] | undefined) ?? [],
        planAdjustments: (e.payload.plan_adjustments as string[] | undefined) ?? [],
        selfAssessment: (e.payload.self_assessment as string | undefined) ?? "",
      }));
  } catch {
    return [];
  }
}

/**
 * Run auditMemoryGraph and format the result as a concise text summary.
 * Best-effort: returns undefined if the audit fails or finds nothing notable.
 */
function buildAuditSummary(
  nodes: Parameters<typeof auditMemoryGraph>[0],
  edges: Parameters<typeof auditMemoryGraph>[1],
): string | undefined {
  try {
    const audit = auditMemoryGraph(nodes, edges);
    return formatAuditSummary(audit);
  } catch {
    return undefined;
  }
}

/**
 * Format a MemoryAuditResult into a concise text summary for the LLM prompt.
 * Returns undefined if nothing notable was found.
 */
export function formatAuditSummary(audit: MemoryAuditResult): string | undefined {
  const lines: string[] = [];

  if (audit.phantomCertainties.length > 0) {
    lines.push(
      `Phantom certainties (${audit.phantomCertainties.length} beliefs held with high confidence but little corroboration):`,
    );
    for (const p of audit.phantomCertainties.slice(0, 5)) {
      lines.push(
        `- "${p.node.content.slice(0, 120)}" (confidence: ${p.decayedConfidence.toFixed(2)}, edges: ${p.edgeCount})`,
      );
    }
  }

  if (audit.conflicts.length > 0) {
    lines.push(`Contradictions (${audit.conflicts.length} pairs of conflicting memories):`);
    for (const c of audit.conflicts.slice(0, 5)) {
      lines.push(`- "${c.a.content.slice(0, 80)}" vs "${c.b.content.slice(0, 80)}"`);
    }
  }

  if (audit.nearDeath.length > 0) {
    lines.push(`Fading memories (${audit.nearDeath.length} memories near expiry):`);
    for (const nd of audit.nearDeath.slice(0, 3)) {
      lines.push(
        `- "${nd.node.content.slice(0, 120)}" (confidence: ${nd.decayedConfidence.toFixed(2)})`,
      );
    }
  }

  if (lines.length === 0) return undefined;

  lines.unshift(`Memory audit of ${audit.nodesAudited} nodes found issues:`);
  return lines.join("\n");
}
