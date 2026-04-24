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
  REFERENCE_TRUST_THRESHOLDS,
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- intentional re-export of deprecated alias
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

// ── Hardware Attestation (BSL) ────────────────────────────────────
// Fifth semiring consumer — ranks agents by hardware-custody strength
// of their identity key (Secure Enclave / TPM / DeviceCheck / Play
// Integrity / software / absent). Structurally identical to
// BottleneckSemiring under a different interpretation. See
// spec/credential-v1.md §3.4.
export type { HardwareAttestationScore } from "./hardware-attestation.js";
export {
  HardwareAttestationSemiring,
  HW_ATTESTATION_HARDWARE,
  HW_ATTESTATION_HARDWARE_EXPORTED,
  HW_ATTESTATION_SOFTWARE,
  HW_ATTESTATION_NONE,
  scoreAttestation,
  attestationRanksAbove,
} from "./hardware-attestation.js";
