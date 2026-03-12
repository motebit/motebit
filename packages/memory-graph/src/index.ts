import type {
  MemoryNode,
  MemoryEdge,
  MemoryCandidate,
  SensitivityLevel,
  RelationType,
} from "@motebit/sdk";
import { EventType, MemoryType, RelationType as RT } from "@motebit/sdk";
import { ConsolidationAction } from "./consolidation.js";
import type { ConsolidationProvider, ConsolidationDecision } from "./consolidation.js";
import type { EventStore } from "@motebit/event-log";

export { embedText, embedTextHash, EMBEDDING_DIMENSIONS, resetPipeline } from "./embeddings.js";
export {
  ConsolidationAction,
  buildConsolidationPrompt,
  parseConsolidationResponse,
  clusterBySimilarity,
} from "./consolidation.js";
export type { ConsolidationProvider, ConsolidationDecision } from "./consolidation.js";

// === Scoring Configuration ===

export interface ScoringConfig {
  /** Weight for semantic similarity (cosine). Default 0.5 */
  similarityWeight: number;
  /** Weight for decayed confidence. Default 0.3 */
  confidenceWeight: number;
  /** Weight for recency boost. Default 0.2 */
  recencyWeight: number;
  /** Half-life for recency decay in milliseconds. Default 24h (86400000). Time at which recency boost = 0.5 */
  recencyHalfLife: number;
  /** Over-fetch ratio for candidate retrieval before reranking. Default 5 */
  overFetchRatio: number;
}

const DEFAULT_SCORING_CONFIG: ScoringConfig = {
  similarityWeight: 0.5,
  confidenceWeight: 0.3,
  recencyWeight: 0.2,
  recencyHalfLife: 24 * 60 * 60 * 1000, // 24 hours
  overFetchRatio: 5,
};

/**
 * Normalize scoring weights so they sum to 1.
 * Accepts the three weight fields and returns normalized values.
 */
function normalizeWeights(
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

// === Interfaces ===

export interface MemoryQuery {
  motebit_id: string;
  min_confidence?: number;
  sensitivity_filter?: SensitivityLevel[];
  limit?: number;
  include_tombstoned?: boolean;
  pinned?: boolean;
}

export interface MemoryStorageAdapter {
  saveNode(node: MemoryNode): Promise<void>;
  getNode(nodeId: string): Promise<MemoryNode | null>;
  queryNodes(query: MemoryQuery): Promise<MemoryNode[]>;
  saveEdge(edge: MemoryEdge): Promise<void>;
  getEdges(nodeId: string): Promise<MemoryEdge[]>;
  tombstoneNode(nodeId: string): Promise<void>;
  /** Tombstone with ownership check. Returns true if the node existed and belonged to motebitId. */
  tombstoneNodeOwned?(nodeId: string, motebitId: string): Promise<boolean>;
  pinNode(nodeId: string, pinned: boolean): Promise<void>;
  getAllNodes(motebitId: string): Promise<MemoryNode[]>;
  getAllEdges(motebitId: string): Promise<MemoryEdge[]>;
}

// === Half-Life Decay ===

export function computeDecayedConfidence(
  initialConfidence: number,
  halfLife: number,
  elapsedMs: number,
): number {
  if (halfLife <= 0) return initialConfidence;
  return initialConfidence * Math.pow(0.5, elapsedMs / halfLife);
}

// === Curiosity Targets ===

export interface CuriosityTarget {
  node: MemoryNode;
  decayedConfidence: number;
  confidenceLoss: number;
  staleness: number;
  curiosityScore: number;
}

/**
 * Find high-value memories that are decaying and would benefit from user confirmation.
 * Pure scoring function — no I/O.
 *
 * Score: confidenceLoss × staleness² × node.confidence
 * - confidenceLoss = how much it's faded (initial - decayed)
 * - staleness = elapsed / half_life — how many half-lives since last touch
 * - staleness² = non-linear urgency (under 1 half-life suppressed, over 1 amplified)
 * - node.confidence = value weight — high-confidence memories matter more
 */
export function findCuriosityTargets(
  nodes: MemoryNode[],
  options?: {
    limit?: number;
    minConfidenceLoss?: number;
    maxDecayedConfidence?: number;
    minOriginalConfidence?: number;
  },
): CuriosityTarget[] {
  const {
    limit = 5,
    minConfidenceLoss = 0.15,
    maxDecayedConfidence = 0.7,
    minOriginalConfidence = 0.5,
  } = options ?? {};

  const now = Date.now();
  const results: CuriosityTarget[] = [];

  for (const node of nodes) {
    if (node.tombstoned || node.pinned) continue;
    if (node.confidence < minOriginalConfidence) continue;

    const elapsed = now - node.created_at;
    const decayedConfidence = computeDecayedConfidence(node.confidence, node.half_life, elapsed);

    if (decayedConfidence > maxDecayedConfidence) continue;
    if (decayedConfidence < 0.1) continue;

    const confidenceLoss = node.confidence - decayedConfidence;
    if (confidenceLoss < minConfidenceLoss) continue;

    const staleness = node.half_life > 0 ? (now - node.last_accessed) / node.half_life : 0;
    const curiosityScore = confidenceLoss * staleness * staleness * node.confidence;

    results.push({ node, decayedConfidence, confidenceLoss, staleness, curiosityScore });
  }

  results.sort((a, b) => b.curiosityScore - a.curiosityScore);
  return results.slice(0, limit);
}

// === Cosine Similarity ===

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0;
  return dot / denom;
}

