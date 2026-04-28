/**
 * Graph-based agent routing using semiring algebra.
 *
 * Bridges the `CandidateProfile` type (a flat list of candidates, defined
 * in `./scoring.ts` for shared use) with the semiring computation graph
 * (algebraic multi-hop routing).
 *
 * This is the canonical agent-scoring path. The linear-weighted-sum
 * predecessors (`scoreCandidate`, `rankCandidates`) were deleted on
 * 2026-04-28 once their final test-only callers were trimmed.
 */

import type { MotebitId, RouteScore, Semiring } from "@motebit/protocol";
import { AgentTrustLevel, productSemiring } from "@motebit/protocol";
import {
  trustLevelToScore,
  scoreAttestation,
  HardwareAttestationSemiring,
  HW_ATTESTATION_HARDWARE,
} from "@motebit/semiring";
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
import type { RouteWeight, Annotated, HardwareAttestationScore } from "@motebit/semiring";
import type { CandidateProfile, TaskRequirements } from "./scoring.js";
import { blendCredentialTrust } from "./credential-weight.js";

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

/**
 * A peer-to-peer delegation edge. Optionally carries the intermediate
 * hop's hardware-attestation score so the chain's HW bottleneck reflects
 * every link, not just the terminal's local claim.
 *
 * When `hw_attestation` is absent, the edge is treated as identity under
 * `HardwareAttestationSemiring` (1.0, no degradation). Callers that know
 * the intermediate's custody (e.g. reconstructed from a delegation
 * receipt tree where each hop carries a signed `HardwareAttestationClaim`)
 * should populate it. Absent = "no signal, no penalty", which keeps the
 * field purely additive — existing peer-edge sources don't break.
 */
export interface PeerEdge {
  from: string;
  to: string;
  weight: RouteWeight;
  /**
   * Hardware-attestation score for the intermediate hop this edge
   * represents (0.0 = absent/unknown, 1.0 = hardware-backed, per
   * `scoreAttestation` scalars). Undefined = identity (1.0, passthrough).
   */
  hw_attestation?: HardwareAttestationScore;
}

export interface RoutingConfig {
  weights?: RoutingWeights;
  compositeFunction?: CompositeFunction;
  peerEdges?: PeerEdge[];
  maxCandidates?: number;
  explorationWeight?: number;
  /** Caller's guardian public key (hex). Same guardian = organizational trust baseline. */
  callerGuardianPublicKey?: string;
}

// ── Graph Construction ──────────────────────────────────────────────

/**
 * Organizational trust baseline when two agents share the same guardian key.
 * Same guardian = same organizational custody = verified identity, unproven capability.
 * Sits just above FirstContact (0.3): org attestation proves WHO, not WHAT.
 * This is a floor, not an override — earned trust above this is preserved.
 *
 * 0.35 chosen per zero-trust principle: identity is necessary, not sufficient.
 * Orgs can sign unlimited attestations, so baseline must be conservative.
 * Agents that perform will quickly reach Verified (0.6) through earned trust.
 */
const ORGANIZATIONAL_TRUST_BASELINE = 0.35;

/**
 * How strongly a positive hardware-attestation score boosts the
 * candidate's trust. A hardware-attested chain
 * (`HardwareAttestationSemiring` bottleneck → 1.0) gets trust ×
 * (1 + 0.2) = 20% bump, capped at 1.0. A chain whose weakest link is
 * software (`0.1`) gets a ~2% bump; a chain containing any absent
 * claim annihilates to `0.0` under `⊗` and leaves trust untouched.
 * Conservative by design — hardware attestation is an identity-root
 * signal, not a performance metric, so it supplements earned trust
 * rather than replacing it. Consumers needing stronger/softer weight
 * adjust this constant (PR + changeset) rather than wiring a per-call
 * knob. It's the ratio that maps HW-score into the trust-boost domain
 * and is deliberately visible at the call site.
 */
const HARDWARE_ATTESTATION_BOOST = 0.2;

