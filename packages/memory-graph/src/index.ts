import type {
  MemoryNode,
  MemoryEdge,
  MemoryCandidate,
  SensitivityLevel,
  RelationType,
} from "@mote/sdk";
import { EventType } from "@mote/sdk";
import type { EventStore } from "@mote/event-log";

// === Interfaces ===

export interface MemoryQuery {
  mote_id: string;
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
  getAllNodes(moteId: string): Promise<MemoryNode[]>;
  getAllEdges(moteId: string): Promise<MemoryEdge[]>;
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

  async saveNode(node: MemoryNode): Promise<void> {
    this.nodes.set(node.node_id, { ...node });
  }

  async getNode(nodeId: string): Promise<MemoryNode | null> {
    return this.nodes.get(nodeId) ?? null;
  }

  async queryNodes(query: MemoryQuery): Promise<MemoryNode[]> {
    let results = Array.from(this.nodes.values()).filter(
      (n) => n.mote_id === query.mote_id,
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

    return results;
  }

  async saveEdge(edge: MemoryEdge): Promise<void> {
    this.edges.set(edge.edge_id, { ...edge });
  }

  async getEdges(nodeId: string): Promise<MemoryEdge[]> {
    return Array.from(this.edges.values()).filter(
      (e) => e.source_id === nodeId || e.target_id === nodeId,
    );
  }

  async tombstoneNode(nodeId: string): Promise<void> {
    const node = this.nodes.get(nodeId);
    if (node !== undefined) {
      node.tombstoned = true;
    }
  }

  async getAllNodes(moteId: string): Promise<MemoryNode[]> {
    return Array.from(this.nodes.values()).filter((n) => n.mote_id === moteId);
  }

  async getAllEdges(moteId: string): Promise<MemoryEdge[]> {
    const moteNodes = new Set(
      Array.from(this.nodes.values())
        .filter((n) => n.mote_id === moteId)
        .map((n) => n.node_id),
    );
    return Array.from(this.edges.values()).filter(
      (e) => moteNodes.has(e.source_id) || moteNodes.has(e.target_id),
    );
  }
}

// === Memory Graph Manager ===

export class MemoryGraph {
  constructor(
    private storage: MemoryStorageAdapter,
    private eventStore: EventStore,
    private moteId: string,
  ) {}

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
      mote_id: this.moteId,
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

    await this.eventStore.append({
      event_id: crypto.randomUUID(),
      mote_id: this.moteId,
      timestamp: now,
      event_type: EventType.MemoryFormed,
      payload: { node_id: nodeId, content: candidate.content },
      version_clock: 0,
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
   */
  async retrieve(
    queryEmbedding: number[],
    options: {
      minConfidence?: number;
      sensitivityFilter?: SensitivityLevel[];
      limit?: number;
    } = {},
  ): Promise<MemoryNode[]> {
    const { minConfidence = 0.1, sensitivityFilter, limit = 10 } = options;

    // Pass 1: weighted filter
    const candidates = await this.storage.queryNodes({
      mote_id: this.moteId,
      min_confidence: minConfidence,
      sensitivity_filter: sensitivityFilter,
      limit: limit * 5, // over-fetch for reranking
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
      const recencyBoost = 1 / (1 + (now - node.last_accessed) / (24 * 60 * 60 * 1000));
      const score = similarity * 0.5 + decayedConfidence * 0.3 + recencyBoost * 0.2;
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

    await this.eventStore.append({
      event_id: crypto.randomUUID(),
      mote_id: this.moteId,
      timestamp: Date.now(),
      event_type: EventType.MemoryDeleted,
      payload: { node_id: nodeId },
      version_clock: 0,
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

      await this.eventStore.append({
        event_id: crypto.randomUUID(),
        mote_id: this.moteId,
        timestamp: Date.now(),
        event_type: EventType.MemoryAccessed,
        payload: { node_id: nodeId },
        version_clock: 0,
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
    const nodes = await this.storage.getAllNodes(this.moteId);
    const edges = await this.storage.getAllEdges(this.moteId);
    return { nodes, edges };
  }
}
