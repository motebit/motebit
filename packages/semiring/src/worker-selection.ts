/**
 * First-person worker selection — "which agent should *I* hire for this
 * capability?", answered from the caller's OWN pairwise trust, never a global
 * reputation score.
 *
 * This is the sovereign counterpart to the relay's `graphRankCandidates`
 * (packages/market): the relay ranks with whatever trust the *caller* has
 * disclosed; this ranks with the trust the caller holds locally in its own
 * `agent_trust` ledger. Same semiring, different vantage — the delegating
 * molecule decides, in-process, from first-person edges keyed
 * `(self, remote)`. There is no global score to consult and none is
 * constructed: that refusal IS the sybil resistance (a throwaway identity
 * starts at the cold-start floor and has to earn its way up through real
 * completed work, per docs/doctrine/agents-as-first-person-trust-graph.md).
 *
 * It is a thin, pure convenience over `rankReachableAgents`: build a
 * single-hop star graph (self → each admissible candidate) over the
 * multi-objective `RouteWeightSemiring`, rank, return the winner with the
 * `route` that produced the score as its provenance ("why this worker").
 *
 * The three axes carry one signal each:
 *   - trust       = the earned categorical level (`trustLevelToScore`), with a
 *                   0.1 cold-start floor so an UNKNOWN-but-capable worker is
 *                   still hireable — you cannot have earned trust before you
 *                   have worked together.
 *   - reliability = Beta-binomial success rate (Laplace prior α=β=1) — the
 *                   CONTINUOUS accumulation lever: each successful task nudges a
 *                   worker above an untried one without waiting for a
 *                   categorical promotion. This is where thesis #2 (more
 *                   capable the longer it runs) shows up in the *hand*.
 *   - cost        = the worker's unit_cost for the capability (cheaper wins
 *                   ties). `rankReachableAgents` normalizes cost as 1/(1+cost),
 *                   which is nearly flat below ~$0.10 — so at micro-price scale
 *                   cost is deliberately a WEAK tiebreaker (you don't ditch a
 *                   trusted worker to save a fraction of a cent); it only
 *                   dominates across dollar-scale gaps. A relative (ratio) cost
 *                   normalization is a future refinement if sub-cent price
 *                   competition ever needs to matter. Latency and
 *                   regulatory-risk are left at neutral defaults — the
 *                   client-side discovery read carries neither.
 *
 * Selection is deterministic: highest composite score, ties broken by
 * `motebit_id` ascending so the same inputs always yield the same hire
 * (surface-determinism — a routing decision must be reproducible).
 */

import type { AgentTrustRecord, MotebitId } from "@motebit/protocol";
import { AgentTrustLevel, trustLevelToScore, WeightedDigraph } from "@motebit/protocol";
import { RouteWeightSemiring, rankReachableAgents, type RouteWeight } from "./agent-network.js";
import { thompsonDraw } from "./thompson.js";

/** Neutral latency assumed when the client-side discovery read carries none. */
const DEFAULT_LATENCY_MS = 5000;

/**
 * Exploration turns pure exploitation (always hire the best-known) into a
 * Bayesian bandit that occasionally tries a newcomer — the on-ramp that keeps
 * the market from ossifying into incumbency lock-in. See
 * docs/doctrine/exploration-as-market-vitality.md.
 */
export interface ExplorationConfig {
  /**
   * Deterministic seed for the Thompson draw. Derive it from SIGNED, recorded
   * context — the delegation token's `jti` — so the exploration decision is
   * reproducible and offline-verifiable ("this newcomer was tried because
   * seed→draw beat the incumbent"), never a hidden `Math.random`.
   */
  seed: string;
  /**
   * Exploration strength ∈ [0,1]: 1 = full Thompson draw, 0 = posterior mean
   * (pure exploit). The runtime scales this DOWN with delegation stakes — you
   * explore where a bad pick is cheap, never on a high-value hop. Default 1.
   */
  strength?: number;
}

