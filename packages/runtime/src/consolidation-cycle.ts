/**
 * Consolidation cycle — the proactive interior's sole maintenance loop.
 *
 * Four phases run in order on each invocation:
 *
 *   orient      — read the current memory index and the recent-activity
 *                 window. Cheap projection over the live graph.
 *   gather      — invoke reflection (its insights become same-cycle
 *                 promotion candidates), rank notable memories, cluster
 *                 episodic candidates by embedding similarity.
 *   consolidate — summarize each cluster via the LLM, form a semantic
 *                 memory, link parents with PartOf edges, tombstone the
 *                 cluster members.
 *   prune       — retention enforcement, decay tombstoning, low-notability
 *                 noise-removal.
 *
 * Each phase has an independent budget (default 15s). When the budget
 * fires, the phase yields partial work and the cycle moves to the next
 * phase. Phase errors are caught and recorded; subsequent phases run.
 *
 * The cycle is the unification of motebit's previously-separate
 * `runHousekeeping` (prune + episodic consolidation) and
 * `proactiveAction:"reflect"` (idle-tick → reflection) paths. See
 * `docs/doctrine/proactive-interior.md` for the doctrine; the migration
 * is documented in the commit history (commits replacing the old paths
 * with shims that delegate here).
 *
 * Re-entry is the caller's responsibility (the runtime gates via the
 * `PresenceController` state machine — refuses to start when not idle).
 * The cycle itself runs to completion; back-to-back cycles are safe but
 * wasteful.
 */

import { EventType, MemoryType, RelationType } from "@motebit/sdk";
import type { MemoryNode } from "@motebit/sdk";
import type { StreamingProvider } from "@motebit/ai-core";
import {
  computeDecayedConfidence,
  clusterBySimilarity,
  rankNotableMemories,
  scoreNode,
  embedText,
  MemoryGraph,
} from "@motebit/memory-graph";
import type { EventStore } from "@motebit/event-log";
import type { StateVectorEngine } from "@motebit/state-vector";
import { MemoryClass } from "@motebit/policy";
import type { MemoryGovernor } from "@motebit/policy";
import type { PrivacyLayer } from "@motebit/privacy-layer";

export const PHASES = ["orient", "gather", "consolidate", "prune"] as const;
export type Phase = (typeof PHASES)[number];

export interface ConsolidationCycleDeps {
  motebitId: string;
  memory: MemoryGraph;
  events: EventStore;
  state: StateVectorEngine;
  memoryGovernor: MemoryGovernor;
  privacy: PrivacyLayer;
  /** Resolve current AI provider (may change over lifetime). null disables
   *  LLM-dependent work in gather + consolidate; prune still runs. */
  getProvider(): StreamingProvider | null;
  /** Optional reflection trigger. The cycle invokes during the gather
   *  phase if provided AND a provider is available. Left optional so the
   *  cycle composes standalone in tests. The runtime supplies
   *  `() => runReflectionSafe(this.reflectionDeps)` at wire-in. */
  performReflection?: () => Promise<void>;
  /** Structured logger — consistent with HousekeepingDeps + ReflectionDeps. */
  logger: { warn(message: string, context?: Record<string, unknown>): void };
}

export interface ConsolidationCycleConfig {
  /** Phases to run, in declared order. Default: every phase. */
  phases?: ReadonlyArray<Phase>;
  /** Per-phase budget in ms before the phase's AbortSignal fires. Default 15_000. */
  phaseBudgetMs?: number;
  /** Optional parent abort signal. Cycle aborts on parent abort. */
  signal?: AbortSignal;
  /** Notability threshold below which an isolated, low-confidence node
   *  becomes a prune candidate. Default 0.05. */
  prunabilityThreshold?: number;
  /** Cosine similarity threshold for episodic clustering. Default 0.6. */
  consolidationClusterThreshold?: number;
  /** Override Date.now for tests. */
  nowMs?: number;
  /** Caller-provided cycle id. The runtime supplies this so the
   *  presence controller and the audit event share an id. Defaults
   *  to a fresh UUID when omitted. */
  cycleId?: string;
  /** Invoked before each phase begins, after the abort budget arms but
   *  before the phase function runs. The runtime wires this to
   *  `PresenceController.advancePhase` so surfaces see the live phase. */
  onPhaseStart?: (phase: Phase, cycleId: string) => void;
}