/**
 * Dot product for L2-normalized unit vectors.
 * Equivalent to cosine similarity when both vectors have unit norm,
 * but skips 2 norm accumulations and 2 sqrt calls.
 */
function dotProduct(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    sum += a[i]! * b[i]!;
  }
  return sum;
}

// === In-Memory Adapter ===

export class InMemoryMemoryStorage implements MemoryStorageAdapter {
  private nodes = new Map<string, MemoryNode>();
  private edges = new Map<string, MemoryEdge>();

  saveNode(node: MemoryNode): Promise<void> {
    this.nodes.set(node.node_id, { ...node });
    return Promise.resolve();
  }

  getNode(nodeId: string): Promise<MemoryNode | null> {
    return Promise.resolve(this.nodes.get(nodeId) ?? null);
  }

  queryNodes(query: MemoryQuery): Promise<MemoryNode[]> {
    let results = Array.from(this.nodes.values()).filter((n) => n.motebit_id === query.motebit_id);

    if (query.include_tombstoned !== true) {
      results = results.filter((n) => !n.tombstoned);
    }

    if (query.pinned !== undefined) {
      results = results.filter((n) => n.pinned === query.pinned);
    }

    if (query.min_confidence !== undefined) {
      const now = Date.now();
      results = results.filter((n) => {
        const decayed = computeDecayedConfidence(n.confidence, n.half_life, now - n.created_at);
        return decayed >= query.min_confidence!;
      });
    }

    if (query.sensitivity_filter !== undefined) {
      results = results.filter((n) => query.sensitivity_filter!.includes(n.sensitivity));
    }

    if (query.limit !== undefined) {
      results.sort((a, b) => b.last_accessed - a.last_accessed);
      results = results.slice(0, query.limit);
    }

    return Promise.resolve(results);
  }

  saveEdge(edge: MemoryEdge): Promise<void> {
    this.edges.set(edge.edge_id, { ...edge });
    return Promise.resolve();
  }

  getEdges(nodeId: string): Promise<MemoryEdge[]> {
    return Promise.resolve(
      Array.from(this.edges.values()).filter(
        (e) => e.source_id === nodeId || e.target_id === nodeId,
      ),
    );
  }

  tombstoneNode(nodeId: string): Promise<void> {
    const node = this.nodes.get(nodeId);
    if (node !== undefined) {
      node.tombstoned = true;
    }
    return Promise.resolve();
  }

  pinNode(nodeId: string, pinned: boolean): Promise<void> {
    const node = this.nodes.get(nodeId);
    if (node !== undefined && !node.tombstoned) {
      node.pinned = pinned;
    }
    return Promise.resolve();
  }

  getAllNodes(motebitId: string): Promise<MemoryNode[]> {
    return Promise.resolve(
      Array.from(this.nodes.values()).filter((n) => n.motebit_id === motebitId),
    );
  }

