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
 * The success/fail counts that feed the reliability posterior, scoped to the
 * capability being hired when one is given.
 *
 * Competence is a SKILL, not a relationship: being reliable at `web_search`
 * says nothing about `read_url`. So when `capability` is set we read ONLY that
 * capability's bucket — a worker with a rich `web_search` history but no
 * `read_url` history is cold at `read_url` (0/0 ⇒ the uncertain 0.5 posterior),
 * exactly as if it were a newcomer for that skill. Crucially we do NOT fall
 * back to the aggregate when the bucket is absent: that fallback is precisely
 * the cross-capability bleed this scoping exists to remove. The pairwise
 * relationship still speaks — through the categorical `trust_level` prior
 * (`levelPrior`), which is capability-agnostic by design.
 *
 * With no `capability` (capability-blind callers, and the pre-scoping default)
 * this returns the aggregate counts — behavior is byte-identical to before.
 */
function competenceCounts(
  record: AgentTrustRecord | null,
  capability?: string,
): { successful: number; failed: number } {
  if (!record) return { successful: 0, failed: 0 };
  if (capability != null) {
    const bucket = record.capability_stats?.[capability];
    return { successful: bucket?.successful_tasks ?? 0, failed: bucket?.failed_tasks ?? 0 };
  }
  return { successful: record.successful_tasks ?? 0, failed: record.failed_tasks ?? 0 };
}

/**
 * A verified commitment bond multiplies exploration strength (capped at 1) — a
 * bonded newcomer is sampled harder, so it earns its shot sooner. Multiplicative
 * so it respects the stakes floor: `strength 0` (a high-value hop) stays 0 even
 * when bonded — a bond buys PRIORITY, never a pass onto a job where exploring is
 * expensive, and never a quality boost.
 */
const BOND_EXPLORE_BOOST = 2;

/** Clamp exploration strength to its documented [0,1] domain; non-finite ⇒ 0 (no exploration). */
function clampStrength(x: number): number {
  return Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0;
}

/**
 * Cap the TOTAL observed evidence at `COUNT_CAP` while PRESERVING the success/
 * failure ratio (integer-quantized — the Beta sampler needs integer shapes).
 *
 * Capping each side INDEPENDENTLY (an earlier version's bug) collapses the
 * posterior once both sides exceed the cap: a 1000/101 worker (mean ≈ 0.9) and
 * a 100/1000 worker (mean ≈ 0.09) would both saturate to (100,100) ≈ 0.5,
 * erasing the very ratio the posterior expresses. Scaling both by
 * `CAP/(s+f)` bounds the pseudocount (so the posterior stays wide enough to
 * keep exploring) without distorting the ratio.
 */
function cappedCounts(successful: number, failed: number): { s: number; f: number } {
  const s0 = Math.max(0, Math.floor(successful));
  const f0 = Math.max(0, Math.floor(failed));
  const total = s0 + f0;
  if (total <= COUNT_CAP) return { s: s0, f: f0 };
  const s = Math.round((s0 * COUNT_CAP) / total);
  return { s, f: COUNT_CAP - s };
}

/**
 * The unified quality signal in explore mode: build the Beta posterior from the
 * level-prior + ratio-preserving capped task counts, Thompson-draw θ̃ seeded
 * per (context, worker), and blend toward the mean by the effective `strength`.
 * A newcomer's wide Beta(1,1) draws high often enough to earn a shot; an
 * incumbent's tight posterior almost always wins; a repeat-failer's posterior
 * collapses toward 0. Callers reach this only when `strength > 0` (rankWorkers
 * routes strength-0 to the pure-exploit path); the internal guard is belt-and-
 * suspenders for direct callers.
 */
function exploratoryQuality(
  c: RankableWorker,
  explore: ExplorationConfig,
  capability?: string,
): number {
  const prior = levelPrior(c.trustRecord?.trust_level);
  const counts = competenceCounts(c.trustRecord, capability);
  const { s, f } = cappedCounts(counts.successful, counts.failed);
  const alpha = prior.a + s;
  const beta = prior.b + f;
  const mean = alpha / (alpha + beta);
  const base = clampStrength(explore.strength ?? 1);
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
function reliabilityOf(record: AgentTrustRecord | null, capability?: string): number {
  if (!record) return 0.5;
  const { successful, failed } = competenceCounts(record, capability);
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
  opts?: { weights?: WorkerSelectionWeights; explore?: ExplorationConfig; capability?: string },
): WorkerRanking[] {
  const weights = opts?.weights ?? DEFAULT_WEIGHTS;
  // Scope the reliability posterior to the capability being hired (competence is
  // a skill, not a relationship). Absent ⇒ the aggregate counts, byte-identical
  // to pre-scoping behavior. See competenceCounts + first-person-worker-routing.
  const capability = opts?.capability;
  // Exploration is ACTIVE only when a config is present AND its base strength is
  // positive. A base strength of 0 (a high-stakes hop, per the runtime's stakes
  // ramp) — and a bond can only RAISE strength, never lift 0 — routes to the
  // exact pure-exploit ranking below, so `{ explore: { strength: 0 } }` is
  // behaviourally identical to no-explore, not a distinct Bayesian-mean path.
  const explore =
    opts?.explore != null && clampStrength(opts.explore.strength ?? 1) > 0
      ? opts.explore
      : undefined;

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
    // absent OR base strength is 0).
    const trust = explore
      ? exploratoryQuality(c, explore, capability)
      : trustLevelToScore(c.trustRecord?.trust_level ?? AgentTrustLevel.Unknown);
    const reliability = explore ? trust : reliabilityOf(c.trustRecord, capability);
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
  opts?: { weights?: WorkerSelectionWeights; explore?: ExplorationConfig; capability?: string },
): WorkerRanking | null {
  return rankWorkers(selfId, candidates, opts)[0] ?? null;
}
