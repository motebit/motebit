/**
 * Notability — ranking memories worth reflecting on, expressed as an
 * algebraic query composed from protocol-layer semiring primitives.
 *
 * This is the second semiring consumer in the codebase. Retrieval was the
 * first (`retrieval.ts`, traversal under path semirings). Notability does
 * not traverse — it scores each live node by a record-shaped composition
 * of three independent signals and ranks top-K under the composed score.
 *
 * Three dimensions, each a scalar in [0, 1]:
 *   - phantom  — high decayed confidence, weak graph support (isolated belief)
 *   - conflict — connected to a contradicting memory via a ConflictsWith edge
 *   - decay    — confidence decayed close to zero; about to be pruned
 *
 * The dimensions compose via `recordSemiring` over `TrustSemiring` (max-times).
 * Multiple evidence contributions to the same dimension aggregate by `add`
 * (pointwise max); compound chains could aggregate by `mul` (pointwise
 * product) if a future traversal consumer needs it. Today we use the
 * semiring's structure for the type and the reduction, not for paths — but
 * the abstraction is load-bearing: change the composition, change what
 * "notable" means.
 *
 * This file is the single canonical home for notability scoring. Drift gate
 * #29 (`check-notability-primitives.ts`) enforces that apps and services
 * cannot reinvent the weighted combination elsewhere.
 */

import type { MemoryNode, MemoryEdge } from "@motebit/sdk";
import { RelationType as RT } from "@motebit/sdk";
import { recordSemiring, TrustSemiring } from "@motebit/protocol";
import type { Semiring } from "@motebit/protocol";
import { computeDecayedConfidence } from "./index.js";

/**
 * Record-shaped notability score. Each field is a TrustSemiring element
 * (max-times, [0,1]). The overall "how notable" reduction is the max of
 * the three fields — whichever axis dominates is the reason to reflect.
 */
export interface NotabilityScore {
  readonly phantom: number;
  readonly conflict: number;
  readonly decay: number;
}

/**
 * The composed semiring. Exported so future traversal consumers (e.g. a
 * notability-propagation lens over the memory graph) can reuse the same
 * algebraic shape. `add` is pointwise max across contributing evidence;
 * `mul` is pointwise product for chain composition.
 */
export const NotabilitySemiring: Semiring<NotabilityScore> = recordSemiring({
  phantom: TrustSemiring,
  conflict: TrustSemiring,
  decay: TrustSemiring,
});

export type NotabilityReason = "phantom" | "conflict" | "decay";

export interface NotableMemory {
  readonly node: MemoryNode;
  readonly score: NotabilityScore;
  /** max(phantom, conflict, decay) — the semiring-reduced scalar. */
  readonly overall: number;
  /** The axis that dominated; drives the prompt-summary phrasing. */
  readonly dominantReason: NotabilityReason;
  readonly decayedConfidence: number;
  readonly edgeCount: number;
  /** Populated when dominantReason === "conflict". */
  readonly conflictPartner?: MemoryNode;
}

export interface NotabilityOptions {
  /** Weight multiplier per dimension (default 1). */
  phantomWeight?: number;
  conflictWeight?: number;
  decayWeight?: number;
  /** Phantom threshold: decayed confidence ≥ this counts (default 0.5). */
  minPhantomConfidence?: number;
  /** Phantom threshold: edge count ≤ this counts (default 1). */
  maxPhantomEdges?: number;
  /** Decay threshold: decayed confidence < this counts as near-death (default 0.15). */
  nearDeathThreshold?: number;
  /** Top-K cap (default 10). */
  limit?: number;
  /** Override `Date.now()` — used in tests. */
  nowMs?: number;
}

interface ResolvedOptions {
  phantomWeight: number;
  conflictWeight: number;
  decayWeight: number;
  minPhantomConfidence: number;
  maxPhantomEdges: number;
  nearDeathThreshold: number;
  limit: number;
  nowMs: number;
}

function resolve(options?: NotabilityOptions): ResolvedOptions {
  return {
    phantomWeight: options?.phantomWeight ?? 1,
    conflictWeight: options?.conflictWeight ?? 1,
    decayWeight: options?.decayWeight ?? 1,
    minPhantomConfidence: options?.minPhantomConfidence ?? 0.5,
    maxPhantomEdges: options?.maxPhantomEdges ?? 1,
    nearDeathThreshold: options?.nearDeathThreshold ?? 0.15,
    limit: options?.limit ?? 10,
    nowMs: options?.nowMs ?? Date.now(),
  };
}

/**
 * Score a single node. Pure, deterministic. Pinned/tombstoned nodes
 * score zero on every axis — they are not candidates for reflection.
 */