  getAllEdges(motebitId: string): Promise<MemoryEdge[]> {
    const moteNodes = new Set(
      Array.from(this.nodes.values())
        .filter((n) => n.motebit_id === motebitId)
        .map((n) => n.node_id),
    );
    return Promise.resolve(
      Array.from(this.edges.values()).filter(
        (e) => moteNodes.has(e.source_id) || moteNodes.has(e.target_id),
      ),
    );
  }
}

// === Memory Graph Manager ===

export class MemoryGraph {
  private scoringConfig: ScoringConfig;
  private _retrievalScores: number[] = [];

  constructor(
    private storage: MemoryStorageAdapter,
    private eventStore: EventStore,
    private motebitId: string,
    scoringConfig?: Partial<ScoringConfig>,
  ) {
    this.scoringConfig = { ...DEFAULT_SCORING_CONFIG, ...scoringConfig };
  }

  /**
   * Get average retrieval similarity score and count since last read, then reset.
   * Used by housekeeping to feed the intelligence gradient.
   */
  getAndResetRetrievalStats(): { avgScore: number; count: number } {
    if (this._retrievalScores.length === 0) return { avgScore: 0, count: 0 };
    const sum = this._retrievalScores.reduce((a, b) => a + b, 0);
    const result = {
      avgScore: sum / this._retrievalScores.length,
      count: this._retrievalScores.length,
    };
    this._retrievalScores = [];
    return result;
  }

  /** Default half-lives by memory type. */
  static readonly HALF_LIFE_SEMANTIC = 30 * 24 * 60 * 60 * 1000; // 30 days
  static readonly HALF_LIFE_EPISODIC = 3 * 24 * 60 * 60 * 1000; // 3 days
  /** Maximum half-life — reinforced memories stabilize but never exceed 1 year. */
  static readonly MAX_HALF_LIFE = 365 * 24 * 60 * 60 * 1000; // 365 days

  /**
   * Form a new memory from a candidate.
   */
  async formMemory(
    candidate: MemoryCandidate,
    embedding: number[],
    halfLife?: number,
  ): Promise<MemoryNode> {
    const nodeId = crypto.randomUUID();
    const now = Date.now();
    const memoryType = candidate.memory_type ?? MemoryType.Semantic;
    const resolvedHalfLife =
      halfLife ??
      (memoryType === MemoryType.Episodic
        ? MemoryGraph.HALF_LIFE_EPISODIC
        : MemoryGraph.HALF_LIFE_SEMANTIC);

    const node: MemoryNode = {
      node_id: nodeId,
      motebit_id: this.motebitId,
      content: candidate.content,
      embedding,
      confidence: candidate.confidence,
      sensitivity: candidate.sensitivity,
      created_at: now,
      last_accessed: now,
      half_life: resolvedHalfLife,
      tombstoned: false,
      pinned: false,
      memory_type: memoryType,
      valid_from: now,
    };

    await this.storage.saveNode(node);

    const clock = await this.eventStore.getLatestClock(this.motebitId);
    await this.eventStore.append({
      event_id: crypto.randomUUID(),
      motebit_id: this.motebitId,
      timestamp: now,
      event_type: EventType.MemoryFormed,
      payload: { node_id: nodeId, content: candidate.content },
      version_clock: clock + 1,
      tombstoned: false,
    });

    return node;
  }

  /**
   * Link two memories with an edge.
   */
  async link(
    sourceId: string,
    targetId: string,
    relationType: RelationType,
    weight: number = 1.0,
    confidence: number = 1.0,
  ): Promise<MemoryEdge> {
    const edge: MemoryEdge = {
      edge_id: crypto.randomUUID(),
      source_id: sourceId,
      target_id: targetId,
      relation_type: relationType,
      weight,
      confidence,
    };

    await this.storage.saveEdge(edge);
    return edge;
  }