export interface ConsolidationCycleResult {
  cycleId: string;
  phasesRun: Phase[];
  phasesYielded: Phase[];
  phasesErrored: Array<{ phase: Phase; error: string }>;
  startedAt: number;
  finishedAt: number;
  summary: {
    orientNodes?: number;
    gatherClusters?: number;
    gatherNotable?: number;
    consolidateMerged?: number;
    prunedDecay?: number;
    prunedNotability?: number;
    prunedRetention?: number;
  };
}

interface PhaseContext {
  signal: AbortSignal;
  now: number;
  prunabilityThreshold: number;
  consolidationClusterThreshold: number;
}

interface GatheredState {
  consolidationClusters: MemoryNode[][];
  notableCount: number;
}

const DEFAULT_PHASE_BUDGET_MS = 15_000;
const DEFAULT_PRUNABILITY_THRESHOLD = 0.05;
const DEFAULT_CLUSTER_THRESHOLD = 0.6;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Run the four-phase consolidation cycle once.
 *
 * Always resolves; never throws past the cycle boundary. Per-phase errors
 * land in `result.phasesErrored`; per-phase budget exhaustion lands in
 * `result.phasesYielded`. The cycle emits one `ConsolidationCycleRun`
 * event with the full result payload.
 */
export async function runConsolidationCycle(
  deps: ConsolidationCycleDeps,
  config: ConsolidationCycleConfig = {},
): Promise<ConsolidationCycleResult> {
  const cycleId = config.cycleId ?? crypto.randomUUID();
  const startedAt = config.nowMs ?? Date.now();
  const phases = config.phases ?? PHASES;
  const phaseBudgetMs = config.phaseBudgetMs ?? DEFAULT_PHASE_BUDGET_MS;
  const prunabilityThreshold = config.prunabilityThreshold ?? DEFAULT_PRUNABILITY_THRESHOLD;
  const consolidationClusterThreshold =
    config.consolidationClusterThreshold ?? DEFAULT_CLUSTER_THRESHOLD;

  const result: ConsolidationCycleResult = {
    cycleId,
    phasesRun: [],
    phasesYielded: [],
    phasesErrored: [],
    startedAt,
    finishedAt: startedAt,
    summary: {},
  };

  // Empty memory state passed forward between phases.
  let gathered: GatheredState = { consolidationClusters: [], notableCount: 0 };

  for (const phase of phases) {
    if (config.signal?.aborted) break;

    const { signal, clear } = startPhaseDeadline(phaseBudgetMs, config.signal);
    const ctx: PhaseContext = {
      signal,
      now: config.nowMs ?? Date.now(),
      prunabilityThreshold,
      consolidationClusterThreshold,
    };

    try {
      config.onPhaseStart?.(phase, cycleId);
      switch (phase) {
        case "orient": {
          const out = await orientPhase(deps, ctx);
          result.summary.orientNodes = out.recentNodeCount;
          break;
        }
        case "gather": {
          const out = await gatherPhase(deps, ctx);
          gathered = out;
          result.summary.gatherClusters = out.consolidationClusters.length;
          result.summary.gatherNotable = out.notableCount;
          break;
        }
        case "consolidate": {
          const out = await consolidatePhase(deps, ctx, gathered);
          result.summary.consolidateMerged = out.merged;
          break;
        }
        case "prune": {
          const out = await prunePhase(deps, ctx);
          result.summary.prunedDecay = out.decay;
          result.summary.prunedNotability = out.notability;
          result.summary.prunedRetention = out.retention;
          break;
        }
      }
      result.phasesRun.push(phase);
      if (signal.aborted) result.phasesYielded.push(phase);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      result.phasesErrored.push({ phase, error: message });
      deps.logger.warn("consolidation phase failed", { phase, error: message });
    } finally {
      clear();
    }
  }

  result.finishedAt = Date.now();

  try {
    await deps.events.appendWithClock({
      event_id: crypto.randomUUID(),
      motebit_id: deps.motebitId,
      timestamp: result.finishedAt,
      event_type: EventType.ConsolidationCycleRun,
      payload: {
        cycle_id: cycleId,
        phases_run: result.phasesRun,
        phases_yielded: result.phasesYielded,
        phases_errored: result.phasesErrored,
        started_at: startedAt,
        finished_at: result.finishedAt,
        summary: result.summary,
      },
      tombstoned: false,
    });
  } catch {
    // Audit emission is best-effort.
  }

  return result;
}

