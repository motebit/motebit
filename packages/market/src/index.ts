export { applyPrecisionToMarketConfig } from "./scoring.js";
export {
  buildRoutingGraph,
  graphRankCandidates,
  explainedRankCandidates,
  computeTrustClosure,
  findTrustedRoute,
  weightedSumComposite,
  lexicographicComposite,
} from "./graph-routing.js";
export type {
  ExplainedRouteScore,
  NormalizedScores,
  CompositeFunction,
  RoutingPolicy,
  RoutingConfig,
  RoutingWeights,
  PeerEdge,
} from "./graph-routing.js";
export type { CandidateProfile, TaskRequirements } from "./scoring.js";
export {
  aggregateCredentialReputation,
  aggregateHardwareAttestation,
  blendCredentialTrust,
} from "./credential-weight.js";
// Re-export the hardware-attestation scoring constants so consumers
// (e.g. services/api E2E tests, routing introspection) can reference
// the canonical values without depending on @motebit/semiring directly.
export {
  HW_ATTESTATION_HARDWARE,
  HW_ATTESTATION_HARDWARE_EXPORTED,
  HW_ATTESTATION_NONE,
  HW_ATTESTATION_SOFTWARE,
  scoreAttestation,
} from "@motebit/semiring";
export type {
  CredentialReputation,
  CredentialWeightConfig,
  HardwareAttestationAggregate,
  ReputationVC,
  TrustVC,
} from "./credential-weight.js";
export {
  propagateTrust,
  buildTrustGraph,
  makeIssuerTrustResolver,
  TRUST_SUPER_SOURCE,
} from "./trust-propagation.js";
export type {
  CredentialEdge,
  PropagatedTrust,
  TrustPropagationOptions,
} from "./trust-propagation.js";
export { allocateBudget, allocateCollaborativeBudget, estimateCost } from "./budget.js";
export type { AllocationRequest } from "./budget.js";
export { computeServiceReputation } from "./reputation.js";
export type { ReputationSnapshot } from "./reputation.js";
export {
  settleOnReceipt,
  validateAllocation,
  computeGrossAmount,
  canTransitionAllocation,
  assertAllocationTransition,
  shouldBatchSettle,
  DEFAULT_BATCH_POLICY,
} from "./settlement.js";
export type { AllocationStatus, BatchPolicy } from "./settlement.js";
export { scoreQuality } from "./quality-gate.js";
export type { QualityScore, QualityGateConfig } from "./quality-gate.js";
export { scoreResultQuality, QUALITY_FAILURE_THRESHOLD } from "./quality.js";
export {
  trustAdd,
  trustMultiply,
  composeTrustChain,
  joinParallelRoutes,
  composeDelegationTrust,
  trustLevelToScore,
  TRUST_ZERO,
  TRUST_ONE,
  TRUST_LEVEL_SCORES,
  evaluateTrustTransition,
  REFERENCE_TRUST_THRESHOLDS,
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- intentional re-export of deprecated alias
  DEFAULT_TRUST_THRESHOLDS,
} from "@motebit/semiring";
export type { DelegationReceiptLike } from "@motebit/semiring";
export { PLATFORM_FEE_RATE } from "@motebit/protocol";
export type { TrustTransitionThresholds } from "@motebit/protocol";
