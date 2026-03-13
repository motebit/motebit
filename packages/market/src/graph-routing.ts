/**
 * Graph-based agent routing using semiring algebra.
 *
 * Bridges the existing CandidateProfile type (flat list, linear scoring)
 * with the semiring computation graph (algebraic multi-hop routing).
 *
 * This module coexists with the existing scoring.ts — backward compatible.
 * The runtime can use either linear scoring (rankCandidates) or graph-based
 * routing (graphRankCandidates) depending on whether multi-hop trust
 * composition is needed.
 */

import type { MotebitId, RouteScore } from "@motebit/sdk";
import { AgentTrustLevel, trustLevelToScore } from "@motebit/sdk";
import {
  WeightedDigraph,
  RouteWeightSemiring,
  TrustSemiring,
  projectGraph,
  optimalPaths,
  optimalPathTrace,
  transitiveClosure,
} from "@motebit/semiring";
import type { RouteWeight } from "@motebit/semiring";
import type { CandidateProfile, TaskRequirements } from "./scoring.js";

// ── Graph Construction ──────────────────────────────────────────────

/**
 * Build a semiring computation graph from candidate profiles.
 *
 * Converts the flat CandidateProfile[] into a WeightedDigraph<RouteWeight>
 * for algebraic routing queries.
 *
 * This is the bridge between the existing market scoring model and
 * the semiring algebra. The graph enables multi-hop trust composition,
 * multi-objective optimization, and provenance tracking.
 */
export function buildRoutingGraph(
  selfId: MotebitId,
  candidates: CandidateProfile[],
  peerEdges?: Array<{ from: string; to: string; weight: RouteWeight }>,
): WeightedDigraph<RouteWeight> {
  const graph = new WeightedDigraph(RouteWeightSemiring);
  graph.addNode(selfId);

  for (const candidate of candidates) {
    // Skip blocked agents
    if (candidate.trust_record?.trust_level === AgentTrustLevel.Blocked) continue;
    // Skip offline agents
    if (!candidate.is_online) continue;

    const trust =
      candidate.chain_trust ??
      (candidate.trust_record ? trustLevelToScore(candidate.trust_record.trust_level) : 0.1);

    const cost = estimateCandidateCost(candidate);
    const latency = candidate.latency_stats?.avg_ms ?? 5000;
    const reliability = computeReliability(candidate);

    graph.setEdge(selfId, candidate.motebit_id, { trust, cost, latency, reliability });
  }

  // Apply peer-to-peer edges from delegation receipt trees
  if (peerEdges) {
    for (const edge of peerEdges) {
      graph.setEdge(edge.from as MotebitId, edge.to as MotebitId, edge.weight);
    }
  }

  return graph;
}

// ── Graph-based Ranking ─────────────────────────────────────────────

/**
 * Rank candidates using semiring graph traversal.
 *
 * Unlike the existing rankCandidates (linear weighted sum),
 * this performs algebraic composition through the graph:
 * - Trust composes multiplicatively along chains
 * - Cost/latency compose additively along chains
 * - Parallel alternatives pick the best
 *
 * Returns RouteScore[] for backward compatibility with existing consumers.
 */
export function graphRankCandidates(
  selfId: MotebitId,
  candidates: CandidateProfile[],
  requirements: TaskRequirements,
  config?: {
    weights?: { trust: number; cost: number; latency: number; reliability: number };
    peerEdges?: Array<{ from: string; to: string; weight: RouteWeight }>;
    maxCandidates?: number;
    explorationWeight?: number;
  },
): RouteScore[] {
  const weights = config?.weights ?? { trust: 0.35, cost: 0.25, latency: 0.2, reliability: 0.2 };
  const maxCandidates = config?.maxCandidates ?? 10;
  const explorationWeight = config?.explorationWeight ?? 0;

  const graph = buildRoutingGraph(selfId, candidates, config?.peerEdges);
  const paths = optimalPaths(graph, selfId);

  // Build a lookup for candidate data (needed for sub_scores)
  const candidateMap = new Map<string, CandidateProfile>();
  for (const c of candidates) {
    candidateMap.set(c.motebit_id, c);
  }

  const scores: RouteScore[] = [];

  for (const [nodeId, route] of paths) {
    if (nodeId === selfId) continue;
    if (route.trust === 0) continue; // unreachable or blocked

    const candidate = candidateMap.get(nodeId);

    // Capability match is a hard gate — skip candidates missing required capabilities
    const capabilityMatch = computeCapabilityMatch(candidate, requirements);
    if (capabilityMatch === 0 && requirements.required_capabilities.length > 0) continue;

    // Compute sub_scores for backward compatibility
    const successRate = candidate ? computeReliability(candidate) : route.reliability;
    const latencyScore =
      route.latency === Infinity ? 0 : 1 - route.latency / (route.latency + 5000);
    const priceEfficiency = computePriceEfficiency(candidate, requirements);
    const availability = candidate?.is_online ? 1.0 : 0.0;

    // Normalize cost and latency to [0,1] where higher is better
    const costScore = route.cost === Infinity ? 0 : 1 / (1 + route.cost);
    const latencyNorm = route.latency === Infinity ? 0 : 1 / (1 + route.latency / 1000);

    const composite =
      route.trust * weights.trust +
      costScore * weights.cost +
      latencyNorm * weights.latency +
      route.reliability * weights.reliability;

    scores.push({
      motebit_id: nodeId as MotebitId,
      composite,
      sub_scores: {
        trust: route.trust,
        success_rate: successRate,
        latency: latencyScore,
        price_efficiency: priceEfficiency,
        capability_match: capabilityMatch,
        availability,
      },
      selected: false,
    });
  }

  scores.sort((a, b) => b.composite - a.composite);

  // Epsilon-greedy exploration (same deterministic approach as existing scoring)
  if (explorationWeight > 0 && scores.length > 1) {
    const probe = (scores[0]!.composite * 1000) % 1;
    if (probe < explorationWeight) {
      const explorationIdx = Math.min(
        1 + Math.floor(probe * (scores.length - 1)),
        scores.length - 1,
      );
      if (explorationIdx > 1 && scores[explorationIdx]!.composite > 0) {
        const temp = scores[1]!;
        scores[1] = scores[explorationIdx]!;
        scores[explorationIdx] = temp;
      }
    }
  }

  // Mark top N as selected (skip zero-scored)
  let selected = 0;
  for (const score of scores) {
    if (selected >= maxCandidates || score.composite === 0) break;
    score.selected = true;
    selected++;
  }

  return scores;
}