// ── Hardware-attestation product semiring (market-local) ──────────
//
// `productSemiring(TrustSemiring, HardwareAttestationSemiring)` lifts
// TrustSemiring's multiplicative composition and HardwareAttestationSemiring's
// bottleneck-min into a single 2-tuple algebra. Walking a graph under
// this product in ONE traversal yields, per reachable node, both the
// best trust chain AND the bottleneck HW score across the path — the
// latter is the reason this composition exists. A chain whose weakest
// link is `software` (0.1) terminates with chain-HW = 0.1; a chain
// containing any absent claim terminates with chain-HW = 0.0 (the
// semiring zero, annihilating under ⊗).
//
// Local to this module: the tuple wiring is a market concern (the
// product of "routing trust" and "attestation strength") and doesn't
// belong in the permissive-floor primitive layer. Consumers of `@motebit/semiring`
// compose their own dimensions analogously.
type TrustAttestationScore = readonly [number, HardwareAttestationScore];

const TrustAttestationSemiring: Semiring<TrustAttestationScore> = productSemiring(
  TrustSemiring,
  HardwareAttestationSemiring,
);

/**
 * Build a semiring computation graph from candidate profiles.
 *
 * Converts the flat CandidateProfile[] into a WeightedDigraph<RouteWeight>
 * for algebraic routing queries.
 *
 * This is the bridge between the existing market scoring model and
 * the semiring algebra. The graph enables multi-hop trust composition,
 * multi-objective optimization, and provenance tracking.
 *
 * When callerGuardianPublicKey is provided, candidates with the same guardian
 * key receive an organizational trust baseline (same org = higher starting trust).
 */