  /**
   * Consolidate-aware memory formation.
   * Checks new candidate against existing similar memories and decides:
   * ADD (new fact), UPDATE (supersedes), REINFORCE (confirms), or NOOP (skip).
   */
  async consolidateAndForm(
    candidate: MemoryCandidate,
    embedding: number[],
    provider: ConsolidationProvider,
    halfLife?: number,
  ): Promise<{ node: MemoryNode | null; decision: ConsolidationDecision }> {
    // Retrieve top-5 similar existing memories
    const similar = await this.retrieve(embedding, { limit: 5 });

    // No similar memories — skip LLM call, fall through to ADD
    if (similar.length === 0) {
      const node = await this.formMemory(candidate, embedding, halfLife);
      return {
        node,
        decision: { action: ConsolidationAction.ADD, reason: "No similar memories found" },
      };
    }

    // Ask provider to classify
    const existing = similar.map((n) => ({
      node_id: n.node_id,
      content: n.content,
      confidence: n.confidence,
    }));
    const decision = await provider.classify(candidate.content, existing);
    const now = Date.now();

    switch (decision.action) {
      case ConsolidationAction.UPDATE: {
        // Set valid_until on old node (preserve history, don't tombstone)
        const oldNode = decision.existingNodeId
          ? await this.storage.getNode(decision.existingNodeId)
          : null;
        if (oldNode) {
          oldNode.valid_until = now;
          await this.storage.saveNode(oldNode);
        }
        // Form new node with valid_from = now
        const newNode = await this.formMemory(candidate, embedding, halfLife);
        // Create Supersedes edge
        if (decision.existingNodeId) {
          await this.link(newNode.node_id, decision.existingNodeId, RT.Supersedes);
        }
        // Log consolidation event
        await this.logConsolidation(decision, newNode.node_id);
        return { node: newNode, decision };
      }

      case ConsolidationAction.REINFORCE: {
        // Boost existing node's confidence and stability (half-life)
        const existingNode = decision.existingNodeId
          ? await this.storage.getNode(decision.existingNodeId)
          : null;
        if (existingNode) {
          existingNode.confidence = Math.min(1.0, existingNode.confidence + 0.1);
          existingNode.half_life = Math.min(
            MemoryGraph.MAX_HALF_LIFE,
            existingNode.half_life * 1.5,
          );
          existingNode.last_accessed = now;
          await this.storage.saveNode(existingNode);
        }
        // Form new node with shorter half-life as supporting context
        const supportNode = await this.formMemory(
          candidate,
          embedding,
          3 * 24 * 60 * 60 * 1000, // 3 days
        );
        // Create Reinforces edge
        if (decision.existingNodeId) {
          await this.link(supportNode.node_id, decision.existingNodeId, RT.Reinforces);
        }
        await this.logConsolidation(decision, supportNode.node_id);
        return { node: supportNode, decision };
      }

      case ConsolidationAction.NOOP: {
        // NOOP = "I already know this" — the user confirmed existing knowledge.
        // Compound: boost confidence + half-life (same as REINFORCE) but don't
        // create a support node — the duplicate adds no new information.
        const existingNode = decision.existingNodeId
          ? await this.storage.getNode(decision.existingNodeId)
          : null;
        if (existingNode) {
          existingNode.confidence = Math.min(1.0, existingNode.confidence + 0.1);
          existingNode.half_life = Math.min(
            MemoryGraph.MAX_HALF_LIFE,
            existingNode.half_life * 1.5,
          );
          existingNode.last_accessed = now;
          await this.storage.saveNode(existingNode);
        }
        await this.logConsolidation(decision);
        return { node: null, decision };
      }

      case ConsolidationAction.ADD:
      default: {
        const node = await this.formMemory(candidate, embedding, halfLife);
        await this.logConsolidation(decision, node.node_id);
        return { node, decision };
      }
    }
  }

  private async logConsolidation(
    decision: ConsolidationDecision,
    newNodeId?: string,
  ): Promise<void> {
    try {
      const clock = await this.eventStore.getLatestClock(this.motebitId);
      await this.eventStore.append({
        event_id: crypto.randomUUID(),
        motebit_id: this.motebitId,
        timestamp: Date.now(),
        event_type: EventType.MemoryConsolidated,
        payload: {
          action: decision.action,
          existing_node_id: decision.existingNodeId ?? null,
          new_node_id: newNodeId ?? null,
          reason: decision.reason,
        },
        version_clock: clock + 1,
        tombstoned: false,
      });
    } catch {
      // Event logging is best-effort
    }
  }

