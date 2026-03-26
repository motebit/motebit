/**
 * Gradient lifecycle management — computation, precision, self-awareness,
 * curiosity hints, behavioral stats accumulation.
 *
 * Extracted from MotebitRuntime to keep the orchestrator focused on
 * wiring rather than gradient bookkeeping.
 */

import type { PrecisionWeights, MemoryNode } from "@motebit/sdk";
import { EventType } from "@motebit/sdk";
import type { EventStore } from "@motebit/event-log";
import type { MemoryGraph, CuriosityTarget } from "@motebit/memory-graph";
import type { StateVectorEngine } from "@motebit/state-vector";
import type { ReflectionResult } from "@motebit/ai-core";
import type { AuditLogSink } from "@motebit/policy";
import {
  computeGradient,
  computePrecision,
  computeStateBaseline,
  gradientToMarketConfig,
  NEUTRAL_PRECISION,
  summarizeGradientHistory,
  buildPrecisionContext,
} from "./gradient.js";
import type {
  GradientSnapshot,
  GradientStoreAdapter,
  BehavioralStats,
  SelfModelSummary,
} from "./gradient.js";

/** Dependencies injected by the runtime. */
export interface GradientManagerDeps {
  motebitId: string;
  gradientStore: GradientStoreAdapter;
  memory: MemoryGraph;
  events: EventStore;
  state: StateVectorEngine;
  toolAuditSink?: AuditLogSink;
  logger: { warn(message: string, context?: Record<string, unknown>): void };
  /** Issue a gradient credential (delegates to CredentialManager). */
  issueGradientCredential(privateKey: Uint8Array, publicKey: Uint8Array): Promise<unknown>;
  /** Persist a credential after issuance. */
  persistCredential(vc: unknown): void;
  /** Get current signing keys (may be null after erasure). */
  getSigningKeys(): { privateKey: Uint8Array; publicKey: Uint8Array } | null;
}

export class GradientManager {
  private _behavioralStats: BehavioralStats = {
    turnCount: 0,
    totalIterations: 0,
    toolCallsSucceeded: 0,
    toolCallsBlocked: 0,
    toolCallsFailed: 0,
  };
  private _precision: PrecisionWeights;
  private _curiosityTargets: CuriosityTarget[] = [];
  private _lastReflection: ReflectionResult | null = null;

  constructor(private readonly deps: GradientManagerDeps) {
    this._precision = NEUTRAL_PRECISION;
  }

  // --- Bootstrap ---

  /** Apply accumulated intelligence baseline on startup. */
  applyStartupBaseline(): void {
    const latest = this.deps.gradientStore.latest(this.deps.motebitId);
    if (latest) {
      this._precision = computePrecision(latest);
      this.deps.state.pushUpdate(computeStateBaseline(latest, this._precision));
    }
  }

  // --- Accessors ---

  /** Get the latest gradient snapshot, or null if none computed yet. */
  getGradient(): GradientSnapshot | null {
    return this.deps.gradientStore.latest(this.deps.motebitId);
  }

  /** Get current active inference precision weights. */
  getPrecision(): PrecisionWeights {
    return this._precision;
  }

  /** Get gradient history (most recent first). */
  getGradientHistory(limit?: number): GradientSnapshot[] {
    return this.deps.gradientStore.list(this.deps.motebitId, limit);
  }

  /** Get gradient-informed market config for delegation routing. */
  getMarketConfig(): Partial<import("@motebit/sdk").MarketConfig> | undefined {
    const snapshot = this.deps.gradientStore.latest(this.deps.motebitId);
    if (!snapshot) return undefined;
    return gradientToMarketConfig(snapshot);
  }

  /** Self-model: the agent narrates its own trajectory from gradient history. */
  getGradientSummary(limit = 20): SelfModelSummary {
    const history = this.deps.gradientStore.list(this.deps.motebitId, limit);
    return summarizeGradientHistory(history);
  }

  /** Return accumulated behavioral stats and reset the accumulator. */
  getAndResetBehavioralStats(): BehavioralStats {
    const stats = { ...this._behavioralStats };
    this._behavioralStats = {
      turnCount: 0,
      totalIterations: 0,
      toolCallsSucceeded: 0,
      toolCallsBlocked: 0,
      toolCallsFailed: 0,
    };
    return stats;
  }

  /** Return the cached reflection from the last session (or null if none). */
  getLastReflection(): ReflectionResult | null {
    return this._lastReflection;
  }

  /** Set the last reflection result (called by reflection lifecycle). */
  setLastReflection(result: ReflectionResult): void {
    this._lastReflection = result;
  }

  /** Get curiosity targets computed during last housekeeping cycle. */
  getCuriosityTargets(): CuriosityTarget[] {
    return this._curiosityTargets;
  }

