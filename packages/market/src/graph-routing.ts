/**
 * Graph-based agent routing using semiring algebra.
 *
 * Bridges the existing CandidateProfile type (flat list, linear scoring)
 * with the semiring computation graph (algebraic multi-hop routing).
 *
 * This is the primary routing module. The deprecated scoring.ts (scoreCandidate,
 * rankCandidates) is retained for reference but no longer exported from the package.
 */

import type { MotebitId, RouteScore } from "@motebit/sdk";
import { AgentTrustLevel, trustLevelToScore } from "@motebit/sdk";
import {
  WeightedDigraph,
  RouteWeightSemiring,
  AnnotatedRouteWeightSemiring,
  TrustSemiring,
  projectGraph,
  optimalPaths,
  optimalPathTrace,
  transitiveClosure,
} from "@motebit/semiring";
import type { RouteWeight, Annotated } from "@motebit/semiring";
import type { CandidateProfile, TaskRequirements } from "./scoring.js";

// ── Shared Types ────────────────────────────────────────────────────

export interface RoutingWeights {
  trust: number;
  cost: number;
  latency: number;
  reliability: number;
  regulatory_risk?: number;
}

const DEFAULT_WEIGHTS: Required<RoutingWeights> = {
  trust: 0.3,
  cost: 0.2,
  latency: 0.15,
  reliability: 0.15,
  regulatory_risk: 0.2,
};

/**
 * Normalized scores derived from semiring-computed RouteWeight values.
 *
 * All values are in [0,1]:
 * - trust, reliability: directly from semiring (higher is better)
 * - costScore, latencyNorm, riskScore: normalized via 1/(1+x) (lower raw value → higher score)
 */
export interface NormalizedScores {
  /** Trust ∈ [0,1]: composed multiplicatively along chains (TrustSemiring). */
  trust: number;
  /** Reliability ∈ [0,1]: composed multiplicatively along chains (ReliabilitySemiring). */
  reliability: number;
  /** Cost ∈ [0,1]: normalized from [0,∞) via 1/(1+cost). Higher means cheaper. */
  costScore: number;
  /** Latency ∈ [0,1]: normalized from [0,∞) via 1/(1+latency/1000). Higher means faster. */
  latencyNorm: number;
  /** Risk ∈ [0,1]: normalized from [0,∞) via 1/(1+risk). Higher means less risky. */
  riskScore: number;
}

/**
 * A composite function maps normalized semiring scores to a single ordering value.
 *
 * This is a policy choice, not an algebraic artifact. The semiring algebra computes
 * the per-dimension values (trust, cost, latency, reliability, risk) through the
 * graph. The composite function decides how to combine them for ranking.
 *
 * Higher return values indicate better routes.
 */
export type CompositeFunction = (route: RouteWeight, normalized: NormalizedScores) => number;

/** Default: weighted sum (backward compatible). All inputs [0,1], composite ∈ [0,1]. */
export const weightedSumComposite: CompositeFunction = (_route, scores) => {
  // Uses DEFAULT_WEIGHTS ratios. When called from scoreRoute, the actual weights
  // are baked into the closure via the RoutingPolicy. This standalone version
  // uses the default weights for direct invocation.
  return (
    scores.trust * DEFAULT_WEIGHTS.trust +
    scores.costScore * DEFAULT_WEIGHTS.cost +
    scores.latencyNorm * DEFAULT_WEIGHTS.latency +
    scores.reliability * DEFAULT_WEIGHTS.reliability +
    scores.riskScore * DEFAULT_WEIGHTS.regulatory_risk
  );
};

/**
 * Lexicographic composite: trust first, then reliability, then cost.
 *
 * Returns a composite where trust is the primary key, reliability secondary,
 * cost tertiary. Encoded as a single number with separated magnitude bands.
 * Higher is better.
 */
export const lexicographicComposite: CompositeFunction = (_route, scores) => {
  return scores.trust * 1e6 + scores.reliability * 1e3 + scores.costScore;
};

/**
 * Routing policy: configurable weights and composite function.
 *
 * The composite function is a policy choice that determines how semiring-computed
 * per-dimension values are combined into a single ordering for candidate ranking.
 * The default (weightedSumComposite) preserves backward compatibility.
 */
export interface RoutingPolicy {
  weights?: RoutingWeights;
  composite?: CompositeFunction;
}