// ── Phase implementations ────────────────────────────────────────

async function orientPhase(
  deps: ConsolidationCycleDeps,
  ctx: PhaseContext,
): Promise<{ recentNodeCount: number }> {
  const { nodes } = await deps.memory.exportAll();
  if (ctx.signal.aborted) return { recentNodeCount: 0 };
  const cutoff = ctx.now - 7 * MS_PER_DAY;
  const recent = nodes.filter(
    (n) => !n.tombstoned && (n.last_accessed > cutoff || n.pinned || n.confidence > 0.8),
  );
  return { recentNodeCount: recent.length };
}

async function gatherPhase(
  deps: ConsolidationCycleDeps,
  ctx: PhaseContext,
): Promise<GatheredState> {
  // Reflection FIRST — its semantic insights become same-cycle promotion
  // candidates in consolidate. Skip when no provider or no callback wired.
  if (deps.performReflection && deps.getProvider() && !ctx.signal.aborted) {
    try {
      await deps.performReflection();
    } catch (err: unknown) {
      deps.logger.warn("reflection failed inside gather phase", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  if (ctx.signal.aborted) return { consolidationClusters: [], notableCount: 0 };

  const { nodes, edges } = await deps.memory.exportAll();
  const live = nodes.filter((n) => !n.tombstoned);

  const notable = rankNotableMemories(live, edges, { nowMs: ctx.now });

  const candidates = live.filter((n) => {
    if (n.pinned) return false;
    if (n.memory_type !== MemoryType.Episodic) return false;
    const elapsed = ctx.now - n.created_at;
    return elapsed > n.half_life * 0.5;
  });
  const clusters =
    candidates.length >= 2
      ? clusterBySimilarity(candidates, ctx.consolidationClusterThreshold)
      : [];

  return { consolidationClusters: clusters, notableCount: notable.length };
}

async function consolidatePhase(
  deps: ConsolidationCycleDeps,
  ctx: PhaseContext,
  gathered: GatheredState,
): Promise<{ merged: number }> {
  const provider = deps.getProvider();
  if (!provider) return { merged: 0 };

  let merged = 0;
  for (const cluster of gathered.consolidationClusters) {
    if (ctx.signal.aborted) break;
    if (cluster.length < 2) continue;

    const head = cluster[0];
    if (!head) continue;

    const contents = cluster.map((n) => `- ${n.content}`).join("\n");
    const prompt = `Summarize the following episodic observations into a single factual statement:\n${contents}\n\nRespond with ONLY the summary sentence.`;

    try {
      const response = await provider.generate({
        recent_events: [],
        relevant_memories: [],
        current_state: deps.state.getState(),
        user_message: prompt,
      });
      const summary = response.text.trim();
      if (summary.length < 5) continue;

      const avgConf = cluster.reduce((sum, n) => sum + n.confidence, 0) / cluster.length;
      const newConf = Math.min(1.0, avgConf + 0.1);
      const candidate = {
        content: summary,
        confidence: newConf,
        sensitivity: head.sensitivity,
        memory_type: MemoryType.Semantic,
      };
      const [decision] = deps.memoryGovernor.evaluate([candidate]);
      if (decision && decision.memoryClass === MemoryClass.REJECTED) continue;

      const embedding = await embedText(summary);
      const synthesized = await deps.memory.formMemory(
        candidate,
        embedding,
        MemoryGraph.HALF_LIFE_SEMANTIC,
      );

      for (const sourceNode of cluster) {
        await deps.memory.link(synthesized.node_id, sourceNode.node_id, RelationType.PartOf);
      }
      for (const sourceNode of cluster) {
        await deps.memory.deleteMemory(sourceNode.node_id);
      }
      merged++;
    } catch {
      // Per-cluster best-effort — never fail the phase on one bad summary.
    }
  }
  return { merged };
}

async function prunePhase(
  deps: ConsolidationCycleDeps,
  ctx: PhaseContext,
): Promise<{ decay: number; notability: number; retention: number }> {
  const { nodes, edges } = await deps.memory.exportAll();
  const threshold = deps.memoryGovernor.getConfig().persistenceThreshold;

  const edgeCounts = new Map<string, number>();
  for (const e of edges) {
    edgeCounts.set(e.source_id, (edgeCounts.get(e.source_id) ?? 0) + 1);
    edgeCounts.set(e.target_id, (edgeCounts.get(e.target_id) ?? 0) + 1);
  }

  let decay = 0;
  let retention = 0;
  let notability = 0;

  for (const node of nodes) {
    if (ctx.signal.aborted) break;
    if (node.tombstoned) continue;
    if (node.pinned) continue;

    const retentionRules = deps.privacy.getRetentionRules(node.sensitivity);
    if (retentionRules.max_retention_days !== Infinity) {
      const ageMs = ctx.now - node.created_at;
      const maxMs = retentionRules.max_retention_days * MS_PER_DAY;
      if (ageMs > maxMs) {
        await deps.privacy.deleteMemory(node.node_id, "retention_enforcement");
        retention++;
        continue;
      }
    }

    const elapsed = ctx.now - node.created_at;
    const decayed = computeDecayedConfidence(node.confidence, node.half_life, elapsed);
    if (decayed < threshold) {
      await deps.memory.deleteMemory(node.node_id);
      decay++;
      continue;
    }

    const edgeCount = edgeCounts.get(node.node_id) ?? 0;
    const score = scoreNode(node, edgeCount, false, decayed);
    const overall = Math.max(score.phantom, score.conflict, score.decay);
    if (overall < ctx.prunabilityThreshold && decayed < 0.3 && edgeCount === 0) {
      await deps.memory.deleteMemory(node.node_id);
      notability++;
    }
  }

  return { decay, notability, retention };
}

// ── Budget machinery ─────────────────────────────────────────────

/**
 * Combine a per-phase deadline with an optional parent signal into a
 * single AbortSignal that fires when either trips. Pattern matches
 * `submitAndPollDelegation`'s use in invoke-capability.ts.
 */
function startPhaseDeadline(
  budgetMs: number,
  parent?: AbortSignal,
): { signal: AbortSignal; clear: () => void } {
  const ctrl = new AbortController();
  const timer = setTimeout(() => {
    if (!ctrl.signal.aborted) ctrl.abort(new Error("phase budget exceeded"));
  }, budgetMs);
  let parentListener: (() => void) | null = null;
  if (parent) {
    if (parent.aborted) {
      ctrl.abort(parent.reason);
      clearTimeout(timer);
    } else {
      parentListener = () => ctrl.abort(parent.reason);
      parent.addEventListener("abort", parentListener);
    }
  }
  return {
    signal: ctrl.signal,
    clear: () => {
      clearTimeout(timer);
      // Removing the parent listener even on `{ once: true }`-style use
      // matters when the parent signal outlives this phase (long-lived
      // caller-supplied signals). Prevents listener accumulation.
      if (parent && parentListener) parent.removeEventListener("abort", parentListener);
    },
  };
}