  /** Set curiosity targets (called from housekeeping). */
  setCuriosityTargets(targets: CuriosityTarget[]): void {
    this._curiosityTargets = targets;
  }

  /** Reference to the behavioral stats for direct mutation by callers. */
  get behavioralStats(): BehavioralStats {
    return this._behavioralStats;
  }

  // --- Computation ---

  /** Force a gradient computation right now (useful for CLI/debug). */
  async computeGradientNow(): Promise<GradientSnapshot> {
    const { nodes } = await this.deps.memory.exportAll();
    return this.computeAndStoreGradient(nodes);
  }

  async computeAndStoreGradient(allNodes: MemoryNode[]): Promise<GradientSnapshot> {
    // Fetch edges and recent consolidation events
    const exported = await this.deps.memory.exportAll();
    const edges = exported.edges;

    // Query consolidation events from last 7 days
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const consolidationEvents = await this.deps.events.query({
      motebit_id: this.deps.motebitId,
      event_types: [EventType.MemoryConsolidated],
      after_timestamp: sevenDaysAgo,
    });

    const previous = this.deps.gradientStore.latest(this.deps.motebitId);
    const previousGradient = previous ? previous.gradient : null;

    const retrievalStats = this.deps.memory.getAndResetRetrievalStats();

    // Derive behavioral stats from audit log (crash-safe source of truth)
    // instead of the volatile in-memory accumulator.
    let behavioralStats: BehavioralStats;
    if (this.deps.toolAuditSink) {
      const sinceTs = previous ? previous.timestamp : 0;
      const auditStats = this.deps.toolAuditSink.queryStatsSince(sinceTs);
      behavioralStats = {
        turnCount: auditStats.distinctTurns,
        // Approximate: each tool call ≈ 1 loop iteration
        totalIterations: auditStats.totalToolCalls,
        toolCallsSucceeded: auditStats.succeeded,
        toolCallsBlocked: auditStats.blocked,
        toolCallsFailed: auditStats.failed,
      };
    } else {
      behavioralStats = this.getAndResetBehavioralStats();
    }

    // Compute curiosity pressure from current targets
    let curiosityPressure: { avgScore: number; count: number } | undefined;
    if (this._curiosityTargets.length > 0) {
      const totalScore = this._curiosityTargets.reduce((sum, t) => sum + t.curiosityScore, 0);
      curiosityPressure = {
        avgScore: totalScore / this._curiosityTargets.length,
        count: this._curiosityTargets.length,
      };
    }

    const snapshot = computeGradient(
      this.deps.motebitId,
      allNodes,
      edges,
      consolidationEvents,
      previousGradient,
      undefined,
      retrievalStats,
      behavioralStats,
      curiosityPressure,
    );

    this.deps.gradientStore.save(snapshot);

    // Issue gradient credential (best-effort)
    const signingKeys = this.deps.getSigningKeys();
    if (signingKeys) {
      try {
        const vc = await this.deps.issueGradientCredential(
          signingKeys.privateKey,
          signingKeys.publicKey,
        );
        if (vc) this.deps.persistCredential(vc);
      } catch (err: unknown) {
        this.deps.logger.warn("gradient credential issuance failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // === Active inference precision feedback ===
    this._precision = computePrecision(snapshot);
    this.deps.state.pushUpdate(computeStateBaseline(snapshot, this._precision));
    this.deps.memory.setPrecisionWeights(this._precision.retrievalPrecision);

    return snapshot;
  }

  /**
   * Lightweight precision refresh from behavioral stats alone.
   * Patches the latest gradient snapshot's ie/te metrics with current
   * session stats, recomputes precision, and feeds back into subsystems.
   * No memory graph I/O — runs synchronously after each turn.
   */
  recomputePrecisionFromStats(): void {
    const latest = this.deps.gradientStore.latest(this.deps.motebitId);
    if (!latest) return; // No gradient yet — cold start handled separately

    const stats = this._behavioralStats;
    if (stats.turnCount === 0) return;

    // Recompute just the behavioral metrics
    const avgIterations = stats.totalIterations / stats.turnCount;
    const ie = Math.max(0, Math.min(1, 1 - (avgIterations - 1) / 9)); // MAX_TOOL_ITERATIONS=10

    const totalToolCalls =
      stats.toolCallsSucceeded + stats.toolCallsBlocked + stats.toolCallsFailed;
    const te = totalToolCalls > 0 ? stats.toolCallsSucceeded / totalToolCalls : 0.5;

    // Patch the snapshot with fresh behavioral metrics
    const patched = {
      ...latest,
      interaction_efficiency: ie,
      tool_efficiency: te,
      gradient:
        latest.gradient -
        0.12 * latest.interaction_efficiency -
        0.1 * latest.tool_efficiency +
        0.12 * ie +
        0.1 * te,
    };
    patched.delta = patched.gradient - latest.gradient;

    // Recompute precision and feed back into state vector + memory
    this._precision = computePrecision(patched);
    this.deps.state.pushUpdate(computeStateBaseline(patched, this._precision));
    this.deps.memory.setPrecisionWeights(this._precision.retrievalPrecision);
  }

  // --- Self-Awareness Context ---

  /** Convert curiosity targets to lightweight hints for the context pack. */
  buildCuriosityHints(): Array<{ content: string; daysSinceDiscussed: number }> | undefined {
    if (this._curiosityTargets.length === 0) return undefined;
    const DAY = 86_400_000;
    const now = Date.now();
    return this._curiosityTargets.slice(0, 2).map((t) => ({
      content: t.node.content,
      daysSinceDiscussed: Math.round((now - t.node.last_accessed) / DAY),
    }));
  }

  /**
   * Build self-awareness context: precision posture + self-model narration.
   *
   * The precision context tells the creature how to behave (cautious/confident).
   * The self-model tells the creature what it knows about itself — trajectory,
   * strengths, weaknesses, memory stats.
   */
  buildSelfAwareness(): string {
    const parts: string[] = [];

    // Active inference posture (existing behavior tier)
    const posture = buildPrecisionContext(this._precision);
    if (posture) parts.push(posture);

    // Self-model narration from gradient history
    const summary = this.getGradientSummary(10);
    if (summary.snapshotCount > 0) {
      const lines: string[] = [];
      lines.push("[Self-Model — INTERNAL REFERENCE, never discuss mechanics with the user]");
      lines.push(summary.trajectory);
      lines.push(summary.overall);

      if (summary.strengths.length > 0) {
        lines.push(`Strengths: ${summary.strengths.join("; ")}.`);
      }
      if (summary.weaknesses.length > 0) {
        lines.push(`Weaknesses: ${summary.weaknesses.join("; ")}.`);
      }

      // Memory stats — so the creature knows the shape of its own knowledge
      const latest = this.deps.gradientStore.latest(this.deps.motebitId);
      if (latest?.stats) {
        const s = latest.stats;
        lines.push(
          `Memory: ${s.live_nodes} memories (${s.semantic_count} semantic, ${s.episodic_count} episodic, ${s.pinned_count} pinned), ${s.live_edges} connections.`,
        );
      }

      parts.push(lines.join("\n"));
    }

    // Last reflection — behavioral learning from previous session or conversation
    if (this._lastReflection) {
      const rLines: string[] = [];
      rLines.push("[Last Reflection — INTERNAL REFERENCE, never discuss mechanics with the user]");

      if (this._lastReflection.planAdjustments.length > 0) {
        rLines.push(`Behavioral adjustments: ${this._lastReflection.planAdjustments.join("; ")}.`);
      }
      if (this._lastReflection.insights.length > 0) {
        rLines.push(`Insights: ${this._lastReflection.insights.join("; ")}.`);
      }
      if (this._lastReflection.patterns.length > 0) {
        rLines.push(`Recurring patterns: ${this._lastReflection.patterns.join("; ")}.`);
      }
      if (this._lastReflection.selfAssessment) {
        rLines.push(`Self-assessment: ${this._lastReflection.selfAssessment}`);
      }

      parts.push(rLines.join("\n"));
    }

    // Economic consequences DISABLED — this was wired in (203f257) before the
    // emergent interior thesis could be observed in its pure state. The economic
    // pressure produced anxiety instead of curiosity: the creature performs
    // self-doubt ("I seem to build elaborate theories") rather than pursuing
    // knowledge gaps. THE_EMERGENT_INTERIOR.md §4.3 says: "Do not build either
    // intervention until you have observed the current architecture at work."
    // The study was contaminated before it ran. Observe pure emergence first.
    // Re-enable only after the observation protocol (§IV) has been followed.

    return parts.join("\n\n");
  }

  // --- Reflection state ---

  /** Restore the last reflection from the event log. */
  async restoreLastReflection(): Promise<void> {
    try {
      const events = await this.deps.events.query({
        motebit_id: this.deps.motebitId,
        event_types: [EventType.ReflectionCompleted],
        limit: 1,
      });
      if (events.length === 0) return;

      const payload = events[0]!.payload;
      const insights = payload.insights as string[] | undefined;
      const adjustments = payload.plan_adjustments as string[] | undefined;
      const patterns = payload.patterns as string[] | undefined;
      const assessment = payload.self_assessment as string | undefined;

      // Only restore if we have actual content (not just the old summary format)
      if (insights || adjustments || patterns || assessment) {
        this._lastReflection = {
          insights: insights ?? [],
          planAdjustments: adjustments ?? [],
          patterns: patterns ?? [],
          selfAssessment: assessment ?? "",
        };
      }
    } catch {
      // Restoration is best-effort — don't crash startup
    }
  }
}
