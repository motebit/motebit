/**
 * Trust-weighted credential aggregation.
 *
 * One-pass EigenTrust: weight each peer-issued reputation credential by
 * the issuer's own trustworthiness (from the semiring trust closure),
 * apply freshness decay and sample-size confidence, then aggregate
 * into a single CredentialReputation that routing can consume.
 *
 * The pattern is the same used by PeerTrust and eBay-style reputation:
 * attestation_value × attester_authority × recency × confidence.
 */

import type { ReputationCredentialSubject } from "@motebit/sdk";
import { VC_TYPE_REPUTATION } from "@motebit/sdk";

/**
 * Minimal VerifiableCredential shape — avoids adding @motebit/crypto dependency.
 * Only the fields needed for aggregation: type, issuer, validFrom, credentialSubject.
 */
export interface ReputationVC {
  type: string[];
  issuer: string;
  validFrom?: string;
  credentialSubject: ReputationCredentialSubject & { id: string };
}

// ── Types ───────────────────────────────────────────────────────────

/** Aggregated reputation derived from multiple peer-issued credentials. */
export interface CredentialReputation {
  /** Weighted success rate [0,1]. */
  success_rate: number;
  /** Weighted average latency in ms. */
  avg_latency_ms: number;
  /** Total tasks across all credentials (deduplicated by weight). */
  effective_task_count: number;
  /** Weighted trust score [0,1]. */
  trust_score: number;
  /** Weighted availability [0,1]. */
  availability: number;
  /** Number of distinct issuers contributing. */
  issuer_count: number;
  /** Sum of all credential weights (0 = no usable credentials). */
  total_weight: number;
}

export interface CredentialWeightConfig {
  /** Freshness half-life in ms. Default: 24 hours. */
  freshnessHalfLifeMs?: number;
  /** Sample-size saturation constant. weight = min(task_count, k) / k. Default: 50. */
  sampleSaturationK?: number;
  /** Minimum issuer trust to consider a credential (skip unknown/untrusted issuers). Default: 0.05. */
  minIssuerTrust?: number;
}

const DEFAULT_FRESHNESS_HALF_LIFE_MS = 24 * 60 * 60 * 1000; // 24h
const DEFAULT_SAMPLE_SATURATION_K = 50;
const DEFAULT_MIN_ISSUER_TRUST = 0.05;

// ── Core ────────────────────────────────────────────────────────────

/**
 * Aggregate multiple peer-issued reputation credentials into a single
 * weighted reputation, using issuer trust as the authority signal.
 *
 * Pure function — no graph access, no side effects.
 *
 * @param credentials Reputation VCs about a single subject agent.
 * @param getIssuerTrust Returns the issuer's trust score [0,1] from the trust closure.
 *                       Accepts a did:key URI (the VC issuer field).
 * @param config Optional tuning parameters.
 */
export function aggregateCredentialReputation(
  credentials: ReadonlyArray<ReputationVC>,
  getIssuerTrust: (issuerDid: string) => number,
  config?: CredentialWeightConfig,
): CredentialReputation | null {
  const halfLife = config?.freshnessHalfLifeMs ?? DEFAULT_FRESHNESS_HALF_LIFE_MS;
  const satK = config?.sampleSaturationK ?? DEFAULT_SAMPLE_SATURATION_K;
  const minTrust = config?.minIssuerTrust ?? DEFAULT_MIN_ISSUER_TRUST;

  const now = Date.now();

  // Weighted accumulators
  let wSum = 0;
  let wSuccessRate = 0;
  let wLatency = 0;
  let wTrustScore = 0;
  let wAvailability = 0;
  let wTaskCount = 0;
  const issuers = new Set<string>();

  for (const vc of credentials) {
    // Only process reputation credentials
    if (!vc.type.includes(VC_TYPE_REPUTATION)) continue;

    const subject = vc.credentialSubject;
    const issuerDid = vc.issuer;

    // 0. Self-attestation filter: ignore credentials where the issuer is the subject.
    // These carry no trust signal — an agent vouching for itself is tautological.
    if (issuerDid === subject.id) continue;

    // 1. Issuer authority: how much do we trust the attester?
    const issuerTrust = getIssuerTrust(issuerDid);
    if (issuerTrust < minTrust) continue;

    // 2. Freshness: exponential decay from issuance time
    const issuedAt = vc.validFrom ? new Date(vc.validFrom).getTime() : 0;
    const age = Math.max(0, now - issuedAt);
    const freshness = Math.exp((-age * Math.LN2) / halfLife);

    // 3. Sample confidence: saturating function of task count
    const taskCount = subject.task_count ?? subject.sample_size ?? 1;
    const confidence = Math.min(taskCount, satK) / satK;

    // Combined weight: authority × freshness × confidence
    const w = issuerTrust * freshness * confidence;
    if (w <= 0) continue;

    wSum += w;
    wSuccessRate += w * subject.success_rate;
    wLatency += w * subject.avg_latency_ms;
    wTrustScore += w * subject.trust_score;
    wAvailability += w * subject.availability;
    wTaskCount += w * taskCount;
    issuers.add(issuerDid);
  }

  if (wSum === 0) return null;

  return {
    success_rate: wSuccessRate / wSum,
    avg_latency_ms: wLatency / wSum,
    effective_task_count: wTaskCount / wSum,
    trust_score: wTrustScore / wSum,
    availability: wAvailability / wSum,
    issuer_count: issuers.size,
    total_weight: wSum,
  };
}

/**
 * Blend credential-derived reputation into a trust edge weight.
 *
 * When credential reputation is available, it supplements the static
 * trust level score with empirical evidence from peer attestations.
 * The blend factor controls how much credential evidence influences
 * the final trust weight (0 = ignore credentials, 1 = credentials only).
 *
 * Uses a Bayesian-style blend: more issuer diversity and higher total
 * weight shift the blend toward credential evidence.
 *
 * @param staticTrust Trust score from TRUST_LEVEL_SCORES [0,1].
 * @param credRep Aggregated credential reputation (or null if none).
 * @param maxBlend Maximum influence of credentials on the final score. Default: 0.5.
 * @returns Blended trust score [0,1].
 */
export function blendCredentialTrust(
  staticTrust: number,
  credRep: CredentialReputation | null,
  maxBlend = 0.5,
): number {
  if (!credRep || credRep.total_weight === 0) return staticTrust;

  // Blend factor scales with evidence strength:
  // - More issuers → more diverse evidence → higher blend
  // - Higher total weight → more confident evidence → higher blend
  // Saturates at maxBlend.
  const diversityFactor = Math.min(credRep.issuer_count, 5) / 5;
  const weightFactor = Math.min(credRep.total_weight, 3) / 3;
  const blend = maxBlend * diversityFactor * weightFactor;

  // Credential trust signal: primarily success_rate (empirical),
  // secondarily the averaged trust_score from issuers
  const credTrust = credRep.success_rate * 0.7 + credRep.trust_score * 0.3;

  return staticTrust * (1 - blend) + credTrust * blend;
}