export interface RoutingConfig {
  weights?: RoutingWeights;
  compositeFunction?: CompositeFunction;
  peerEdges?: Array<{ from: string; to: string; weight: RouteWeight }>;
  maxCandidates?: number;
  explorationWeight?: number;
}

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

    const regulatory_risk = candidate.listing?.regulatory_risk ?? 0;

    graph.setEdge(selfId, candidate.motebit_id, {
      trust,
      cost,
      latency,
      reliability,
      regulatory_risk,
    });
  }

  // Apply peer-to-peer edges from delegation receipt trees
  if (peerEdges) {
    for (const edge of peerEdges) {
      graph.setEdge(edge.from as MotebitId, edge.to as MotebitId, edge.weight);
    }
  }

  return graph;
}

// ── Shared Scoring Core ─────────────────────────────────────────────
//
// Single source of truth for route → RouteScore conversion.
// Both graphRankCandidates and explainedRankCandidates delegate here.
// If the scoring formula changes, it changes once.

/**
 * Score a single route from the semiring graph into a RouteScore.
 * Pure function — no graph access, no side effects.
 *
 * Uses semiring-computed values directly for trust and reliability
 * (already algebraically composed via TrustSemiring/ReliabilitySemiring).
 * Only normalizes cost, latency, and risk (additive accumulators with no
 * natural [0,1] bound) via sigmoid-style mapping.
 */
function scoreRoute(
  nodeId: string,
  route: RouteWeight,
  candidate: CandidateProfile | undefined,
  requirements: TaskRequirements,
  weights: Required<RoutingWeights>,
  compositeFunction?: CompositeFunction,
): RouteScore | null {
  // Capability match is a hard gate
  const capabilityMatch = computeCapabilityMatch(candidate, requirements);
  if (capabilityMatch === 0 && requirements.required_capabilities.length > 0) return null;

  // Semiring values — used directly from the algebraic computation.
  // trust ∈ [0,1]: composed multiplicatively along chains (TrustSemiring)
  // reliability ∈ [0,1]: composed multiplicatively along chains (ReliabilitySemiring)
  const trust = route.trust;
  const reliability = route.reliability;

  // Additive accumulators — need normalization to [0,1] (lower is better → invert)
  // cost ∈ [0,∞): accumulated additively along chains (CostSemiring/tropical)
  // latency ∈ [0,∞): accumulated additively along chains (LatencySemiring/tropical)
  // risk ∈ [0,∞): accumulated additively along chains (RegulatoryRiskSemiring)
  const costScore = route.cost === Infinity ? 0 : 1 / (1 + route.cost);
  const latencyNorm = route.latency === Infinity ? 0 : 1 / (1 + route.latency / 1000);
  const riskScore = route.regulatory_risk === Infinity ? 0 : 1 / (1 + route.regulatory_risk);

  // Build normalized scores for the composite function
  const normalized: NormalizedScores = { trust, reliability, costScore, latencyNorm, riskScore };

  // Composite: policy-driven combination of semiring values + normalized accumulators.
  // The composite function is a configurable policy choice (default: weighted sum).
  const compositeFn =
    compositeFunction ??
    ((_route: RouteWeight, scores: NormalizedScores) =>
      scores.trust * weights.trust +
      scores.costScore * weights.cost +
      scores.latencyNorm * weights.latency +
      scores.reliability * weights.reliability +
      scores.riskScore * weights.regulatory_risk);
  const composite = compositeFn(route, normalized);

  // Sub-scores for observability — includes both semiring and candidate-level metrics
  const successRate = candidate ? computeReliability(candidate) : reliability;
  const latencyScore = route.latency === Infinity ? 0 : 1 - route.latency / (route.latency + 5000);
  const priceEfficiency = computePriceEfficiency(candidate, requirements);
  const availability = candidate?.is_online ? 1.0 : 0.0;

  return {
    motebit_id: nodeId as MotebitId,
    composite,
    sub_scores: {
      trust,
      success_rate: successRate,
      latency: latencyScore,
      price_efficiency: priceEfficiency,
      capability_match: capabilityMatch,
      availability,
    },
    selected: false,
  };
}

/**
 * Apply epsilon-greedy exploration noise and mark top N as selected.
 * Mutates the scores array in place. Shared by both ranking functions.
 */
function finalizeScores<T extends RouteScore>(
  scores: T[],
  maxCandidates: number,
  explorationWeight: number,
): void {
  scores.sort((a, b) => b.composite - a.composite);

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

  let selected = 0;
  for (const score of scores) {
    if (selected >= maxCandidates || score.composite === 0) break;
    score.selected = true;
    selected++;
  }
}

