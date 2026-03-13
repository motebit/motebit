/**
 * Generic graph traversal over arbitrary semirings.
 *
 * The core insight: shortest path, most-trusted path, cheapest path,
 * most reliable path, and reachability are ALL the same algorithm.
 * The semiring determines the answer.
 *
 * Bellman-Ford generalized: relax edges using ⊕ (choice) and ⊗ (composition).
 * Floyd-Warshall generalized: all-pairs transitive closure.
 *
 * These are the only two traversal algorithms the system needs.
 * Every routing query is a semiring instantiation of one of them.
 */

import type { WeightedDigraph } from "./graph.js";

/**
 * Single-source optimal paths via generalized Bellman-Ford.
 *
 * Returns a map from each reachable node to the optimal semiring value
 * of the best path from `source` to that node.
 *
 * - Over TrustSemiring: most trusted delegation chain from source
 * - Over CostSemiring:  cheapest pipeline from source
 * - Over BooleanSemiring: reachable set from source
 * - Over product semiring: all of the above simultaneously
 *
 * Complexity: O(V × E) — safe for graphs with negative-weight analogs
 * (semirings where ⊕ is not monotone). For monotone semirings
 * (trust, cost), could be optimized to Dijkstra-like O((V+E) log V).
 */
export function optimalPaths<T>(graph: WeightedDigraph<T>, source: string): Map<string, T> {
  const sr = graph.sr;
  const dist = new Map<string, T>();

  // Initialize: source = 1 (identity), everything else = 0 (worst)
  for (const node of graph.nodes()) {
    dist.set(node, sr.zero);
  }
  dist.set(source, sr.one);

  const nodes = [...graph.nodes()];
  const nodeCount = nodes.length;

  // Relax all edges V-1 times
  for (let i = 0; i < nodeCount - 1; i++) {
    let changed = false;
    for (const node of nodes) {
      const dNode = dist.get(node)!;
      for (const [neighbor, weight] of graph.neighbors(node)) {
        // New candidate: path-to-node ⊗ edge-weight
        const candidate = sr.mul(dNode, weight);
        const current = dist.get(neighbor)!;
        const combined = sr.add(current, candidate);
        // Only update if the value actually changed
        if (combined !== current) {
          dist.set(neighbor, combined);
          changed = true;
        }
      }
    }
    if (!changed) break; // Early termination — converged
  }

  return dist;
}

/**
 * Optimal path between two specific nodes.
 * Convenience wrapper around optimalPaths.
 */
export function optimalPath<T>(graph: WeightedDigraph<T>, source: string, target: string): T {
  return optimalPaths(graph, source).get(target) ?? graph.sr.zero;
}

/**
 * All-pairs transitive closure via generalized Floyd-Warshall.
 *
 * Computes the optimal semiring value between every pair of nodes.
 * Returns a nested map: closure.get(from)?.get(to) → optimal value.
 *
 * Use cases:
 *   - Pre-compute all trust relationships in a network
 *   - Find all cheapest routes for capacity planning
 *   - Detect isolated subgraphs (boolean semiring)
 *
 * Complexity: O(V³). Use optimalPaths for single-source queries on large graphs.
 */
export function transitiveClosure<T>(graph: WeightedDigraph<T>): Map<string, Map<string, T>> {
  const sr = graph.sr;
  const nodes = [...graph.nodes()];
  const n = nodes.length;
  const idx = new Map<string, number>();
  for (let i = 0; i < n; i++) idx.set(nodes[i]!, i);

  // Initialize distance matrix
  const dist: T[][] = [];
  for (let i = 0; i < n; i++) {
    dist.push([]);
    for (let j = 0; j < n; j++) {
      dist[i]!.push(i === j ? sr.one : sr.zero);
    }
  }

  // Load edges
  for (const node of nodes) {
    const i = idx.get(node)!;
    for (const [neighbor, weight] of graph.neighbors(node)) {
      const j = idx.get(neighbor)!;
      dist[i]![j] = sr.add(dist[i]![j]!, weight);
    }
  }

  // Floyd-Warshall relaxation
  for (let k = 0; k < n; k++) {
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        const through_k = sr.mul(dist[i]![k]!, dist[k]![j]!);
        dist[i]![j] = sr.add(dist[i]![j]!, through_k);
      }
    }
  }

  // Convert to nested map
  const result = new Map<string, Map<string, T>>();
  for (let i = 0; i < n; i++) {
    const row = new Map<string, T>();
    for (let j = 0; j < n; j++) {
      row.set(nodes[j]!, dist[i]![j]!);
    }
    result.set(nodes[i]!, row);
  }
  return result;
}

/**
 * Reconstruct the actual optimal path (sequence of node IDs).
 *
 * Returns null if no path exists (value equals semiring zero).
 * Runs a modified Bellman-Ford that tracks predecessors.
 */
export function optimalPathTrace<T>(
  graph: WeightedDigraph<T>,
  source: string,
  target: string,
): { value: T; path: string[] } | null {
  const sr = graph.sr;
  const dist = new Map<string, T>();
  const pred = new Map<string, string | null>();

  for (const node of graph.nodes()) {
    dist.set(node, sr.zero);
    pred.set(node, null);
  }
  dist.set(source, sr.one);

  const nodes = [...graph.nodes()];

  for (let i = 0; i < nodes.length - 1; i++) {
    let changed = false;
    for (const node of nodes) {
      const dNode = dist.get(node)!;
      for (const [neighbor, weight] of graph.neighbors(node)) {
        const candidate = sr.mul(dNode, weight);
        const current = dist.get(neighbor)!;
        const combined = sr.add(current, candidate);
        if (combined !== current) {
          dist.set(neighbor, combined);
          pred.set(neighbor, node);
          changed = true;
        }
      }
    }
    if (!changed) break;
  }

  const value = dist.get(target) ?? sr.zero;
  if (value === sr.zero && source !== target) return null;

  // Reconstruct path
  const path: string[] = [];
  let current: string | null | undefined = target;
  const visited = new Set<string>();
  while (current != null && !visited.has(current)) {
    visited.add(current);
    path.unshift(current);
    current = pred.get(current) ?? null;
  }

  if (path[0] !== source) return null;
  return { value, path };
}
