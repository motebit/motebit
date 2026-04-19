/**
 * Reflection engine — full pipeline: LLM call → insight storage → event log.
 *
 * This is the integration layer that wires the raw reflection capability
 * into the runtime's memory, event, and state systems. The engine handles
 * side effects; the conversation/plan modules are pure.
 */

import { EventType, SensitivityLevel, MemoryType } from "@motebit/sdk";
import type { ConversationMessage } from "@motebit/sdk";
import type {
  StreamingProvider,
  TaskRouter,
  ReflectionResult,
  PastReflection,
} from "@motebit/ai-core";
import { reflect } from "@motebit/ai-core";
import {
  embedText,
  textSimilarity,
  cosineSimilarity,
  detectReflectionPatterns,
  rankNotableMemories,
  formatNotabilitySummary,
} from "@motebit/memory-graph";
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

  // Query past reflections for trajectory — the creature sees its own reflection history
  const pastReflections = await loadPastReflections(deps, 5);

  // Run memory audit — surface phantom certainties, conflicts, near-death nodes
  const auditSummary = buildAuditSummary(recentMemories.nodes, recentMemories.edges);

  // Use summary when available to keep reflection context bounded.
  // Raw history is only needed when no summary exists (short conversations).
  const history = deps.getConversationHistory();
  const boundedHistory = summary ? history.slice(-4) : history;

  const result = await reflect(
    summary,
    boundedHistory,
    goals ?? [],
    memories,
    provider,
    deps.getTaskRouter() ?? undefined,
    pastReflections.length > 0 ? pastReflections : undefined,
    auditSummary,
  );

  // Selective persistence: store high-signal insights as semantic memories.
  // Generic self-talk stays in the event log only. High-signal insights
  // reference concrete entities, pass a novelty check, and aren't repeated.
  void persistHighSignalInsights(deps, result.insights, pastReflections);

  void logReflectionCompleted(deps, result);

  // Single state pulse: reflection completed → brief confidence + warmth spike
  const cur = deps.state.getState();
  deps.state.pushUpdate({
    confidence: Math.min(1, cur.confidence + 0.15),
    affect_valence: Math.min(1, cur.affect_valence + 0.1),
  });

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
 * Build the reflection audit summary using the single-ranking notability
 * primitive from `@motebit/memory-graph`.
 *
 * The old shape (three separate hand-sorted categories) is gone. Notability
 * is one algebraic query over the memory graph under `NotabilitySemiring`;
 * swap weights (phantomWeight/conflictWeight/decayWeight) to change what
 * the creature reflects on. Drift gate #29 keeps this pattern honest.
 *
 * Best-effort: returns undefined if scoring throws or nothing ranks.
 */
function buildAuditSummary(
  nodes: Parameters<typeof rankNotableMemories>[0],
  edges: Parameters<typeof rankNotableMemories>[1],
): string | undefined {
  try {
    const ranked = rankNotableMemories(nodes, edges, { limit: 10 });
    return formatNotabilitySummary(ranked);
  } catch {
    return undefined;
  }
}

// === Selective Persistence ===

/** Half-life for reflection-sourced memories: 7 days (shorter than semantic default). */
const REFLECTION_HALF_LIFE = 7 * 24 * 60 * 60 * 1000;

/** Minimum insight length to be considered concrete (very short = too generic). */
const MIN_INSIGHT_LENGTH = 25;

/** Maximum cosine similarity to existing memories before considered redundant. */
const NOVELTY_THRESHOLD = 0.8;

/** Maximum text similarity to past reflection insights before considered repeated. */
const REPETITION_THRESHOLD = 0.7;

/** Confidence assigned to reflection-sourced memories (moderate — can be reinforced). */
const REFLECTION_CONFIDENCE = 0.6;

/**
 * Heuristic: does this insight reference concrete entities rather than being
 * pure self-talk? Checks for proper nouns, quoted terms, numbers, or
 * specific capability/tool names.
 */
export function isConcreteInsight(insight: string): boolean {
  if (insight.length < MIN_INSIGHT_LENGTH) return false;

  // Quoted terms: "something specific"
  if (/".+?"/.test(insight) || /'.+?'/.test(insight)) return true;

  // Numbers, percentages, measurements
  if (/\d{2,}|\d+%|\d+\.\d/.test(insight)) return true;

  // Capitalized words not at sentence start (proper nouns / specific references)
  // Split into sentences, check words after the first position
  const words = insight.split(/\s+/);
  for (let i = 1; i < words.length; i++) {
    const w = words[i]!;
    if (
      /^[A-Z][a-z]{2,}/.test(w) &&
      !/^(The|This|That|These|Those|When|Where|What|How|Why|But|And|Also|However|Instead|Although|Because|Since|After|Before|During|While|With|Without|About|Into|From|They|Their|Then|Than|Some|Most|Each|Every|Both|Either|Neither|Should|Would|Could|Being|Having|Using|Making)$/.test(
        w,
      )
    ) {
      return true;
    }
  }

  // Technical terms: snake_case, camelCase, or dot.notation
  if (/[a-z][A-Z]|[a-z]_[a-z]|[a-z]\.[a-z]/.test(insight)) return true;

  return false;
}

/**
 * Persist high-signal insights as semantic memories.
 * Best-effort — failures are swallowed to avoid crashing the runtime.
 *
 * Filtering pipeline:
 * 1. Concrete entity check (heuristic, no I/O)
 * 2. Not repeated in past reflections (text similarity)
 * 3. Novel relative to existing memories (embedding cosine similarity)
 * 4. Pass through MemoryGovernor (injection defense, sensitivity)
 */
async function persistHighSignalInsights(
  deps: ReflectionDeps,
  insights: string[],
  pastReflections: PastReflection[],
): Promise<number> {
  if (insights.length === 0) return 0;

  let persisted = 0;

  try {
    // Collect past insight strings for repetition check
    const patterns = detectReflectionPatterns(pastReflections);
    const patternTexts = patterns.map((p) => p.description);

    for (const insight of insights) {
      // 1. Concrete entity check
      if (!isConcreteInsight(insight)) continue;

      // 2. Not repeated in past reflection patterns
      const isRepeated = patternTexts.some(
        (p) => textSimilarity(insight, p) >= REPETITION_THRESHOLD,
      );
      if (isRepeated) continue;

      // 3. Novelty check against existing memories
      let embedding: number[];
      try {
        embedding = await embedText(insight);
      } catch {
        continue; // Embedding unavailable — skip rather than crash
      }

      const similar = await deps.memory.recallRelevant(embedding, { limit: 3 });
      const tooSimilar = similar.some(
        (n) => cosineSimilarity(embedding, n.embedding) >= NOVELTY_THRESHOLD,
      );
      if (tooSimilar) continue;

      // 4. Form memory through governor
      const candidate = {
        content: insight,
        confidence: REFLECTION_CONFIDENCE,
        sensitivity: SensitivityLevel.None,
        memory_type: MemoryType.Semantic,
      };

      const [decision] = deps.memoryGovernor.evaluate([candidate]);
      if (!decision || decision.memoryClass === MemoryClass.REJECTED) continue;

      await deps.memory.formMemory(decision.candidate, embedding, REFLECTION_HALF_LIFE);
      persisted++;
    }
  } catch {
    // Persistence is best-effort — don't crash the runtime
  }

  return persisted;
}
