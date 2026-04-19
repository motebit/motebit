// ── Semiring Algebra (re-exported from @motebit/protocol) ──────────
export type { Semiring } from "@motebit/protocol";
export {
  TrustSemiring,
  CostSemiring,
  LatencySemiring,
  BottleneckSemiring,
  ReliabilitySemiring,
  BooleanSemiring,
  RegulatoryRiskSemiring,
  productSemiring,
  recordSemiring,
  mappedSemiring,
} from "@motebit/protocol";

// ── Weighted Directed Graph (re-exported from @motebit/protocol) ───
export type { Edge } from "@motebit/protocol";
export { WeightedDigraph } from "@motebit/protocol";

// ── Graph Traversal (re-exported from @motebit/protocol) ───────────
export { optimalPaths, optimalPath, transitiveClosure, optimalPathTrace } from "@motebit/protocol";

// ── Trust Algebra ─────────────────────────────────────────────────
// Protocol primitives (re-exported) + judgment functions (local BSL)
export type { DelegationReceiptLike } from "./trust-algebra.js";
export {
  TRUST_LEVEL_SCORES,
  trustLevelToScore,
  TRUST_ZERO,
  TRUST_ONE,
  trustAdd,
  trustMultiply,
  composeTrustChain,
  joinParallelRoutes,
  DEFAULT_TRUST_THRESHOLDS,
  evaluateTrustTransition,
  composeDelegationTrust,
} from "./trust-algebra.js";

// ── Provenance (BSL) ──────────────────────────────────────────────
export type { Provenance, Annotated } from "./provenance.js";
export { ProvenanceSemiring, boundedProvenanceSemiring, annotatedSemiring } from "./provenance.js";

// ── Agent Network Bridge (BSL) ────────────────────────────────────
export type { RouteWeight, AgentProfile } from "./agent-network.js";
export {
  RouteWeightSemiring,
  AnnotatedRouteWeightSemiring,
  buildAgentGraph,
  addDelegationEdges,
  mostTrustedPath,
  lowestRiskPath,
  cheapestPath,
  rankReachableAgents,
  projectGraph,
} from "./agent-network.js";

// ── Intent Disambiguation (BSL) ───────────────────────────────────
export type {
  DisambiguationSignal,
  DisambiguationResult,
  DisambiguateOptions,
  MatchDecision,
} from "./disambiguation.js";
export { disambiguate, stringSimilaritySignal, matchOrAsk } from "./disambiguation.js";