  /**
   * Two-pass retrieval:
   * 1. Weighted filter by confidence, recency, sensitivity
   * 2. Semantic rerank by cosine similarity on embeddings
   *
   * Scoring weights are normalized to sum to 1 at scoring time,
   * so callers can pass any ratio (e.g., {similarityWeight: 10, confidenceWeight: 0, recencyWeight: 0}).
   */
  async retrieve(
    queryEmbedding: number[],
    options: {
      minConfidence?: number;
      sensitivityFilter?: SensitivityLevel[];
      limit?: number;
      scoringConfig?: Partial<ScoringConfig>;
      /** Expand results via graph edges (1-hop neighbors). Default true. */
      expandEdges?: boolean;
      /** Score discount factor for edge-expanded neighbors. Default 0.7. */
      edgeDiscountFactor?: number;
      /** Include temporally expired memories (valid_until in the past). Default false. */
      includeExpired?: boolean;
      /** Hebbian co-retrieval: create/strengthen Related edges between top results. Default false. */
      strengthenCoRetrieved?: boolean;
    } = {},
  ): Promise<MemoryNode[]> {
    const {
      minConfidence = 0.1,
      sensitivityFilter,
      limit = 10,
      scoringConfig: perCallConfig,
      expandEdges = true,
      edgeDiscountFactor = 0.7,
      includeExpired = false,
      strengthenCoRetrieved = false,
    } = options;

    // Merge per-call overrides with instance config
    const config = perCallConfig ? { ...this.scoringConfig, ...perCallConfig } : this.scoringConfig;
    const weights = normalizeWeights(
      config.similarityWeight,
      config.confidenceWeight,
      config.recencyWeight,
    );

    // Pass 1: weighted filter
    const candidates = await this.storage.queryNodes({
      motebit_id: this.motebitId,
      min_confidence: minConfidence,
      sensitivity_filter: sensitivityFilter,
      limit: limit * config.overFetchRatio,
    });

    // Pass 2: semantic rerank
    const now = Date.now();

    // Temporal filter: exclude expired memories unless requested
    const filtered = includeExpired
      ? candidates
      : candidates.filter((node) => node.valid_until == null || node.valid_until > now);

    const scored = filtered.map((node) => {
      const similarity = dotProduct(queryEmbedding, node.embedding);
      const decayedConfidence = computeDecayedConfidence(
        node.confidence,
        node.half_life,
        now - node.created_at,
      );
      // Exponential decay: recencyBoost = 0.5^(elapsed / halfLife)
      const elapsed = now - node.last_accessed;
      const recencyBoost = Math.pow(0.5, elapsed / config.recencyHalfLife);
      const score =
        similarity * weights.similarity +
        decayedConfidence * weights.confidence +
        recencyBoost * weights.recency;
      return { node, score };
    });

    scored.sort((a, b) => b.score - a.score);
    let topResults = scored.slice(0, limit);

    // Accumulate similarity scores for intelligence gradient
    for (const { node } of topResults) {
      const sim = dotProduct(queryEmbedding, node.embedding);
      this._retrievalScores.push(sim);
    }

    // Pass 3: Graph expansion — 1-hop neighbors via edges
    if (expandEdges && topResults.length > 0) {
      const resultIds = new Set(topResults.map((r) => r.node.node_id));

      for (const { node: parent, score: parentScore } of [...topResults]) {
        const edges = await this.storage.getEdges(parent.node_id);
        for (const edge of edges) {
          const neighborId = edge.source_id === parent.node_id ? edge.target_id : edge.source_id;
          if (resultIds.has(neighborId)) continue;

          const neighbor = await this.storage.getNode(neighborId);
          if (!neighbor || neighbor.tombstoned) continue;

          // Temporal filter for neighbor
          if (!includeExpired && neighbor.valid_until != null && neighbor.valid_until <= now)
            continue;

          const neighborScore = parentScore * edgeDiscountFactor * edge.weight * edge.confidence;
          topResults.push({ node: neighbor, score: neighborScore });
          resultIds.add(neighborId);
        }
      }

      // Re-sort and trim after expansion
      topResults.sort((a, b) => b.score - a.score);
      topResults = topResults.slice(0, limit);
    }

    const resultNodes = topResults.map((s) => s.node);

    // Update last_accessed on all retrieved nodes — recently retrieved memories stay fresh
    const retrievalTime = Date.now();
    for (const node of resultNodes) {
      node.last_accessed = retrievalTime;
      await this.storage.saveNode(node);
    }

    // Hebbian co-retrieval: link top co-retrieved memories
    if (strengthenCoRetrieved && resultNodes.length >= 2) {
      await this.linkCoRetrieved(resultNodes.slice(0, 3));
    }

    return resultNodes;
  }