/**
 * The categorical trust level as a WEAK Beta prior (pseudo-counts) on the
 * latent "will this worker do a good job". Real task counts dominate within a
 * few observations; the prior only nudges an unproven worker. UNKNOWN /
 * FirstContact = uniform Beta(1,1) — the true newcomer, maximum uncertainty,
 * the widest posterior and so the most exploration.
 */
function levelPrior(level: AgentTrustLevel | undefined): { a: number; b: number } {
  switch (level) {
    case AgentTrustLevel.Trusted:
      return { a: 3, b: 1 };
    case AgentTrustLevel.Verified:
      return { a: 2, b: 1 };
    default:
      return { a: 1, b: 1 };
  }
}

/**
 * Counts saturate: past this many observations the posterior is already tight,
 * and capping bounds the sampler's O(α+β) work. Mirrors the volume-saturation
 * ethos in `@motebit/policy`'s reputation score.
 */
const COUNT_CAP = 100;

/**
 * A verified commitment bond multiplies exploration strength (capped at 1) — a
 * bonded newcomer is sampled harder, so it earns its shot sooner. Multiplicative
 * so it respects the stakes floor: `strength 0` (a high-value hop) stays 0 even
 * when bonded — a bond buys PRIORITY, never a pass onto a job where exploring is
 * expensive, and never a quality boost.
 */
const BOND_EXPLORE_BOOST = 2;

/**
 * The unified quality signal in explore mode: build the Beta posterior from the
 * level-prior + capped task counts, Thompson-draw θ̃ seeded per (context,
 * worker), and blend toward the mean by the effective `strength` (0 ⇒ pure
 * mean, pure exploit). A newcomer's wide Beta(1,1) draws high often enough to
 * earn a shot; an incumbent's tight posterior almost always wins; a
 * repeat-failer's posterior collapses toward 0. The exploration budget IS the
 * posterior — there is no fixed rate to farm.
 */
function exploratoryQuality(c: RankableWorker, explore: ExplorationConfig): number {
  const prior = levelPrior(c.trustRecord?.trust_level);
  const alpha = prior.a + Math.min(c.trustRecord?.successful_tasks ?? 0, COUNT_CAP);
  const beta = prior.b + Math.min(c.trustRecord?.failed_tasks ?? 0, COUNT_CAP);
  const mean = alpha / (alpha + beta);
  const base = explore.strength ?? 1;
  const strength = c.bonded ? Math.min(1, base * BOND_EXPLORE_BOOST) : base;
  if (strength <= 0) return mean;
  const draw = thompsonDraw(alpha, beta, `${explore.seed}|${c.motebit_id}`);
  return mean + strength * (draw - mean);
}

/**
 * A capability-admissible candidate to rank. The caller is responsible for the
 * HARD gates (advertises the capability, is P2P-eligible, declares a settlement
 * address, is not self) before ranking — this function only ORDERS the
 * survivors. `trustRecord` is the caller's own first-person edge to the
 * candidate (null ⇒ never worked together ⇒ cold-start floor).
 */
export interface RankableWorker {
  motebit_id: string;
  /** The caller's first-person trust edge to this worker, or null if unknown. */
  trustRecord: AgentTrustRecord | null;
  /** The worker's unit_cost for the requested capability, USD. Absent ⇒ treated as free (0). */
  unitCost?: number;
  /**
   * Whether this candidate posts a verified commitment bond. In EXPLORE mode a
   * bond raises exploration PRIORITY — a bonded newcomer is sampled harder, so
   * it earns its first shot sooner — and, because a bond costs real sovereign
   * capital, it bounds a sybil SWARM (many throwaway identities each drawing a
   * job). It never touches the quality estimate: skin-in-the-game signals "I
   * won't rug you", never "I'm good at the task". Ignored in pure-exploit
   * ranking. See docs/doctrine/exploration-as-market-vitality.md.
   */
  bonded?: boolean;
}

/** A ranked worker: its composite score and the `route` weight that produced it (the "why"). */
export interface WorkerRanking {
  motebit_id: string;
  score: number;
  /** Provenance — the per-axis weight that produced the score. Renderable as "chosen because …". */
  route: RouteWeight;
}

