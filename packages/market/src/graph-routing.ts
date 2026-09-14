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

import type { MotebitId, RouteScore } from "@motebit/protocol";
import { AgentTrustLevel } from "@motebit/protocol";
import { trustLevelToScore, scoreAttestation, HW_ATTESTATION_HARDWARE } from "@motebit/semiring";
import {
  WeightedDigraph,
  RouteWeightSemiring,
  ROUTE_WEIGHT_DIMENSIONS,
  frontierPaths,
  chooseFromFrontier,
  TrustSemiring,
  projectGraph,
  optimalPathTrace,
  transitiveClosure,
} from "@motebit/semiring";
import type { RouteWeight, HardwareAttestationScore, Frontier } from "@motebit/semiring";
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
/**
 * Build an EXACT lexicographic composite over normalized [0,1] scores at
 * `LEXICOGRAPHIC_RESOLUTION` (1e-3): each key is quantized to 0..1000 and
 * packed in base 1001, so a higher-priority key always outranks every lower
 * one — a strict improvement at any priority level can never be outweighed
 * by the levels below it. The former `a*1e6 + b*1e3 + c` packing was not
 * exact: an unquantized `b ∈ [0,1]` spans 1e3, so a gap in `a` below 1e-3
 * could be reversed by `b`.
 */
export const LEXICOGRAPHIC_RESOLUTION = 1000;
export function lexicographicOver(order: readonly (keyof NormalizedScores)[]): CompositeFunction {
  const base = LEXICOGRAPHIC_RESOLUTION + 1;
  const q = (x: number): number =>
    Math.round(Math.min(Math.max(Number.isFinite(x) ? x : 0, 0), 1) * LEXICOGRAPHIC_RESOLUTION);
  return (_route, scores) => {
    let acc = 0;
    for (const key of order) acc = acc * base + q(scores[key]);
    return acc;
  };
}

/** Quality-first policy: trust, then reliability, then cost. */
export const lexicographicComposite: CompositeFunction = lexicographicOver([
  "trust",
  "reliability",
  "costScore",
]);

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

    // Hardware attestation is folded along the CHOSEN route, not here:
    // `edgeHwScores` records each edge's LOCAL HW score and
    // `chainHwForPath` takes the weakest link across the ranked path,
    // then `applyHardwareAttestationBoost` applies
    // `blendedTrust × (1 + chainHwScore × HARDWARE_ATTESTATION_BOOST)`.
    // Single-hop is identical to scalar-at-terminal; multi-hop reflects
    // the weakest-link custody of the route that was actually ranked.
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

  // Apply peer-to-peer edges from delegation receipt trees. Every component
  // is coerced to a finite number first: a peer edge assembled from a nullable
  // column (or a caller's partial literal) with `regulatory_risk: null` would
  // otherwise compose to NaN, and a NaN composite makes the route policy's
  // comparator undefined — the ranking silently degrades to insertion order.
  if (peerEdges) {
    for (const edge of peerEdges) {
      graph.setEdge(edge.from, edge.to, finiteRouteWeight(edge.weight));
    }
  }

  return graph;
}

/**
 * Choose one route from a candidate's frontier under the composite policy,
 * scoring each real route exactly once. Returns the chosen route's own
 * `RouteScore`, the frontier ordered winner-first, and how many viable
 * routes the policy chose among. `null` when no viable route scores.
 */
function pickRoute(
  frontier: Frontier<RouteWeight>,
  scoreOne: (weight: RouteWeight, path: readonly string[]) => RouteScore | null,
): { score: RouteScore; ordered: Frontier<RouteWeight>; viable: number } | null {
  const viable = frontier.filter((p) => p.weight.trust > 0);
  const memo = new Map<string, RouteScore | null>();
  const scoreOf = (weight: RouteWeight, path: readonly string[]): RouteScore | null => {
    const k = path.join("\u0000");
    if (!memo.has(k)) memo.set(k, scoreOne(weight, path));
    return memo.get(k) ?? null;
  };
  const pick = chooseFromFrontier(viable, (w, path) => scoreOf(w, path)?.composite ?? -Infinity);
  if (pick === null || pick.score === -Infinity) return null;
  const score = scoreOf(pick.chosen.weight, pick.chosen.path);
  if (!score) return null;
  return { score, ordered: pick.ordered, viable: viable.length };
}

/**
 * Coerce a possibly-partial edge weight to a total, finite `RouteWeight`.
 * Absent trust is no trust (0); absent reliability is the multiplicative
 * identity (1); absent accumulators are the additive identity (0).
 */
function finiteRouteWeight(w: Partial<RouteWeight>): RouteWeight {
  const num = (v: unknown, dflt: number): number =>
    typeof v === "number" && Number.isFinite(v) ? v : dflt;
  return {
    trust: num(w.trust, 0),
    cost: num(w.cost, 0),
    latency: num(w.latency, 0),
    reliability: num(w.reliability, 1),
    regulatory_risk: num(w.regulatory_risk, 0),
  };
}

// ── Hardware-attestation chain composition ────────────────────────

