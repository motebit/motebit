/**
 * Weighted directed graph parameterized by a semiring.
 *
 * The graph represents the agent network. Nodes are motebits.
 * Edges carry semiring-valued weights (trust, cost, latency, or products thereof).
 *
 * Key insight: the same graph structure supports different queries by
 * swapping the semiring used in traversal. The graph stores raw edge data;
 * the semiring determines how to compose and compare paths.
 */

import type { Semiring } from "./semiring.js";

export interface Edge<T> {
  readonly from: string;
  readonly to: string;
  readonly weight: T;
}

/**
 * Immutable-ish weighted digraph. Nodes are string IDs (motebit_id).
 * Edges are stored adjacency-list style for efficient traversal.
 */
export class WeightedDigraph<T> {
  private readonly _adj = new Map<string, Map<string, T>>();
  private readonly _nodes = new Set<string>();

  constructor(private readonly semiring: Semiring<T>) {}

  /** The semiring this graph operates over. */
  get sr(): Semiring<T> {
    return this.semiring;
  }

  addNode(id: string): void {
    this._nodes.add(id);
    if (!this._adj.has(id)) this._adj.set(id, new Map());
  }

  /**
   * Set an edge weight. If the edge already exists, the new weight
   * is ⊕-combined with the existing weight (parallel edges merge).
   */
  addEdge(from: string, to: string, weight: T): void {
    this.addNode(from);
    this.addNode(to);
    const neighbors = this._adj.get(from)!;
    const existing = neighbors.get(to);
    neighbors.set(to, existing !== undefined ? this.semiring.add(existing, weight) : weight);
  }

  /** Set an edge weight, replacing any existing weight. */
  setEdge(from: string, to: string, weight: T): void {
    this.addNode(from);
    this.addNode(to);
    this._adj.get(from)!.set(to, weight);
  }

  removeEdge(from: string, to: string): void {
    this._adj.get(from)?.delete(to);
  }

  removeNode(id: string): void {
    this._nodes.delete(id);
    this._adj.delete(id);
    for (const neighbors of this._adj.values()) {
      neighbors.delete(id);
    }
  }

  hasNode(id: string): boolean {
    return this._nodes.has(id);
  }

  hasEdge(from: string, to: string): boolean {
    return this._adj.get(from)?.has(to) ?? false;
  }

  /** Get edge weight, or semiring zero if no edge exists. */
  getEdge(from: string, to: string): T {
    return this._adj.get(from)?.get(to) ?? this.semiring.zero;
  }

  nodes(): ReadonlySet<string> {
    return this._nodes;
  }

  nodeCount(): number {
    return this._nodes.size;
  }

  /** Outgoing edges from a node. */
  neighbors(id: string): ReadonlyMap<string, T> {
    return this._adj.get(id) ?? new Map();
  }

  /** All edges in the graph. */
  edges(): Edge<T>[] {
    const result: Edge<T>[] = [];
    for (const [from, neighbors] of this._adj) {
      for (const [to, weight] of neighbors) {
        result.push({ from, to, weight });
      }
    }
    return result;
  }

  edgeCount(): number {
    let count = 0;
    for (const neighbors of this._adj.values()) count += neighbors.size;
    return count;
  }
}
