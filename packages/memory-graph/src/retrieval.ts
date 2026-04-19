/**
 * Semiring-driven memory retrieval — the endgame pattern for how motebit
 * recalls. Same memory graph, five named lenses, one algorithm under
 * different semirings. Mirrors the agent-network pattern in
 * `@motebit/semiring/src/agent-network.ts`: each lens is a thin
 * projection over `optimalPathTrace` (or `optimalPaths` for the
 * boolean reachability lens) from `@motebit/protocol`.
 *
 * Five lenses:
 *   - recallRelevant          (ReliabilitySemiring) — drop-in for the
 *                              retired `retrieve()` method: similarity +
 *                              confidence + recency + 1-hop expansion
 *   - recallConfidentChain    (MaxProductLogSemiring) — "why do I
 *                              believe X" — most-confident reasoning
 *                              chain from a seed
 *   - recallShortestProvenance(CostSemiring) — shortest chain
 *                              connecting two memories
 *   - recallReachable         (BooleanSemiring) — set of nodes
 *                              reachable within maxDepth
 *   - recallFuzzyCluster      (BottleneckSemiring) — cluster connected
 *                              via "strongest weakest link"
 *
 * This module exposes the semiring-backed primitives as pure helpers:
 * they take a `MemoryStorageAdapter` + motebit id rather than a class
 * instance. The `MemoryGraph` class in `./index.ts` calls them from its
 * recall* methods, owning instance-state concerns (scoring weights,
 * gradient accumulator, Hebbian linking). This keeps the primitives
 * pure and the storage-adapter boundary narrow.
 */

import type {
  MemoryNode,
  MemoryEdge,
  MemoryStorageAdapter,
  RelationType,
  SensitivityLevel,
} from "@motebit/sdk";
import { RelationType as RT } from "@motebit/sdk";
import type { Semiring } from "@motebit/protocol";
import {
  BooleanSemiring,
  BottleneckSemiring,
  CostSemiring,
  MaxProductLogSemiring,
  ReliabilitySemiring,
  WeightedDigraph,
  optimalPaths,
  optimalPathTrace,
} from "@motebit/protocol";

// ── Shared types ─────────────────────────────────────────────────────

export interface RecallRelevantOptions {
  minConfidence?: number;
  sensitivityFilter?: SensitivityLevel[];
  limit?: number;
  scoringConfig?: {
    similarityWeight?: number;
    confidenceWeight?: number;
    recencyWeight?: number;
    recencyHalfLife?: number;
    overFetchRatio?: number;
  };
  /** Expand via graph edges (1-hop). Default true. */
  expandEdges?: boolean;
  /** Discount factor for edge-expanded neighbors. Default 0.7. */
  edgeDiscountFactor?: number;
  /** Include memories past valid_until. Default false. */
  includeExpired?: boolean;
}

export interface ChainResult<T> {
  /** Node IDs along the path, seed first. Empty if no reachable target. */
  readonly path: string[];
  /** The semiring value of the chain. */
  readonly value: T;
  /** Hydrated node objects for each path entry. */
  readonly nodes: MemoryNode[];
}

export interface ConfidentChainOptions {
  /** Restrict traversal to specific relation types. Default: all non-conflicting. */
  followRelations?: readonly RelationType[];
  /** Include tombstoned/expired nodes. Default false. */
  includeInvalid?: boolean;
}

export interface ReachableOptions {
  /** Max hops from seed. Default 3. */
  maxDepth?: number;
  /** Relation types that count as reachability edges. Default: all. */
  followRelations?: readonly RelationType[];
}

// ── Relation-aware edge weighting ────────────────────────────────────

/**
 * Multiplier applied to edge weights based on relation type.
 * Product judgment, not algebra: `ConflictsWith` edges don't contribute
 * to confidence chains; `Supersedes` edges are attenuated since memory
 * edges are symmetric for traversal and the supersession semantics are
 * directional. Every other type preserves its stored weight.
 */
export function relationTypeMultiplier(type: RelationType): number {
  switch (type) {
    case RT.ConflictsWith:
      return 0;
    case RT.Supersedes:
      return 0.1;
    default:
      return 1;
  }
}

// ── Pure helpers: dotProduct, decayed confidence, weight normalization ──

export function dotProduct(a: readonly number[], b: readonly number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i]! * b[i]!;
  return sum;
}

