import type {
  AgentTrustRecord,
  AgentServiceListing,
  MotebitId,
  MarketConfig,
  HardwareAttestationClaim,
} from "@motebit/protocol";

export interface CandidateProfile {
  motebit_id: MotebitId;
  trust_record: AgentTrustRecord | null;
  listing: AgentServiceListing | null;
  latency_stats: { avg_ms: number; p95_ms: number; sample_count: number } | null;
  is_online: boolean;
  /** Pre-composed chain trust score from delegation receipt tree. When set, overrides trust_record lookup. */
  chain_trust?: number;
  /** Aggregated reputation from peer-issued credentials. When set, blended into trust edge weight. */
  credential_reputation?: import("./credential-weight.js").CredentialReputation;
  /** Guardian public key (hex) if agent is under organizational custody. Same guardian = same org. */
  guardian_public_key?: string;
  /** Agent's MCP endpoint URL (from agent_registry). Used for sovereign delegation. */
  endpoint_url?: string;
  /**
   * Hardware attestation claim extracted from the candidate's most
   * recent `TrustCredential`'s `credentialSubject.hardware_attestation`.
   * Absent when the candidate hasn't published one; the routing path
   * scores `HW_ATTESTATION_NONE` (0.0) and the trust edge is unaffected.
   * Present with `platform: "secure_enclave"` or similar → the edge's
   * trust score is multiplicatively boosted via
   * `HardwareAttestationSemiring`'s scoring.
   */
  hardware_attestation?: HardwareAttestationClaim;
  /**
   * Aggregated hardware-attestation evidence from peer-issued
   * `AgentTrustCredential`s about this candidate. Populated by
   * `aggregateHardwareAttestation`. When set, the routing path
   * prefers `attestation_score` over the self-claim path above —
   * peer-verified evidence dominates self-attestation. Absent when no
   * peer has issued a trust credential carrying a `hardware_attestation`
   * claim about this candidate. Phase 1 of the hardware-attestation peer
   * flow (see docs/doctrine/promoting-private-to-public.md companion).
   */
  hardware_attestation_aggregate?: import("./credential-weight.js").HardwareAttestationAggregate;
}

export interface TaskRequirements {
  required_capabilities: string[];
  max_budget?: number;
  currency?: string;
  max_latency_ms?: number;
}

const DEFAULT_CONFIG: MarketConfig = {
  weight_trust: 0.25,
  weight_success_rate: 0.25,
  weight_latency: 0.15,
  weight_price_efficiency: 0.15,
  weight_capability_match: 0.1,
  weight_availability: 0.1,
  latency_norm_k: 5000,
  max_candidates: 10,
  settlement_timeout_ms: 30_000,
};

/**
 * Pure: apply active inference precision to market config.
 *
 * When explorationDrive is high (low self-trust), the agent diversifies:
 * - Lowers trust/success_rate weight (less reliance on known reputation)
 * - Raises availability/capability weight (more willingness to try new agents)
 * - Adds epsilon-greedy noise via exploration_weight
 *
 * When explorationDrive is low (high self-trust), weights stay near defaults:
 * exploit known-good routes.
 */
export function applyPrecisionToMarketConfig(
  base: Partial<MarketConfig> | undefined,
  explorationDrive: number,
): Partial<MarketConfig> {
  const cfg = { ...DEFAULT_CONFIG, ...base };
  const e = Math.max(0, Math.min(1, explorationDrive));

  // Shift weight from trust/success_rate toward availability/capability
  // At e=0 (exploit): no change. At e=1 (explore): ±0.10 shift.
  return {
    ...cfg,
    weight_trust: cfg.weight_trust - e * 0.1,
    weight_success_rate: cfg.weight_success_rate - e * 0.1,
    weight_capability_match: cfg.weight_capability_match + e * 0.1,
    weight_availability: cfg.weight_availability + e * 0.1,
    exploration_weight: e,
  };
}
