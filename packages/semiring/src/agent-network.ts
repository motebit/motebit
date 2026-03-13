/**
 * Bridge between the generic semiring algebra and Motebit's agent types.
 *
 * Converts AgentTrustRecords, ServiceListings, and latency stats into
 * a WeightedDigraph that can be queried with any semiring.
 *
 * This replaces ad-hoc scoring with algebraic routing:
 *   - "Which agent should handle this task?" → optimalPath over product semiring
 *   - "Why was this agent chosen?" → annotated semiring with provenance
 *   - "What's the trust chain for this delegation?" → optimalPath over TrustSemiring
 *   - "What's the cheapest pipeline?" → optimalPath over CostSemiring
 */

import type {
  AgentTrustRecord,
  AgentServiceListing,
  MotebitId,
  ExecutionReceipt,
} from "@motebit/sdk";
import { trustLevelToScore, AgentTrustLevel } from "@motebit/sdk";
import { WeightedDigraph } from "./graph.js";
import {
  TrustSemiring,
  CostSemiring,
  LatencySemiring,
  ReliabilitySemiring,
  RegulatoryRiskSemiring,
  recordSemiring,
} from "./semiring.js";
import type { Semiring } from "./semiring.js";
import { optimalPaths, optimalPathTrace } from "./traversal.js";
import type { Annotated } from "./provenance.js";
import { annotatedSemiring } from "./provenance.js";

// ── Multi-dimensional edge weight ───────────────────────────────────

export interface RouteWeight {
  readonly trust: number;
  readonly cost: number;
  readonly latency: number;
  readonly reliability: number;
  readonly regulatory_risk: number;
}

/** The multi-objective semiring: optimize trust, cost, latency, reliability, regulatory risk simultaneously. */
export const RouteWeightSemiring: Semiring<RouteWeight> = recordSemiring({
  trust: TrustSemiring,
  cost: CostSemiring,
  latency: LatencySemiring,
  reliability: ReliabilitySemiring,
  regulatory_risk: RegulatoryRiskSemiring,
});

/** RouteWeight semiring with provenance tracking. */
export const AnnotatedRouteWeightSemiring: Semiring<Annotated<RouteWeight>> =
  annotatedSemiring(RouteWeightSemiring);

// ── Graph Construction ──────────────────────────────────────────────

export interface AgentProfile {
  motebit_id: MotebitId;
  trust_record: AgentTrustRecord | null;
  listing: AgentServiceListing | null;
  latency_ms: number | null;
  reliability: number | null;
  is_online: boolean;
  /** Regulatory risk score for this agent. 0 = no risk, higher = more risk. */
  regulatory_risk?: number;
}

/**
 * Build a multi-objective agent network graph from known agents.
 *
 * Each trust record becomes a directed edge from `self` to the remote agent.
 * Edge weights are multi-dimensional (trust, cost, latency, reliability).
 *
 * The returned graph can be queried with:
 *   - RouteWeightSemiring: multi-objective (all dimensions)
 *   - Project to single dimension: optimalPaths over TrustSemiring
 *   - With provenance: AnnotatedRouteWeightSemiring
 */
export function buildAgentGraph(
  selfId: MotebitId,
  agents: AgentProfile[],
): WeightedDigraph<RouteWeight> {
  const graph = new WeightedDigraph(RouteWeightSemiring);
  graph.addNode(selfId);

  for (const agent of agents) {
    if (!agent.is_online) continue;

    const trust = agent.trust_record ? trustLevelToScore(agent.trust_record.trust_level) : 0.1;

    // Blocked agents: zero trust annihilates the edge
    if (agent.trust_record?.trust_level === AgentTrustLevel.Blocked) continue;

    const cost = estimateAgentCost(agent.listing);
    const latency = agent.latency_ms ?? 5000;
    const reliability = agent.reliability ?? 0.5;
    const regulatory_risk = agent.regulatory_risk ?? 0;

    graph.setEdge(selfId, agent.motebit_id, { trust, cost, latency, reliability, regulatory_risk });
  }

  return graph;
}

/**
 * Add peer-to-peer edges from delegation receipts.
 *
 * When agent A delegates to B who delegates to C, the receipt tree
 * encodes the delegation graph. This function walks the tree and adds
 * edges between peers, enabling multi-hop trust computation.
 */
export function addDelegationEdges(
  graph: WeightedDigraph<RouteWeight>,
  receipt: ExecutionReceipt,
  getTrust: (motebitId: string) => number,
  getLatency: (motebitId: string) => number,
): void {
  if (!receipt.delegation_receipts) return;

  for (const sub of receipt.delegation_receipts) {
    const trust = getTrust(sub.motebit_id);
    const latency = getLatency(sub.motebit_id);
    const reliability = sub.status === "completed" ? 0.9 : 0.3;
    const duration = sub.completed_at - sub.submitted_at;

    graph.setEdge(receipt.motebit_id, sub.motebit_id, {
      trust,
      cost: 0, // actual cost tracked separately via budget
      latency: latency || duration,
      reliability,
      regulatory_risk: 0, // delegation receipts don't carry risk metadata (yet)
    });

    // Recurse into sub-delegations
    addDelegationEdges(graph, sub, getTrust, getLatency);
  }
}