export function decayedConfidence(initial: number, halfLife: number, elapsedMs: number): number {
  if (halfLife <= 0) return initial;
  return initial * Math.pow(0.5, elapsedMs / halfLife);
}

export function normalizeScoringWeights(
  similarity: number,
  confidence: number,
  recency: number,
): { similarity: number; confidence: number; recency: number } {
  const sum = similarity + confidence + recency;
  if (sum === 0) return { similarity: 1 / 3, confidence: 1 / 3, recency: 1 / 3 };
  return {
    similarity: similarity / sum,
    confidence: confidence / sum,
    recency: recency / sum,
  };
}

// ── Core primitive: build a WeightedDigraph over the memory store ───

/**
 * Materialize the memory graph as a `WeightedDigraph<T>` under a chosen
 * semiring. Used by every lens that does graph traversal. The adapter
 * loads nodes + edges from the storage layer and projects edge weights
 * through the caller-supplied `edgeWeight` function.
 *
 * Symmetric by default: each edge contributes both directions. Memory
 * relations are bidirectional for traversal; directional semantics are
 * handled by the caller via `edgeWeight(edge, fromNode)` asymmetry.
 */
export async function buildMemoryDigraph<T>(
  storage: MemoryStorageAdapter,
  motebitId: string,
  semiring: Semiring<T>,
  edgeWeight: (edge: MemoryEdge, fromNode: string) => T,
  options: {
    nodeFilter?: (node: MemoryNode) => boolean;
    followRelations?: readonly RelationType[];
  } = {},
): Promise<{ digraph: WeightedDigraph<T>; nodesById: Map<string, MemoryNode> }> {
  const { nodeFilter, followRelations } = options;

  const digraph = new WeightedDigraph(semiring);
  const nodesById = new Map<string, MemoryNode>();

  const allNodes = await storage.queryNodes({ motebit_id: motebitId });
  for (const node of allNodes) {
    if (nodeFilter && !nodeFilter(node)) continue;
    digraph.addNode(node.node_id);
    nodesById.set(node.node_id, node);
  }

  for (const [nodeId] of nodesById) {
    const edges = await storage.getEdges(nodeId);
    for (const edge of edges) {
      if (followRelations && !followRelations.includes(edge.relation_type)) continue;
      if (!nodesById.has(edge.source_id) || !nodesById.has(edge.target_id)) continue;
      const forward = edgeWeight(edge, edge.source_id);
      const backward = edgeWeight(edge, edge.target_id);
      digraph.addEdge(edge.source_id, edge.target_id, forward);
      digraph.addEdge(edge.target_id, edge.source_id, backward);
    }
  }

  return { digraph, nodesById };
}

// ── Lens: recallRelevant (core logic, pure) ─────────────────────────
// Drop-in for `retrieve()`: weighted filter + semantic rerank + 1-hop
// edge expansion under ReliabilitySemiring (max-×). Pure over the
// storage adapter; instance-state concerns (precision override,
// gradient accumulator, Hebbian linking) live on the MemoryGraph class
// and wrap this call.

const DEFAULT_RECENCY_HALF_LIFE = 24 * 60 * 60 * 1000;
const DEFAULT_OVER_FETCH = 5;

export interface ResolvedScoringConfig {
  similarityWeight: number;
  confidenceWeight: number;
  recencyWeight: number;
  recencyHalfLife: number;
  overFetchRatio: number;
}

