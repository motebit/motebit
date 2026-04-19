/**
 * Trust propagation across the credential graph — the third semiring
 * consumer in the codebase.
 *
 * Prior consumers (in order of landing):
 *   #1 agent-routing in `@motebit/semiring` (multi-objective
 *      `RouteWeightSemiring` over delegation edges)
 *   #2 memory retrieval in `@motebit/memory-graph/retrieval.ts` (five
 *      scalar lenses over the memory graph)
 *   #2b notability ranking in `@motebit/memory-graph/notability.ts`
 *       (record-shaped `NotabilitySemiring` for reflection)
 *   #3 trust propagation here (max-times `TrustSemiring` over
 *      peer-issued credentials)
 *
 * ## What this solves
 *
 * Today `credential-weight.ts` aggregates peer-issued reputation
 * credentials, weighting each by its issuer's trust. But it asks the
 * caller for `getIssuerTrust(issuerDid)` — and the caller typically
 * answers only with one-hop trust: "how much do I directly trust this
 * issuer?" Multi-hop trust — the KYB-verified anchor vouching for the
 * service provider vouching for the subject — had no primitive. Each
 * call site would have to walk the credential graph itself, combining
 * weights along paths, choosing among parallel chains. That is the
 * exact shape the semiring pattern exists to collapse.
 *
 * `propagateTrust` walks the credential graph once under
 * `TrustSemiring` (max-times): along a chain, trust is the product of
 * edge weights; across parallel attestation paths, the maximum wins.
 * Consumers now ask "what is the propagated trust of this agent?" and
 * get both the score and the provenance chain — so UI and audit can
 * show *why* the score is what it is, and revocation of any link
 * re-propagates the whole thing deterministically.
 *
 * ## Algebra
 *
 * Roots are seeded with trust = 1 (= `TrustSemiring.one`). All other
 * agents start at 0 (= `TrustSemiring.zero`). A synthetic super-source
 * emits weight=1 edges to each root so a single `optimalPathTrace`
 * call from the super-source computes every agent's best propagated
 * trust plus its provenance chain.
 *
 * ## Drift gate #30
 *
 * `check-trust-propagation-primitives.ts` — inline reinvention (iterate
 * over credentials, multiply issuer-trust × credential-weight, pick max
 * across competing issuers) anywhere outside `@motebit/market` is a CI
 * failure. Same shape as #27/#28/#29.
 */

import type { MotebitId } from "@motebit/protocol";
import { WeightedDigraph, TrustSemiring, optimalPathTrace } from "@motebit/protocol";

/** A single peer attestation in the credential graph. */
export interface CredentialEdge {
  /** did:key or motebit_id of the credential issuer. */
  readonly issuer: MotebitId;
  /** did:key or motebit_id of the credential subject (recipient). */
  readonly subject: MotebitId;
  /** Trust signal from the credential body, in [0, 1]. Typically
   *  `credentialSubject.success_rate` for reputation VCs or
   *  `credentialSubject.trust_score` for trust VCs. */
  readonly weight: number;
}

export interface TrustPropagationOptions {
  /** Agents seeded with trust = 1 (the trust anchors). Must be non-empty. */
  readonly roots: ReadonlyArray<MotebitId>;
  /** Minimum propagated trust to include in the result. Default 0.01. */
  readonly minTrust?: number;
  /** If true, roots themselves are included in the result (trust = 1).
   *  Default false — a root attesting to itself is not a propagation. */
  readonly includeRoots?: boolean;
}

export interface PropagatedTrust {
  readonly agentId: MotebitId;
  /** Best propagated trust score from any root, in [0, 1]. */
  readonly trust: number;
  /** Provenance chain from the root to this agent (root first, agent
   *  last). `path[0]` is always a root; `path.length - 1` is the depth. */
  readonly path: ReadonlyArray<MotebitId>;
  /** Number of credential edges traversed from the root to this agent.
   *  A root itself has depth 0; a direct peer of a root has depth 1. */
  readonly depth: number;
}

/** Reserved super-source node id — must not collide with any real
 *  motebit_id. Centralized const so the gate and callers see the same
 *  symbol. */
