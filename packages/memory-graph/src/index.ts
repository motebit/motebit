import type {
  MemoryNode,
  MemoryEdge,
  MemoryCandidate,
  SensitivityLevel,
  RelationType,
} from "@motebit/sdk";
import { EventType } from "@motebit/sdk";
import type { EventStore } from "@motebit/event-log";

export { embedText, embedTextHash, EMBEDDING_DIMENSIONS, resetPipeline } from "./embeddings.js";

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
function normalizeWeights(similarity: number, confidence: number, recency: number): { similarity: number; confidence: number; recency: number } {
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
  query_embedding?: number[];
  min_confidence?: number;
  sensitivity_filter?: SensitivityLevel[];
  limit?: number;
  include_tombstoned?: boolean;
}

export interface MemoryStorageAdapter {
  saveNode(node: MemoryNode): Promise<void>;
  getNode(nodeId: string): Promise<MemoryNode | null>;
  queryNodes(query: MemoryQuery): Promise<MemoryNode[]>;
  saveEdge(edge: MemoryEdge): Promise<void>;
  getEdges(nodeId: string): Promise<MemoryEdge[]>;
  tombstoneNode(nodeId: string): Promise<void>;
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
    let results = Array.from(this.nodes.values()).filter(
      (n) => n.motebit_id === query.motebit_id,
    );

    if (query.include_tombstoned !== true) {
      results = results.filter((n) => !n.tombstoned);
    }

    if (query.min_confidence !== undefined) {
      const now = Date.now();
      results = results.filter((n) => {
        const decayed = computeDecayedConfidence(
          n.confidence,
          n.half_life,
          now - n.created_at,
        );
        return decayed >= query.min_confidence!;
      });
    }

    if (query.sensitivity_filter !== undefined) {
      results = results.filter((n) =>
        query.sensitivity_filter!.includes(n.sensitivity),
      );
    }

    if (query.limit !== undefined) {
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

  constructor(
    private storage: MemoryStorageAdapter,
    private eventStore: EventStore,
    private motebitId: string,
    scoringConfig?: Partial<ScoringConfig>,
  ) {
    this.scoringConfig = { ...DEFAULT_SCORING_CONFIG, ...scoringConfig };
  }

  /**
   * Form a new memory from a candidate.
   */
  async formMemory(
    candidate: MemoryCandidate,
    embedding: number[],
    halfLife: number = 7 * 24 * 60 * 60 * 1000, // 7 days default
  ): Promise<MemoryNode> {
    const nodeId = crypto.randomUUID();
    const now = Date.now();

    const node: MemoryNode = {
      node_id: nodeId,
      motebit_id: this.motebitId,
      content: candidate.content,
      embedding,
      confidence: candidate.confidence,
      sensitivity: candidate.sensitivity,
      created_at: now,
      last_accessed: now,
      half_life: halfLife,
      tombstoned: false,
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
    } = {},
  ): Promise<MemoryNode[]> {
    const { minConfidence = 0.1, sensitivityFilter, limit = 10, scoringConfig: perCallConfig } = options;

    // Merge per-call overrides with instance config
    const config = perCallConfig ? { ...this.scoringConfig, ...perCallConfig } : this.scoringConfig;
    const weights = normalizeWeights(config.similarityWeight, config.confidenceWeight, config.recencyWeight);

    // Pass 1: weighted filter
    const candidates = await this.storage.queryNodes({
      motebit_id: this.motebitId,
      min_confidence: minConfidence,
      sensitivity_filter: sensitivityFilter,
      limit: limit * config.overFetchRatio,
    });

    // Pass 2: semantic rerank
    const now = Date.now();
    const scored = candidates.map((node) => {
      const similarity = cosineSimilarity(queryEmbedding, node.embedding);
      const decayedConfidence = computeDecayedConfidence(
        node.confidence,
        node.half_life,
        now - node.created_at,
      );
      // Exponential decay: recencyBoost = 0.5^(elapsed / halfLife)
      const elapsed = now - node.last_accessed;
      const recencyBoost = Math.pow(0.5, elapsed / config.recencyHalfLife);
      const score = similarity * weights.similarity + decayedConfidence * weights.confidence + recencyBoost * weights.recency;
      return { node, score };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map((s) => s.node);
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