export async function recallRelevantCore(params: {
  storage: MemoryStorageAdapter;
  motebitId: string;
  queryEmbedding: number[];
  baseScoring: ResolvedScoringConfig;
  options?: RecallRelevantOptions;
}): Promise<{ nodes: MemoryNode[]; similarityScores: number[] }> {
  const { storage, motebitId, queryEmbedding, baseScoring, options = {} } = params;
  const {
    minConfidence = 0.1,
    sensitivityFilter,
    limit = 10,
    scoringConfig: perCall,
    expandEdges = true,
    edgeDiscountFactor = 0.7,
    includeExpired = false,
  } = options;

  const config = perCall ? { ...baseScoring, ...perCall } : baseScoring;
  const weights = normalizeScoringWeights(
    config.similarityWeight ?? 0.5,
    config.confidenceWeight ?? 0.3,
    config.recencyWeight ?? 0.2,
  );
  const overFetchRatio = config.overFetchRatio ?? DEFAULT_OVER_FETCH;
  const recencyHalfLife = config.recencyHalfLife ?? DEFAULT_RECENCY_HALF_LIFE;

  const candidates = await storage.queryNodes({
    motebit_id: motebitId,
    min_confidence: minConfidence,
    sensitivity_filter: sensitivityFilter,
    limit: limit * overFetchRatio,
  });

  const now = Date.now();
  const afterExpiry = includeExpired
    ? candidates
    : candidates.filter((n) => n.valid_until == null || n.valid_until > now);

  const scored = afterExpiry.map((node) => {
    const similarity = dotProduct(queryEmbedding, node.embedding);
    const decayed = decayedConfidence(node.confidence, node.half_life, now - node.created_at);
    const recencyBoost = Math.pow(0.5, (now - node.last_accessed) / recencyHalfLife);
    const score =
      similarity * weights.similarity +
      decayed * weights.confidence +
      recencyBoost * weights.recency;
    return { node, score, similarity };
  });

  scored.sort((a, b) => b.score - a.score);
  let topResults = scored.slice(0, limit);
  const similarityScores = topResults.map((r) => r.similarity);

  // 1-hop edge expansion under ReliabilitySemiring (max-×).
  // Edge weight = edgeDiscountFactor × edge.weight × edge.confidence ×
  // relationTypeMultiplier. Conflicts contribute 0 → annihilate.
  if (expandEdges && topResults.length > 0) {
    const resultIds = new Set(topResults.map((r) => r.node.node_id));
    for (const { node: parent, score: parentScore } of [...topResults]) {
      const edges = await storage.getEdges(parent.node_id);
      for (const edge of edges) {
        const neighborId = edge.source_id === parent.node_id ? edge.target_id : edge.source_id;
        if (resultIds.has(neighborId)) continue;
        const neighbor = await storage.getNode(neighborId);
        if (!neighbor || neighbor.tombstoned) continue;
        if (sensitivityFilter && !sensitivityFilter.includes(neighbor.sensitivity)) continue;
        if (!includeExpired && neighbor.valid_until != null && neighbor.valid_until <= now)
          continue;
        const multiplier = relationTypeMultiplier(edge.relation_type);
        const neighborScore = ReliabilitySemiring.mul(
          parentScore,
          edgeDiscountFactor * edge.weight * edge.confidence * multiplier,
        );
        topResults.push({
          node: neighbor,
          score: neighborScore,
          similarity: dotProduct(queryEmbedding, neighbor.embedding),
        });
        resultIds.add(neighborId);
      }
    }
    topResults.sort((a, b) => b.score - a.score);
    topResults = topResults.slice(0, limit);
  }

  return {
    nodes: topResults.map((s) => s.node),
    similarityScores,
  };
}

// ── Lens: recallConfidentChain ───────────────────────────────────────

const DEFAULT_CONFIDENT_FOLLOW: readonly RelationType[] = [
  RT.Related,
  RT.Reinforces,
  RT.CausedBy,
  RT.FollowedBy,
  RT.PartOf,
  RT.Supersedes,
];

export async function recallConfidentChain(
  storage: MemoryStorageAdapter,
  motebitId: string,
  seedId: string,
  targetId: string | null,
  options: ConfidentChainOptions = {},
): Promise<ChainResult<number> | null> {
  const { followRelations = DEFAULT_CONFIDENT_FOLLOW, includeInvalid = false } = options;
  const now = Date.now();
  const { digraph, nodesById } = await buildMemoryDigraph(
    storage,
    motebitId,
    MaxProductLogSemiring,
    (edge) => {
      const mult = relationTypeMultiplier(edge.relation_type);
      const linear = edge.weight * edge.confidence * mult;
      return linear > 0 ? Math.log(linear) : MaxProductLogSemiring.zero;
    },
    {
      followRelations,
      nodeFilter: (n) =>
        includeInvalid || (!n.tombstoned && (n.valid_until == null || n.valid_until > now)),
    },
  );

  if (!nodesById.has(seedId)) return null;
  if (targetId != null && !nodesById.has(targetId)) return null;

  if (targetId != null) {
    const trace = optimalPathTrace(digraph, seedId, targetId);
    if (!trace) return null;
    return {
      path: trace.path,
      value: trace.value,
      nodes: trace.path.map((id) => nodesById.get(id)!),
    };
  }

  // No target: return the best outgoing chain.
  const distances = optimalPaths(digraph, seedId);
  let bestTarget: string | null = null;
  let bestValue = MaxProductLogSemiring.zero;
  for (const [nodeId, value] of distances) {
    if (nodeId === seedId) continue;
    if (value > bestValue) {
      bestValue = value;
      bestTarget = nodeId;
    }
  }
  if (!bestTarget) return null;
  const trace = optimalPathTrace(digraph, seedId, bestTarget);
  if (!trace) return null;
  return {
    path: trace.path,
    value: trace.value,
    nodes: trace.path.map((id) => nodesById.get(id)!),
  };
}

