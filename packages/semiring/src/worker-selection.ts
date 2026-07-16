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

/** Neutral latency assumed when the client-side discovery read carries none. */
const DEFAULT_LATENCY_MS = 5000;

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
  opts?: { weights?: WorkerSelectionWeights },
): WorkerRanking[] {
  const weights = opts?.weights ?? DEFAULT_WEIGHTS;

  const graph = new WeightedDigraph(RouteWeightSemiring);
  graph.addNode(selfId);
  for (const c of candidates) {
    // Blocked: excluded entirely (matches buildAgentGraph's annihilation).
    if (c.trustRecord?.trust_level === AgentTrustLevel.Blocked) continue;
    const trust = trustLevelToScore(c.trustRecord?.trust_level ?? AgentTrustLevel.Unknown);
    graph.setEdge(selfId, c.motebit_id, {
      trust,
      cost: c.unitCost ?? 0,
      latency: DEFAULT_LATENCY_MS,
      reliability: reliabilityOf(c.trustRecord),
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
  opts?: { weights?: WorkerSelectionWeights },
): WorkerRanking | null {
  return rankWorkers(selfId, candidates, opts)[0] ?? null;
}