  /**
   * Hebbian co-retrieval: create or strengthen Related edges between
   * memories that are frequently retrieved together. Neurons that fire
   * together wire together — co-retrieved memories become more connected.
   */
  private async linkCoRetrieved(nodes: MemoryNode[]): Promise<void> {
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i]!;
        const b = nodes[j]!;

        // Check if an edge already exists between this pair
        const edges = await this.storage.getEdges(a.node_id);
        const existing = edges.find(
          (e) =>
            (e.source_id === a.node_id && e.target_id === b.node_id) ||
            (e.source_id === b.node_id && e.target_id === a.node_id),
        );

        if (existing) {
          // Strengthen existing edge — small increment, capped at 1.0
          existing.weight = Math.min(1.0, existing.weight + 0.05);
          await this.storage.saveEdge(existing);
        } else {
          // Create new co-retrieval edge with modest initial weight
          await this.link(a.node_id, b.node_id, RT.Related, 0.2, 0.5);
        }
      }
    }
  }

  /**
   * Tombstone a memory (soft delete with audit trail).
   */
  async deleteMemory(nodeId: string): Promise<void> {
    await this.storage.tombstoneNode(nodeId);

    const clock = await this.eventStore.getLatestClock(this.motebitId);
    await this.eventStore.append({
      event_id: crypto.randomUUID(),
      motebit_id: this.motebitId,
      timestamp: Date.now(),
      event_type: EventType.MemoryDeleted,
      payload: { node_id: nodeId },
      version_clock: clock + 1,
      tombstoned: false,
    });
  }

  /**
   * Pin or unpin a memory. No-op if tombstoned.
   */
  async pinMemory(nodeId: string, pinned: boolean): Promise<void> {
    const node = await this.storage.getNode(nodeId);
    if (!node || node.tombstoned) return;

    await this.storage.pinNode(nodeId, pinned);

    const clock = await this.eventStore.getLatestClock(this.motebitId);
    await this.eventStore.append({
      event_id: crypto.randomUUID(),
      motebit_id: this.motebitId,
      timestamp: Date.now(),
      event_type: EventType.MemoryPinned,
      payload: { node_id: nodeId, pinned },
      version_clock: clock + 1,
      tombstoned: false,
    });
  }

  /**
   * Get all pinned, non-tombstoned memories.
   */
  async getPinnedMemories(): Promise<MemoryNode[]> {
    return this.storage.queryNodes({ motebit_id: this.motebitId, pinned: true });
  }

  /**
   * Get a single memory node.
   */
  async getMemory(nodeId: string): Promise<MemoryNode | null> {
    const node = await this.storage.getNode(nodeId);
    if (node !== null) {
      node.last_accessed = Date.now();
      await this.storage.saveNode(node);

      const clock = await this.eventStore.getLatestClock(this.motebitId);
      await this.eventStore.append({
        event_id: crypto.randomUUID(),
        motebit_id: this.motebitId,
        timestamp: Date.now(),
        event_type: EventType.MemoryAccessed,
        payload: { node_id: nodeId },
        version_clock: clock + 1,
        tombstoned: false,
      });
    }
    return node;
  }

  /**
   * Export all memories and edges as JSON.
   */
  async exportAll(): Promise<{
    nodes: MemoryNode[];
    edges: MemoryEdge[];
  }> {
    const nodes = await this.storage.getAllNodes(this.motebitId);
    const edges = await this.storage.getAllEdges(this.motebitId);
    return { nodes, edges };
  }
}