// ── Lens: recallShortestProvenance ──────────────────────────────────

export async function recallShortestProvenance(
  storage: MemoryStorageAdapter,
  motebitId: string,
  seedId: string,
  targetId: string,
  options: { includeInvalid?: boolean } = {},
): Promise<ChainResult<number> | null> {
  const { includeInvalid = false } = options;
  const now = Date.now();
  const { digraph, nodesById } = await buildMemoryDigraph(
    storage,
    motebitId,
    CostSemiring,
    (edge) => (relationTypeMultiplier(edge.relation_type) > 0 ? 1 : CostSemiring.zero),
    {
      nodeFilter: (n) =>
        includeInvalid || (!n.tombstoned && (n.valid_until == null || n.valid_until > now)),
    },
  );

  if (!nodesById.has(seedId) || !nodesById.has(targetId)) return null;
  const trace = optimalPathTrace(digraph, seedId, targetId);
  if (!trace) return null;
  return {
    path: trace.path,
    value: trace.value,
    nodes: trace.path.map((id) => nodesById.get(id)!),
  };
}

// ── Lens: recallReachable ───────────────────────────────────────────

export async function recallReachable(
  storage: MemoryStorageAdapter,
  motebitId: string,
  seedId: string,
  options: ReachableOptions = {},
): Promise<Set<string>> {
  const { maxDepth = 3, followRelations } = options;
  const now = Date.now();
  const { digraph, nodesById } = await buildMemoryDigraph(
    storage,
    motebitId,
    BooleanSemiring,
    (edge) => (relationTypeMultiplier(edge.relation_type) > 0 ? true : BooleanSemiring.zero),
    {
      followRelations,
      nodeFilter: (n) => !n.tombstoned && (n.valid_until == null || n.valid_until > now),
    },
  );

  if (!nodesById.has(seedId)) return new Set();

  // BFS bounded by maxDepth. Reachability is a Boolean-semiring query
  // under the hood, but depth-bounded traversal is a simpler expression.
  const reached = new Set<string>([seedId]);
  let frontier = new Set<string>([seedId]);
  for (let depth = 0; depth < maxDepth; depth++) {
    const next = new Set<string>();
    for (const id of frontier) {
      for (const [neighbor] of digraph.neighbors(id)) {
        if (!reached.has(neighbor)) {
          reached.add(neighbor);
          next.add(neighbor);
        }
      }
    }
    if (next.size === 0) break;
    frontier = next;
  }
  reached.delete(seedId);
  return reached;
}

// ── Lens: recallFuzzyCluster ────────────────────────────────────────

export async function recallFuzzyCluster(
  storage: MemoryStorageAdapter,
  motebitId: string,
  seedId: string,
  options: { minBottleneck?: number } = {},
): Promise<Array<{ nodeId: string; bottleneck: number; node: MemoryNode }>> {
  const { minBottleneck = 0 } = options;
  const now = Date.now();
  const { digraph, nodesById } = await buildMemoryDigraph(
    storage,
    motebitId,
    BottleneckSemiring,
    (edge) => edge.weight * edge.confidence * relationTypeMultiplier(edge.relation_type),
    {
      nodeFilter: (n) => !n.tombstoned && (n.valid_until == null || n.valid_until > now),
    },
  );

  if (!nodesById.has(seedId)) return [];
  const distances = optimalPaths(digraph, seedId);
  const results: Array<{ nodeId: string; bottleneck: number; node: MemoryNode }> = [];
  for (const [nodeId, bottleneck] of distances) {
    if (nodeId === seedId) continue;
    if (bottleneck <= minBottleneck) continue;
    results.push({ nodeId, bottleneck, node: nodesById.get(nodeId)! });
  }
  results.sort((a, b) => b.bottleneck - a.bottleneck);
  return results;
}