// ── Queries ─────────────────────────────────────────────────────────

/**
 * Find the most trusted delegation chain from self to a target agent.
 *
 * Projects the multi-dimensional graph down to trust-only,
 * then finds the optimal path.
 */
export function mostTrustedPath(
  graph: WeightedDigraph<RouteWeight>,
  source: string,
  target: string,
): { trust: number; path: string[] } | null {
  const trustGraph = projectGraph(graph, TrustSemiring, (w) => w.trust);
  const result = optimalPathTrace(trustGraph, source, target);
  if (!result) return null;
  return { trust: result.value, path: result.path };
}

/**
 * Find the lowest regulatory risk path from self to a target agent.
 * Risk accumulates along chains (sum), parallel alternatives pick lowest.
 */
export function lowestRiskPath(
  graph: WeightedDigraph<RouteWeight>,
  source: string,
  target: string,
): { risk: number; path: string[] } | null {
  const riskGraph = projectGraph(graph, RegulatoryRiskSemiring, (w) => w.regulatory_risk);
  const result = optimalPathTrace(riskGraph, source, target);
  if (!result) return null;
  return { risk: result.value, path: result.path };
}

/**
 * Find the cheapest pipeline from self to a target agent.
 */
export function cheapestPath(
  graph: WeightedDigraph<RouteWeight>,
  source: string,
  target: string,
): { cost: number; path: string[] } | null {
  const costGraph = projectGraph(graph, CostSemiring, (w) => w.cost);
  const result = optimalPathTrace(costGraph, source, target);
  if (!result) return null;
  return { cost: result.value, path: result.path };
}

/**
 * Rank all reachable agents by multi-objective score from a source.
 *
 * Returns agents sorted by a composite of trust, cost, latency, reliability.
 * Weights determine the trade-off between dimensions.
 */
export function rankReachableAgents(
  graph: WeightedDigraph<RouteWeight>,
  source: string,
  weights: {
    trust: number;
    cost: number;
    latency: number;
    reliability: number;
    regulatory_risk?: number;
  } = {
    trust: 0.3,
    cost: 0.2,
    latency: 0.15,
    reliability: 0.15,
    regulatory_risk: 0.2,
  },
): Array<{ motebit_id: string; score: number; route: RouteWeight }> {
  const paths = optimalPaths(graph, source);
  const results: Array<{ motebit_id: string; score: number; route: RouteWeight }> = [];

  for (const [nodeId, route] of paths) {
    if (nodeId === source) continue;
    if (route.trust === 0) continue; // unreachable or blocked

    // Normalize cost, latency, and risk to [0,1] where higher is better
    const costScore = route.cost === Infinity ? 0 : 1 / (1 + route.cost);
    const latencyScore = route.latency === Infinity ? 0 : 1 / (1 + route.latency / 1000);
    const riskScore = route.regulatory_risk === Infinity ? 0 : 1 / (1 + route.regulatory_risk);

    const score =
      route.trust * weights.trust +
      costScore * weights.cost +
      latencyScore * weights.latency +
      route.reliability * weights.reliability +
      riskScore * (weights.regulatory_risk ?? 0);

    results.push({ motebit_id: nodeId, score, route });
  }

  results.sort((a, b) => b.score - a.score);
  return results;
}

/**
 * Compute trust closure: the effective trust between every pair of agents.
 *
 * Uses transitive closure over TrustSemiring.
 * Result: closure.get(A)?.get(B) → trust A has in B through best chain.
 */
export { transitiveClosure } from "./traversal.js";

// ── Helpers ─────────────────────────────────────────────────────────

function estimateAgentCost(listing: AgentServiceListing | null): number {
  if (!listing || listing.pricing.length === 0) return 0;
  let total = 0;
  for (const price of listing.pricing) {
    total += price.unit_cost;
  }
  return total;
}

/**
 * Project a multi-dimensional graph to a single semiring dimension.
 *
 * This is the functorial projection: RouteWeight → T.
 * The category-theoretic term is "forgetful functor" — forget all
 * dimensions except the one you're querying.
 */
export function projectGraph<T>(
  graph: WeightedDigraph<RouteWeight>,
  semiring: Semiring<T>,
  project: (w: RouteWeight) => T,
): WeightedDigraph<T> {
  const projected = new WeightedDigraph(semiring);
  for (const node of graph.nodes()) {
    projected.addNode(node);
  }
  for (const edge of graph.edges()) {
    projected.setEdge(edge.from, edge.to, project(edge.weight));
  }
  return projected;
}