// ── Trust Closure ───────────────────────────────────────────────────

/**
 * Compute trust closure for all known agents from a source.
 * Returns Map<motebit_id, effective_trust>.
 *
 * This is the "pre-compute the whole trust network" query.
 * Useful for the relay API and admin dashboard.
 */
export function computeTrustClosure(
  selfId: MotebitId,
  candidates: CandidateProfile[],
  peerEdges?: Array<{ from: string; to: string; weight: RouteWeight }>,
): Map<string, number> {
  const graph = buildRoutingGraph(selfId, candidates, peerEdges);
  const trustGraph = projectGraph(graph, TrustSemiring, (w: RouteWeight) => w.trust);
  const closure = transitiveClosure(trustGraph);

  const selfRow = closure.get(selfId);
  const result = new Map<string, number>();
  if (selfRow) {
    for (const [nodeId, trust] of selfRow) {
      if (nodeId !== selfId && trust > 0) {
        result.set(nodeId, trust);
      }
    }
  }

  return result;
}

// ── Path Finding ────────────────────────────────────────────────────

/**
 * Find the most trusted path between two agents.
 * Returns the path and trust score, or null if unreachable.
 */
export function findTrustedRoute(
  selfId: MotebitId,
  targetId: MotebitId,
  candidates: CandidateProfile[],
  peerEdges?: Array<{ from: string; to: string; weight: RouteWeight }>,
): { trust: number; path: string[] } | null {
  const graph = buildRoutingGraph(selfId, candidates, peerEdges);
  const trustGraph = projectGraph(graph, TrustSemiring, (w: RouteWeight) => w.trust);
  const result = optimalPathTrace(trustGraph, selfId, targetId);
  if (!result) return null;
  return { trust: result.value, path: result.path };
}

// ── Helpers ─────────────────────────────────────────────────────────

function estimateCandidateCost(candidate: CandidateProfile): number {
  if (!candidate.listing || candidate.listing.pricing.length === 0) return 0;
  let total = 0;
  for (const price of candidate.listing.pricing) {
    total += price.unit_cost;
  }
  return total;
}

function computeReliability(candidate: CandidateProfile): number {
  if (!candidate.trust_record) return 0.5;
  const s = candidate.trust_record.successful_tasks ?? 0;
  const f = candidate.trust_record.failed_tasks ?? 0;
  const total = s + f;
  if (total === 0) return 0.5;
  return s / total;
}

function computeCapabilityMatch(
  candidate: CandidateProfile | undefined,
  requirements: TaskRequirements,
): number {
  if (requirements.required_capabilities.length === 0) return 1.0;
  if (!candidate?.listing) return 0.0;
  const matched = requirements.required_capabilities.filter((c) =>
    candidate.listing!.capabilities.includes(c),
  ).length;
  if (matched < requirements.required_capabilities.length) return 0.0;
  return matched / requirements.required_capabilities.length;
}

function computePriceEfficiency(
  candidate: CandidateProfile | undefined,
  requirements: TaskRequirements,
): number {
  if (
    !candidate?.listing ||
    candidate.listing.pricing.length === 0 ||
    requirements.max_budget == null
  )
    return 0.7;
  let totalCost = 0;
  for (const cap of requirements.required_capabilities) {
    const price = candidate.listing.pricing.find((p) => p.capability === cap);
    if (price) totalCost += price.unit_cost;
  }
  if (totalCost === 0) return 0.7;
  return Math.max(0, 1 - totalCost / requirements.max_budget);
}