export function buildRoutingGraph(
  selfId: MotebitId,
  candidates: CandidateProfile[],
  peerEdges?: PeerEdge[],
  callerGuardianPublicKey?: string,
): WeightedDigraph<RouteWeight> {
  const graph = new WeightedDigraph(RouteWeightSemiring);
  graph.addNode(selfId);

  for (const candidate of candidates) {
    // Skip blocked agents
    if (candidate.trust_record?.trust_level === AgentTrustLevel.Blocked) continue;
    // Skip offline agents
    if (!candidate.is_online) continue;

    let staticTrust =
      candidate.chain_trust ??
      (candidate.trust_record ? trustLevelToScore(candidate.trust_record.trust_level) : 0.1);

    // Organizational attestation: same guardian key = same org custody.
    // Use org baseline as a floor — don't downgrade earned trust.
    if (
      callerGuardianPublicKey &&
      candidate.guardian_public_key &&
      callerGuardianPublicKey === candidate.guardian_public_key
    ) {
      staticTrust = Math.max(staticTrust, ORGANIZATIONAL_TRUST_BASELINE);
    }

    const blendedTrust = blendCredentialTrust(staticTrust, candidate.credential_reputation ?? null);

    // Hardware-attestation composes via the product semiring at
    // traversal time (see `applyHardwareAttestationBoost`). Each edge
    // carries the candidate's LOCAL HW score; `optimalPaths` over
    // `TrustAttestationSemiring` produces the chain's bottleneck HW
    // score per reachable candidate, which is then folded into trust
    // via `blendedTrust × (1 + chainHwScore × HARDWARE_ATTESTATION_BOOST)`.
    // Single-hop result is identical to the previous scalar-at-terminal
    // composition; multi-hop now reflects the weakest-link custody of
    // the entire path (the reason the semiring exists).
    const trust = Math.min(1.0, blendedTrust);

    const cost = estimateCandidateCost(candidate);
    // Latency: prefer measured stats, fall back to SLA declaration, then default
    const measuredLatency = candidate.latency_stats?.avg_ms;
    const slaLatency = candidate.listing?.sla?.max_latency_ms;
    const latency = measuredLatency ?? slaLatency ?? 5000;
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

// ── Hardware-attestation chain composition ────────────────────────

/**
 * Build the parallel `TrustAttestationSemiring` graph — same nodes and
 * edges as the plain routing graph, but every edge weight is a
 * `(trust, hwScore)` tuple. Each self→candidate edge carries the
 * candidate's local `scoreAttestation`. Each peer edge carries its
 * intermediate hop's `hw_attestation` if supplied, else identity
 * (`HW_ATTESTATION_HARDWARE` = 1.0 — passthrough under ⊗). Running
 * `optimalPaths` on this graph yields, per reachable candidate, the
 * bottleneck HW score across the entire path. That score feeds
 * `applyHardwareAttestationBoost` at the ranking boundary.
 *
 * Why a second graph, not a second dimension inside `RouteWeight`:
 * `RouteWeight` lives in `@motebit/semiring` and its shape is part of
 * a multi-surface API. The attestation composition is a market-side
 * product that doesn't need to propagate upstream. Building a small
 * parallel graph here keeps the protocol-level type stable.
 */
function buildTrustAttestationGraph(
  selfId: MotebitId,
  candidates: CandidateProfile[],
  peerEdges?: PeerEdge[],
  callerGuardianPublicKey?: string,
): WeightedDigraph<TrustAttestationScore> {
  const graph = new WeightedDigraph(TrustAttestationSemiring);
  graph.addNode(selfId);

  for (const candidate of candidates) {
    if (candidate.trust_record?.trust_level === AgentTrustLevel.Blocked) continue;
    if (!candidate.is_online) continue;

    let staticTrust =
      candidate.chain_trust ??
      (candidate.trust_record ? trustLevelToScore(candidate.trust_record.trust_level) : 0.1);

    if (
      callerGuardianPublicKey &&
      candidate.guardian_public_key &&
      callerGuardianPublicKey === candidate.guardian_public_key
    ) {
      staticTrust = Math.max(staticTrust, ORGANIZATIONAL_TRUST_BASELINE);
    }

    const blendedTrust = blendCredentialTrust(staticTrust, candidate.credential_reputation ?? null);
    // Prefer peer-verified aggregate when available (Phase 1 of the
    // hardware-attestation peer flow). Falls back to scoring the
    // candidate's self-attestation claim when no peer credentials
    // carrying hardware_attestation have been issued for it.
    const hwScore =
      candidate.hardware_attestation_aggregate?.attestation_score ??
      scoreAttestation(candidate.hardware_attestation);
    graph.setEdge(selfId, candidate.motebit_id, [blendedTrust, hwScore] as const);
  }

  if (peerEdges) {
    for (const edge of peerEdges) {
      const hw = edge.hw_attestation ?? HW_ATTESTATION_HARDWARE;
      graph.setEdge(edge.from as MotebitId, edge.to as MotebitId, [edge.weight.trust, hw] as const);
    }
  }

  return graph;
}

/**
 * Walk the `TrustAttestationSemiring` graph to produce, per reachable
 * candidate, the bottleneck HW score across the optimal-trust path.
 * Maps node id → chain-HW score. Absent entries (unreachable in the
 * product traversal) default to `HW_ATTESTATION_NONE` (zero) at lookup,
 * which under the boost formula leaves trust untouched.
 */
function computeChainHwScores(
  selfId: MotebitId,
  candidates: CandidateProfile[],
  peerEdges?: PeerEdge[],
  callerGuardianPublicKey?: string,
): Map<string, HardwareAttestationScore> {
  const productGraph = buildTrustAttestationGraph(
    selfId,
    candidates,
    peerEdges,
    callerGuardianPublicKey,
  );
  const productPaths = optimalPaths(productGraph, selfId);
  const out = new Map<string, HardwareAttestationScore>();
  for (const [nodeId, [, hwScore]] of productPaths) {
    if (nodeId === selfId) continue;
    out.set(nodeId, hwScore);
  }
  return out;
}

/**
 * Fold the chain-HW bottleneck into composed trust at ranking time.
 *
 * `trust * (1 + chainHw × HARDWARE_ATTESTATION_BOOST)` — same formula
 * as the previous scalar-at-terminal application, but `chainHw` is now
 * the bottleneck-min across the path rather than the terminal's local
 * claim. Absent claim anywhere in the chain → chainHw = 0 → trust
 * untouched (the semiring-zero annihilation property).
 *
 * Caps at 1.0 to preserve the [0, 1] trust domain.
 */
function applyHardwareAttestationBoost(
  trust: number,
  chainHwScore: HardwareAttestationScore,
): number {
  return Math.min(1.0, trust * (1 + chainHwScore * HARDWARE_ATTESTATION_BOOST));
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
  chainHwScore: HardwareAttestationScore = 0,
): RouteScore | null {
  // Capability match is a hard gate
  const capabilityMatch = computeCapabilityMatch(candidate, requirements);
  if (capabilityMatch === 0 && requirements.required_capabilities.length > 0) return null;

  // Semiring values — used directly from the algebraic computation.
  // trust ∈ [0,1]: composed multiplicatively along chains (TrustSemiring),
  //   then boosted by the hardware-attestation CHAIN BOTTLENECK (not the
  //   terminal's local claim) via `applyHardwareAttestationBoost`. The
  //   boost reflects the weakest-link custody of the entire path: a
  //   single `software` intermediate (0.1) caps the chain bonus at ~2%,
  //   any absent claim collapses it to zero.
  // reliability ∈ [0,1]: composed multiplicatively along chains (ReliabilitySemiring)
  const trust = applyHardwareAttestationBoost(route.trust, chainHwScore);
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

  const graph = buildRoutingGraph(
    selfId,
    candidates,
    config?.peerEdges,
    config?.callerGuardianPublicKey,
  );
  const paths = optimalPaths(graph, selfId);

  // Parallel traversal over `TrustAttestationSemiring` — one pass, one
  // algebra, yields the chain-bottleneck HW score for every reachable
  // candidate. See `applyHardwareAttestationBoost` at the ranking
  // boundary; the boost formula is unchanged, the argument is now the
  // chain-min instead of the terminal-local score.
  const chainHw = computeChainHwScores(
    selfId,
    candidates,
    config?.peerEdges,
    config?.callerGuardianPublicKey,
  );

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
      chainHw.get(nodeId) ?? 0,
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
 * Useful for the relay API and inspector dashboard.
 */
export function computeTrustClosure(
  selfId: MotebitId,
  candidates: CandidateProfile[],
  peerEdges?: PeerEdge[],
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
  peerEdges?: PeerEdge[],
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
  const plainGraph = buildRoutingGraph(
    selfId,
    candidates,
    config?.peerEdges,
    config?.callerGuardianPublicKey,
  );

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

  // 3b. Parallel chain-HW bottleneck traversal (see `graphRankCandidates`).
  const chainHw = computeChainHwScores(
    selfId,
    candidates,
    config?.peerEdges,
    config?.callerGuardianPublicKey,
  );

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
      chainHw.get(nodeId) ?? 0,
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
  // SLA availability guarantee as a baseline for agents without track record
  const slaFloor = candidate.listing?.sla?.availability_guarantee ?? 0;

  if (!candidate.trust_record) {
    // No interaction history: use SLA guarantee if declared, else 0.5
    return Math.max(slaFloor, 0.5);
  }
  const s = candidate.trust_record.successful_tasks ?? 0;
  const f = candidate.trust_record.failed_tasks ?? 0;
  const total = s + f;
  if (total === 0) return Math.max(slaFloor, 0.5);
  let reliability = s / total;
  // Quality modulation: agents with enough samples and low avg_quality
  // get up to 30% reliability reduction. No new semiring dimension needed.
  const quality = candidate.trust_record.avg_quality ?? 1.0;
  const qualitySamples = candidate.trust_record.quality_sample_count ?? 0;
  if (qualitySamples >= 3) {
    reliability = reliability * (0.7 + 0.3 * quality);
    // Quality-modulated: evidence overrides SLA declaration.
    // The agent has enough data to prove its actual reliability.
    return reliability;
  }
  // Insufficient quality data: SLA floor applies as baseline
  return Math.max(reliability, slaFloor);
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