export const TRUST_SUPER_SOURCE = "__trust_super_source__";

/**
 * Build the trust-propagation digraph from the supplied credential edges.
 *
 * Parallel edges between the same (issuer, subject) pair collapse via
 * `TrustSemiring.add` (max) — duplicate credentials of different ages
 * or weights resolve to the strongest signal, which matches the
 * attestation-aggregation shape in `credential-weight.ts`.
 *
 * Exported for advanced consumers that want to compose this graph with
 * additional edge sources (e.g. delegation receipts) before traversing.
 */
export function buildTrustGraph(
  credentials: ReadonlyArray<CredentialEdge>,
  roots: ReadonlyArray<MotebitId>,
): WeightedDigraph<number> {
  const graph = new WeightedDigraph(TrustSemiring);
  graph.addNode(TRUST_SUPER_SOURCE);

  for (const root of roots) {
    // Weight = 1 from super-source means roots emerge with trust = 1
    // after traversal (1 × 1 = 1 under the TrustSemiring mul).
    graph.setEdge(TRUST_SUPER_SOURCE, root, TrustSemiring.one);
  }

  for (const edge of credentials) {
    if (!Number.isFinite(edge.weight)) continue;
    if (edge.weight <= 0) continue;
    if (edge.weight > 1) {
      // Clamp: TrustSemiring operates on [0, 1]; a weight > 1 would
      // produce trust > 1 along a chain, which breaks the bound.
      graph.addEdge(edge.issuer, edge.subject, 1);
    } else {
      graph.addEdge(edge.issuer, edge.subject, edge.weight);
    }
  }

  return graph;
}

/**
 * Propagate trust from roots to every reachable agent via credential
 * chains.
 *
 * Returns propagated-trust records ordered by trust descending. Each
 * record carries the best path the traversal found — consumers wanting
 * to render "trust flows through X → Y → Z" can read `path` directly.
 *
 * Idempotent, pure, deterministic given the same inputs.
 */
export function propagateTrust(
  credentials: ReadonlyArray<CredentialEdge>,
  options: TrustPropagationOptions,
): ReadonlyArray<PropagatedTrust> {
  if (options.roots.length === 0) return [];

  const minTrust = options.minTrust ?? 0.01;
  const includeRoots = options.includeRoots ?? false;
  const rootSet = new Set(options.roots);

  const graph = buildTrustGraph(credentials, options.roots);
  const results: PropagatedTrust[] = [];

  for (const agentId of graph.nodes()) {
    if (agentId === TRUST_SUPER_SOURCE) continue;
    if (!includeRoots && rootSet.has(agentId as MotebitId)) continue;

    const traced = optimalPathTrace(graph, TRUST_SUPER_SOURCE, agentId);
    if (!traced) continue;
    if (traced.value < minTrust) continue;

    // Strip the synthetic super-source prefix — consumers don't want
    // to see "__trust_super_source__" in the provenance chain.
    const realPath = traced.path.slice(1) as MotebitId[];
    if (realPath.length === 0) continue;

    results.push({
      agentId: agentId as MotebitId,
      trust: traced.value,
      path: realPath,
      depth: realPath.length - 1,
    });
  }

  results.sort((a, b) => b.trust - a.trust);
  return results;
}

/**
 * Convenience lookup: precompute the propagated-trust map once, return
 * a `getIssuerTrust(did)` function suitable for passing directly to
 * `aggregateCredentialReputation` in `credential-weight.ts`.
 *
 * When an issuer has no propagated trust from any root, returns 0 —
 * `aggregateCredentialReputation` already applies `minIssuerTrust`
 * filtering so untrusted issuers are dropped without additional logic
 * at this boundary.
 */
export function makeIssuerTrustResolver(
  credentials: ReadonlyArray<CredentialEdge>,
  options: TrustPropagationOptions,
): (issuerDid: string) => number {
  const propagated = propagateTrust(credentials, { ...options, includeRoots: true });
  const map = new Map<string, number>();
  for (const p of propagated) {
    map.set(p.agentId, p.trust);
  }
  return (issuerDid) => map.get(issuerDid) ?? 0;
}