// ── Graph-based Ranking ─────────────────────────────────────────────

/**
 * Rank candidates using semiring graph traversal.
 *
 * Performs algebraic composition through the semiring graph:
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
  config?: RoutingConfig,
): RouteScore[] {
  const weights = { ...DEFAULT_WEIGHTS, ...config?.weights };
  const maxCandidates = config?.maxCandidates ?? 10;
  const explorationWeight = config?.explorationWeight ?? 0;
  const compositeFn = config?.compositeFunction;

  const graph = buildRoutingGraph(selfId, candidates, config?.peerEdges);
  const paths = optimalPaths(graph, selfId);

  const candidateMap = new Map<string, CandidateProfile>();
  for (const c of candidates) candidateMap.set(c.motebit_id, c);

  const scores: RouteScore[] = [];
  for (const [nodeId, route] of paths) {
    if (nodeId === selfId || route.trust === 0) continue;
    const score = scoreRoute(
      nodeId,
      route,
      candidateMap.get(nodeId),
      requirements,
      weights,
      compositeFn,
    );
    if (score) scores.push(score);
  }

  finalizeScores(scores, maxCandidates, explorationWeight);
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

// ── Explained Routing (Provenance) ──────────────────────────────────

/**
 * RouteScore extended with provenance: explains WHY each agent was chosen.
 *
 * routing_paths enumerates the derivation paths — each path is a sequence
 * of agent IDs traversed to reach this candidate through the graph.
 */
export interface ExplainedRouteScore extends RouteScore {
  /** Derivation paths: each path is a sequence of agent IDs traversed to reach this candidate. */
  routing_paths: string[][];
  /** Number of alternative routes that were considered (paths in provenance set). */
  alternatives_considered: number;
}

/**
 * Rank candidates with provenance tracking — returns WHY each agent was chosen.
 *
 * Same scoring as graphRankCandidates (shared scoreRoute core) but uses
 * annotatedSemiring to track derivation paths through the agent graph.
 * Each result includes the routing explanation: which edges (agent IDs)
 * were traversed to reach this candidate.
 *
 * This is the algebraic answer to "explain this routing decision" — not logging,
 * not post-hoc reconstruction, but a first-class semiring query.
 */
export function explainedRankCandidates(
  selfId: MotebitId,
  candidates: CandidateProfile[],
  requirements: TaskRequirements,
  config?: RoutingConfig & { maxProvPaths?: number },
): ExplainedRouteScore[] {
  const weights = { ...DEFAULT_WEIGHTS, ...config?.weights };
  const maxCandidates = config?.maxCandidates ?? 10;
  const explorationWeight = config?.explorationWeight ?? 0;
  const compositeFn = config?.compositeFunction;

  // 1. Build the plain routing graph
  const plainGraph = buildRoutingGraph(selfId, candidates, config?.peerEdges);

  // 2. Build an annotated graph: wrap each edge weight with provenance.
  //    The provenance label for each edge is the target node ID — this records
  //    which agent was traversed to reach the destination.
  const annotatedGraph = new WeightedDigraph(AnnotatedRouteWeightSemiring);
  for (const node of plainGraph.nodes()) annotatedGraph.addNode(node);
  for (const edge of plainGraph.edges()) {
    const annotated: Annotated<RouteWeight> = {
      value: edge.weight,
      why: [[edge.to]],
    };
    annotatedGraph.setEdge(edge.from, edge.to, annotated);
  }

  // 3. Run optimalPaths over the annotated graph
  const annotatedPaths = optimalPaths(annotatedGraph, selfId);

  // 4. Score using the shared core, attach provenance
  const candidateMap = new Map<string, CandidateProfile>();
  for (const c of candidates) candidateMap.set(c.motebit_id, c);

  const scores: ExplainedRouteScore[] = [];
  for (const [nodeId, annotatedRoute] of annotatedPaths) {
    if (nodeId === selfId || annotatedRoute.value.trust === 0) continue;

    const score = scoreRoute(
      nodeId,
      annotatedRoute.value,
      candidateMap.get(nodeId),
      requirements,
      weights,
      compositeFn,
    );
    if (!score) continue;

    const routingPaths = annotatedRoute.why.map((p) => [...p]).filter((p) => p.length > 0);

    scores.push({
      ...score,
      routing_paths: routingPaths,
      alternatives_considered: routingPaths.length,
    });
  }

  finalizeScores(scores, maxCandidates, explorationWeight);
  return scores;
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