/** Relative weight of each axis in the composite. Defaults are trust-dominant, cost + reliability material. */
export interface WorkerSelectionWeights {
  trust: number;
  cost: number;
  latency: number;
  reliability: number;
}

const DEFAULT_WEIGHTS: WorkerSelectionWeights = {
  trust: 0.5,
  reliability: 0.3,
  cost: 0.2,
  latency: 0,
};

/**
 * Beta-binomial success rate with a uniform prior (Laplace smoothing, α=β=1):
 * no history ⇒ 0.5 (genuinely uncertain), 1/1 ⇒ 0.67, 0/1 ⇒ 0.33. Converges to
 * the maximum-likelihood rate as evidence accumulates. Inlined (trivial, no
 * state/IO) rather than reaching up to `@motebit/policy`'s scalar
 * `computeReputationScore`, which collapses success+volume+recency into ONE
 * number — here each axis stays separate so the composite weights can trade
 * them off. Same prior, same intent.
 */
function reliabilityOf(record: AgentTrustRecord | null): number {
  if (!record) return 0.5;
  const successful = record.successful_tasks ?? 0;
  const failed = record.failed_tasks ?? 0;
  return (1 + successful) / (2 + successful + failed);
}

/**
 * Rank capability-admissible candidates by first-person composite score,
 * best first. Blocked workers are excluded (zero trust annihilates the edge).
 * Deterministic: score descending, then `motebit_id` ascending.
 */
export function rankWorkers(
  selfId: MotebitId,
  candidates: readonly RankableWorker[],
  opts?: { weights?: WorkerSelectionWeights; explore?: ExplorationConfig },
): WorkerRanking[] {
  const weights = opts?.weights ?? DEFAULT_WEIGHTS;
  const explore = opts?.explore;

  const graph = new WeightedDigraph(RouteWeightSemiring);
  graph.addNode(selfId);
  for (const c of candidates) {
    // Blocked: excluded entirely (matches buildAgentGraph's annihilation).
    if (c.trustRecord?.trust_level === AgentTrustLevel.Blocked) continue;
    // In explore mode, trust and reliability COLLAPSE into one Thompson-drawn
    // quality posterior (they were always two views of one latent quality), so
    // both axes carry the same draw — the composite counts it with the combined
    // trust+reliability weight, no weight remapping needed. In exploit mode they
    // stay separate exactly as shipped (backward-compatible when `explore` is
    // absent).
    const trust = explore
      ? exploratoryQuality(c, explore)
      : trustLevelToScore(c.trustRecord?.trust_level ?? AgentTrustLevel.Unknown);
    const reliability = explore ? trust : reliabilityOf(c.trustRecord);
    graph.setEdge(selfId, c.motebit_id, {
      trust,
      cost: c.unitCost ?? 0,
      latency: DEFAULT_LATENCY_MS,
      reliability,
      regulatory_risk: 0,
    });
  }

  const ranked = rankReachableAgents(graph, selfId, {
    trust: weights.trust,
    cost: weights.cost,
    latency: weights.latency,
    reliability: weights.reliability,
    regulatory_risk: 0,
  });

  // rankReachableAgents already sorts by score desc; make ties deterministic by
  // motebit_id so the same candidate set always yields the same hire.
  return ranked
    .map((r) => ({ motebit_id: r.motebit_id, score: r.score, route: r.route }))
    .sort((a, b) => b.score - a.score || (a.motebit_id < b.motebit_id ? -1 : 1));
}

/**
 * Pick the single best worker for a capability from the caller's first-person
 * vantage, or null if there are no admissible candidates. The winner's `route`
 * is its selection provenance.
 */
export function selectWorker(
  selfId: MotebitId,
  candidates: readonly RankableWorker[],
  opts?: { weights?: WorkerSelectionWeights; explore?: ExplorationConfig },
): WorkerRanking | null {
  return rankWorkers(selfId, candidates, opts)[0] ?? null;
}
