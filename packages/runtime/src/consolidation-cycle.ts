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

import { EventType, MemoryType, RelationType, SensitivityLevel } from "@motebit/sdk";
import type {
  MemoryNode,
  ConversationStoreAdapter,
  AuditLogSink,
  ToolAuditEntry,
} from "@motebit/sdk";
import type { StreamingProvider } from "@motebit/ai-core";
import {
  computeDecayedConfidence,
  clusterBySimilarity,
  findCuriosityTargets,
  rankNotableMemories,
  scoreNode,
  embedText,
  MemoryGraph,
} from "@motebit/memory-graph";
import type { CuriosityTarget } from "@motebit/memory-graph";
import type { EventStore } from "@motebit/event-log";
import type { StateVectorEngine } from "@motebit/state-vector";
import { MemoryClass } from "@motebit/policy";
import type { MemoryGovernor } from "@motebit/policy";
import type { PrivacyLayer } from "@motebit/privacy-layer";

export const PHASES = ["orient", "gather", "consolidate", "prune", "flush"] as const;
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
  /** Optional curiosity-target sink. The cycle computes curiosity targets
   *  during the gather phase (`findCuriosityTargets` over live nodes) and
   *  pushes them through this callback. Left optional so the cycle composes
   *  standalone in tests. The runtime supplies
   *  `(targets) => this.gradientManager.setCuriosityTargets(targets)` at
   *  wire-in. */
  setCuriosityTargets?: (targets: CuriosityTarget[]) => void;
  /** Optional periodic gradient recompute. Invoked once per cycle after
   *  the phase loop completes, with the post-prune live nodes. Left
   *  optional so the cycle composes standalone in tests. The runtime
   *  supplies `(nodes) => this.gradientManager.computeAndStoreGradient(nodes)`
   *  at wire-in — making the cycle the single proactive path that keeps
   *  the gradient fresh during long idle periods. */
  computeAndStoreGradient?: (nodes: MemoryNode[]) => Promise<void>;
  /**
   * Conversation store registered under the `consolidation_flush`
   * retention shape per docs/doctrine/retention-policy.md
   * §"Consolidation flush". Optional — when omitted (or when the
   * adapter doesn't implement `enumerateForFlush`/`eraseMessage`), the
   * flush phase is a no-op for this store.
   */
  conversationStore?: ConversationStoreAdapter | null;
  /**
   * Tool-audit sink registered under `consolidation_flush`. Optional;
   * same composition rules as `conversationStore`. The settlement-floor
   * resolver for tool-audit per decision 3 lives at `toolAuditObligationFloorMs`.
   */
  toolAuditSink?: AuditLogSink | null;
  /**
   * Settlement-floor resolver for tool-audit records per
   * docs/doctrine/retention-policy.md §"Decision 3". Returns the
   * minimum-retention floor in milliseconds for a given record. The
   * flush phase computes `max(sensitivity_floor, obligation_floor)`
   * and skips records whose age has not yet exceeded both. Default
   * implementation returns 0 (no obligation) — concrete obligations
   * (settlement window, dispute window, regulatory floor) plug in
   * here. Pure function of the record; no I/O.
   */
  toolAuditObligationFloorMs?: (entry: ToolAuditEntry) => number;
  /**
   * Default sensitivity stamped on records that are missing the field
   * at flush time per docs/doctrine/retention-policy.md §"Decision 6b"
   * (lazy-classify-on-flush). Mirrors the operator manifest's
   * `pre_classification_default_sensitivity`. Defaults to `personal`
   * when omitted.
   */
  preClassificationDefaultSensitivity?: SensitivityLevel;
  /** Structured logger — consistent with ReflectionDeps. */
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
    gatherCuriosityTargets?: number;
    consolidateMerged?: number;
    prunedDecay?: number;
    prunedNotability?: number;
    prunedRetention?: number;
    flushedConversations?: number;
    flushedToolAudits?: number;
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
  curiosityTargets: CuriosityTarget[];
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
  let gathered: GatheredState = {
    consolidationClusters: [],
    notableCount: 0,
    curiosityTargets: [],
  };

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
          result.summary.gatherCuriosityTargets = out.curiosityTargets.length;
          // Push curiosity targets to the gradient consumer if wired.
          // Done outside the phase function to keep the phase pure (the
          // phase computes; the cycle orchestrates side effects), and
          // outside the phase's try/catch so a sink failure doesn't get
          // attributed to the gather phase itself.
          if (deps.setCuriosityTargets) {
            try {
              deps.setCuriosityTargets(out.curiosityTargets);
            } catch (err: unknown) {
              deps.logger.warn("setCuriosityTargets sink failed", {
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }
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
        case "flush": {
          const out = await flushPhase(deps, ctx);
          result.summary.flushedConversations = out.flushedConversations;
          result.summary.flushedToolAudits = out.flushedToolAudits;
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

  // Post-phase: recompute the intelligence gradient with the post-prune
  // live nodes. This is the only path that keeps the gradient fresh
  // during long idle periods — interactive turns trigger gradient at
  // turn-5 reflection + cold start, neither of which fires when the
  // motebit isn't being talked to. Best-effort; a recompute failure
  // never throws past the cycle boundary.
  if (deps.computeAndStoreGradient && !config.signal?.aborted) {
    try {
      const { nodes } = await deps.memory.exportAll();
      await deps.computeAndStoreGradient(nodes);
    } catch (err: unknown) {
      deps.logger.warn("gradient recompute failed", {
        error: err instanceof Error ? err.message : String(err),
      });
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
  const empty: GatheredState = {
    consolidationClusters: [],
    notableCount: 0,
    curiosityTargets: [],
  };
  if (ctx.signal.aborted) return empty;

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

  // Curiosity targets — decaying high-value memories worth asking about.
  // Pure read over the live nodes already in hand; cheap, no I/O. Pinned
  // and tombstoned nodes filter inside `findCuriosityTargets` itself, so
  // we hand it the same `live` set the rest of gather uses.
  const curiosityTargets = findCuriosityTargets(live.filter((n) => !n.pinned));

  return {
    consolidationClusters: clusters,
    notableCount: notable.length,
    curiosityTargets,
  };
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
        // `self_enforcement` not `retention_enforcement`: the subject's
        // own runtime is driving the policy here (the consolidation
        // cycle on the user's device, signing with the motebit's
        // identity key). `retention_enforcement` is reserved for the
        // operator-driven path where the relay key signs. See decision
        // 5 of docs/doctrine/retention-policy.md.
        await deps.privacy.deleteMemory(node.node_id, "self_enforcement");
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

/**
 * Flush phase — `consolidation_flush` retention shape per
 * docs/doctrine/retention-policy.md §"Consolidation flush". Iterates
 * the conversation store and tool-audit sink for records past
 * `max(sensitivity_floor, obligation_floor)`, lazy-classifies on read
 * per decision 6b when the field is missing, signs a
 * `consolidation_flush` cert per arm, then erases the row.
 *
 * Sibling to `prunePhase` for memory: same retention-floor calculation
 * pattern, same `self_enforcement` / `retention_enforcement_post_classification`
 * reason discipline (decision 5), same fail-soft per-record discipline
 * (one bad row never stops the phase).
 */
async function flushPhase(
  deps: ConsolidationCycleDeps,
  ctx: PhaseContext,
): Promise<{ flushedConversations: number; flushedToolAudits: number }> {
  const defaultSensitivity = deps.preClassificationDefaultSensitivity ?? SensitivityLevel.Personal;

  let flushedConversations = 0;
  let flushedToolAudits = 0;

  // Conversations — sensitivity floor only; no obligation floor on
  // conversation messages (the obligation discipline applies to the
  // tool-audit register per decision 3).
  if (deps.conversationStore?.enumerateForFlush && deps.conversationStore.eraseMessage) {
    // Enumerate windows-back-the-longest-sensitivity-floor: any record
    // older than the loosest ceiling is a candidate; tighter ceilings
    // narrow inside the loop.
    const longestFloorMs =
      Math.max(...Object.values(REFERENCE_FLUSH_DAYS).filter((d) => d !== Infinity)) * MS_PER_DAY;
    const cutoffTs = ctx.now - longestFloorMs;
    const candidates = deps.conversationStore.enumerateForFlush(deps.motebitId, cutoffTs);
    for (const candidate of candidates) {
      if (ctx.signal.aborted) break;
      const recordSensitivity = candidate.sensitivity ?? defaultSensitivity;
      const lazyClassified = candidate.sensitivity === undefined;
      const floorDays = REFERENCE_FLUSH_DAYS[recordSensitivity];
      if (floorDays === Infinity) continue;
      const ageMs = ctx.now - candidate.createdAt;
      if (ageMs <= floorDays * MS_PER_DAY) continue;

      try {
        await deps.privacy.signFlushCert({
          targetKind: "conversation_message",
          targetId: candidate.messageId,
          sensitivity: recordSensitivity,
          reason: lazyClassified ? "retention_enforcement_post_classification" : "self_enforcement",
        });
        deps.conversationStore.eraseMessage(candidate.messageId);
        flushedConversations++;
      } catch (err: unknown) {
        deps.logger.warn("flush phase: conversation_message erase failed", {
          messageId: candidate.messageId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  // Tool-audit — sensitivity floor max obligation floor per decision 3.
  if (deps.toolAuditSink?.enumerateForFlush && deps.toolAuditSink.erase) {
    const longestFloorMs =
      Math.max(...Object.values(REFERENCE_FLUSH_DAYS).filter((d) => d !== Infinity)) * MS_PER_DAY;
    const cutoffTs = ctx.now - longestFloorMs;
    const candidates = deps.toolAuditSink.enumerateForFlush(cutoffTs);
    const obligationFloorMs = deps.toolAuditObligationFloorMs ?? (() => 0);
    for (const candidate of candidates) {
      if (ctx.signal.aborted) break;
      const recordSensitivity = candidate.sensitivity ?? defaultSensitivity;
      const lazyClassified = candidate.sensitivity === undefined;
      const floorDays = REFERENCE_FLUSH_DAYS[recordSensitivity];
      const sensitivityFloorMs = floorDays === Infinity ? Infinity : floorDays * MS_PER_DAY;
      const obligationMs = obligationFloorMs(candidate);
      const effectiveFloorMs = Math.max(sensitivityFloorMs, obligationMs);
      if (effectiveFloorMs === Infinity) continue;
      const ageMs = ctx.now - candidate.timestamp;
      if (ageMs <= effectiveFloorMs) continue;

      try {
        await deps.privacy.signFlushCert({
          targetKind: "tool_audit",
          targetId: candidate.callId,
          sensitivity: recordSensitivity,
          reason: lazyClassified ? "retention_enforcement_post_classification" : "self_enforcement",
        });
        deps.toolAuditSink.erase(candidate.callId);
        flushedToolAudits++;
      } catch (err: unknown) {
        deps.logger.warn("flush phase: tool_audit erase failed", {
          callId: candidate.callId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  return { flushedConversations, flushedToolAudits };
}

/**
 * Reference flush ceilings, in days, per sensitivity tier. Mirrors
 * `REFERENCE_RETENTION_DAYS_BY_SENSITIVITY` in `@motebit/protocol` —
 * inlined here because runtime depends on @motebit/sdk, not directly
 * on @motebit/protocol. The values are reference defaults
 * (`docs/doctrine/retention-policy.md` §"Decision 2"); operators MAY
 * ship a stricter policy (lower numbers) and remain interop-compliant.
 */
const REFERENCE_FLUSH_DAYS: Record<SensitivityLevel, number> = {
  [SensitivityLevel.None]: Infinity,
  [SensitivityLevel.Personal]: 365,
  [SensitivityLevel.Medical]: 90,
  [SensitivityLevel.Financial]: 90,
  [SensitivityLevel.Secret]: 30,
};

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