/**
 * Hardware-attestation score per edge — the candidate's own for a
 * self→candidate edge, the intermediate hop's for a peer edge (identity 1.0
 * when unsupplied). Folded along the CHOSEN path with `min` (weakest-link
 * custody). Previously a parallel product-semiring traversal produced a
 * per-node optimum that, like the record semiring, could mix paths; folding
 * the chosen path keeps the boost truthful to the route actually ranked.
 */
function edgeHwScores(
  selfId: MotebitId,
  candidates: CandidateProfile[],
  peerEdges?: PeerEdge[],
): Map<string, HardwareAttestationScore> {
  const out = new Map<string, HardwareAttestationScore>();
  for (const candidate of candidates) {
    const hwScore =
      candidate.hardware_attestation_aggregate?.attestation_score ??
      scoreAttestation(candidate.hardware_attestation);
    out.set(`${selfId}\u0000${candidate.motebit_id}`, hwScore);
  }
  if (peerEdges) {
    for (const edge of peerEdges) {
      out.set(`${edge.from}\u0000${edge.to}`, edge.hw_attestation ?? HW_ATTESTATION_HARDWARE);
    }
  }
  return out;
}

function chainHwForPath(
  selfId: MotebitId,
  path: readonly string[],
  hwByEdge: Map<string, HardwareAttestationScore>,
): HardwareAttestationScore {
  let prev: string = selfId;
  let hw: number = HW_ATTESTATION_HARDWARE;
  for (const node of path) {
    hw = Math.min(hw, hwByEdge.get(`${prev}\u0000${node}`) ?? 0);
    prev = node;
  }
  return hw;
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
    motebit_id: nodeId,
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
  // Path-preserving ranking: per candidate, the Pareto frontier of REAL
  // routes; the composite policy chooses among them; the reported metrics
  // are the chosen route's own. Never the component-wise mixture.
  const frontiers = frontierPaths(graph, ROUTE_WEIGHT_DIMENSIONS, selfId);
  const hwByEdge = edgeHwScores(selfId, candidates, config?.peerEdges);
  const candidateMap = new Map<string, CandidateProfile>();
  for (const c of candidates) candidateMap.set(c.motebit_id, c);
  const scores: RouteScore[] = [];
  for (const [nodeId, frontier] of frontiers) {
    if (nodeId === selfId) continue;
    const picked = pickRoute(frontier, (w, path) =>
      scoreRoute(
        nodeId,
        w,
        candidateMap.get(nodeId),
        requirements,
        weights,
        compositeFn,
        chainHwForPath(selfId, path, hwByEdge),
      ),
    );
    if (picked) scores.push(picked.score);
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
 * `routing_paths[0]` is the CHOSEN route — the sequence of agent ids from the
 * caller to this candidate whose composed edge metrics the score reports.
 * The remaining entries are the non-dominated alternative routes the policy
 * weighed, in descending policy order. A path is a route that exists, never
 * a component-wise derivation.
 */
export interface ExplainedRouteScore extends RouteScore {
  /** `[0]` = the chosen route (its metrics are the score's metrics); then the alternatives, best first. */
  routing_paths: string[][];
  /** Number of non-dominated viable routes to this candidate the policy chose among (≥ 1). */
  alternatives_considered: number;
}

/**
 * Rank candidates with provenance tracking — returns WHY each agent was chosen.
 *
 * Same scoring as graphRankCandidates (shared scoreRoute core). Both rank
 * over the Pareto frontier of REAL routes per candidate (`frontierPaths`);
 * this variant also reports them: `routing_paths[0]` is the route that was
 * chosen — the one whose composed metrics the score reflects — and the rest
 * are the non-dominated alternatives the policy weighed. An explanation
 * that named a node's component-wise optimum would describe a hire that
 * never existed; this one names the hire.
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
  // 2. Per candidate, the Pareto frontier of real routes (each carrying its
  //    own composed metrics AND its path). The explanation is therefore
  //    exact: routing_paths[0] is the route that was chosen and whose metrics
  //    the score reflects; the rest are the non-dominated alternatives the
  //    policy weighed. `maxProvPaths` bounds the frontier per candidate.
  const frontiers = frontierPaths(plainGraph, ROUTE_WEIGHT_DIMENSIONS, selfId, {
    ...(config?.maxProvPaths != null ? { maxPaths: config.maxProvPaths } : {}),
  });
  const hwByEdge = edgeHwScores(selfId, candidates, config?.peerEdges);
  const candidateMap = new Map<string, CandidateProfile>();
  for (const c of candidates) candidateMap.set(c.motebit_id, c);
  const scores: ExplainedRouteScore[] = [];
  for (const [nodeId, frontier] of frontiers) {
    if (nodeId === selfId) continue;
    const picked = pickRoute(frontier, (w, path) =>
      scoreRoute(
        nodeId,
        w,
        candidateMap.get(nodeId),
        requirements,
        weights,
        compositeFn,
        chainHwForPath(selfId, path, hwByEdge),
      ),
    );
    if (!picked) continue;
    scores.push({
      ...picked.score,
      routing_paths: picked.ordered.map((p) => [...p.path]),
      alternatives_considered: picked.viable,
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