export function scoreNode(
  node: MemoryNode,
  edgeCount: number,
  hasConflictPartner: boolean,
  decayedConfidence: number,
  options?: NotabilityOptions,
): NotabilityScore {
  const o = resolve(options);
  if (node.pinned || node.tombstoned) {
    return NotabilitySemiring.zero;
  }

  const phantom =
    decayedConfidence >= o.minPhantomConfidence && edgeCount <= o.maxPhantomEdges
      ? clamp01(o.phantomWeight * decayedConfidence * (1 - edgeCount / (o.maxPhantomEdges + 1)))
      : 0;

  const conflict = hasConflictPartner ? clamp01(o.conflictWeight * decayedConfidence) : 0;

  const decay =
    decayedConfidence > 0 && decayedConfidence < o.nearDeathThreshold
      ? clamp01(o.decayWeight * (1 - decayedConfidence / o.nearDeathThreshold))
      : 0;

  return { phantom, conflict, decay };
}

/**
 * Rank the top-K most notable memories across the supplied graph.
 * Single pass; no I/O; pure.
 */
export function rankNotableMemories(
  nodes: MemoryNode[],
  edges: MemoryEdge[],
  options?: NotabilityOptions,
): NotableMemory[] {
  const o = resolve(options);
  const live = nodes.filter((n) => !n.tombstoned);
  const liveIds = new Set(live.map((n) => n.node_id));
  const nodeMap = new Map(live.map((n) => [n.node_id, n]));

  const edgeCounts = new Map<string, number>();
  const conflictPartners = new Map<string, MemoryNode>();

  for (const edge of edges) {
    const srcLive = liveIds.has(edge.source_id);
    const dstLive = liveIds.has(edge.target_id);
    if (srcLive) edgeCounts.set(edge.source_id, (edgeCounts.get(edge.source_id) ?? 0) + 1);
    if (dstLive) edgeCounts.set(edge.target_id, (edgeCounts.get(edge.target_id) ?? 0) + 1);
    if (edge.relation_type === RT.ConflictsWith && srcLive && dstLive) {
      const a = nodeMap.get(edge.source_id);
      const b = nodeMap.get(edge.target_id);
      if (a && b) {
        if (!conflictPartners.has(a.node_id)) conflictPartners.set(a.node_id, b);
        if (!conflictPartners.has(b.node_id)) conflictPartners.set(b.node_id, a);
      }
    }
  }

  const candidates: NotableMemory[] = [];
  for (const node of live) {
    const decayed = computeDecayedConfidence(
      node.confidence,
      node.half_life,
      o.nowMs - node.created_at,
    );
    const edgeCount = edgeCounts.get(node.node_id) ?? 0;
    const partner = conflictPartners.get(node.node_id);
    const score = scoreNode(node, edgeCount, partner != null, decayed, options);
    const overall = Math.max(score.phantom, score.conflict, score.decay);
    if (overall <= 0) continue;

    const dominantReason: NotabilityReason =
      score.conflict >= score.phantom && score.conflict >= score.decay
        ? "conflict"
        : score.phantom >= score.decay
          ? "phantom"
          : "decay";

    candidates.push({
      node,
      score,
      overall,
      dominantReason,
      decayedConfidence: decayed,
      edgeCount,
      conflictPartner: dominantReason === "conflict" ? partner : undefined,
    });
  }

  candidates.sort((a, b) => b.overall - a.overall);
  return candidates.slice(0, o.limit);
}

/**
 * Format the ranked list as a concise multi-line summary for an LLM
 * reflection prompt. Returns `undefined` when nothing is notable — the
 * caller omits the audit section entirely in that case.
 */
export function formatNotabilitySummary(notable: NotableMemory[]): string | undefined {
  if (notable.length === 0) return undefined;
  const lines: string[] = [`Notable memories this period (ranked):`];
  for (const m of notable) {
    const preview = m.node.content.slice(0, 120);
    const scoreHint = m.overall.toFixed(2);
    switch (m.dominantReason) {
      case "phantom":
        lines.push(
          `- [phantom ${scoreHint}] "${preview}" (confidence ${m.decayedConfidence.toFixed(2)}, edges ${m.edgeCount})`,
        );
        break;
      case "conflict": {
        const partner = m.conflictPartner?.content.slice(0, 80) ?? "unknown";
        lines.push(`- [conflict ${scoreHint}] "${preview}" ⟷ "${partner}"`);
        break;
      }
      case "decay":
        lines.push(
          `- [fading ${scoreHint}] "${preview}" (confidence ${m.decayedConfidence.toFixed(2)})`,
        );
        break;
    }
  }
  return lines.join("\n");
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}
