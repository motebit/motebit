import type {
  AgentTrustRecord,
  AgentServiceListing,
  MotebitId,
  MarketConfig,
  RouteScore,
} from "@motebit/sdk";
import { AgentTrustLevel } from "@motebit/sdk";

export interface CandidateProfile {
  motebit_id: MotebitId;
  trust_record: AgentTrustRecord | null;
  listing: AgentServiceListing | null;
  latency_stats: { avg_ms: number; p95_ms: number; sample_count: number } | null;
  is_online: boolean;
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
  weight_capability_match: 0.10,
  weight_availability: 0.10,
  latency_norm_k: 5000,
  max_candidates: 10,
  settlement_timeout_ms: 30_000,
};

const TRUST_LEVEL_SCORES: Record<string, number> = {
  [AgentTrustLevel.Unknown]: 0.1,
  [AgentTrustLevel.FirstContact]: 0.3,
  [AgentTrustLevel.Verified]: 0.6,
  [AgentTrustLevel.Trusted]: 0.9,
  [AgentTrustLevel.Blocked]: 0.0,
};

function computeTrust(record: AgentTrustRecord | null): number {
  if (!record) return 0.1;
  return TRUST_LEVEL_SCORES[record.trust_level] ?? 0.1;
}

function computeSuccessRate(record: AgentTrustRecord | null): number {
  if (!record) return 0.5;
  const s = record.successful_tasks ?? 0;
  const f = record.failed_tasks ?? 0;
  const total = s + f;
  if (total === 0) return 0.5;
  return s / total;
}

function computeLatency(
  stats: { avg_ms: number } | null,
  k: number,
): number {
  if (!stats) return 0.5;
  return 1 - stats.avg_ms / (stats.avg_ms + k);
}

function computePriceEfficiency(
  listing: AgentServiceListing | null,
  requirements: TaskRequirements,
): number {
  if (!listing || listing.pricing.length === 0 || !requirements.max_budget) return 0.7;
  let totalCost = 0;
  for (const cap of requirements.required_capabilities) {
    const price = listing.pricing.find((p) => p.capability === cap);
    if (price) totalCost += price.unit_cost;
  }
  if (totalCost === 0) return 0.7;
  return Math.max(0, 1 - totalCost / requirements.max_budget);
}

function computeCapabilityMatch(
  listing: AgentServiceListing | null,
  requirements: TaskRequirements,
): number {
  if (requirements.required_capabilities.length === 0) return 1.0;
  if (!listing) return 0.0;
  const matched = requirements.required_capabilities.filter(
    (c) => listing.capabilities.includes(c),
  ).length;
  if (matched < requirements.required_capabilities.length) return 0.0;
  return matched / requirements.required_capabilities.length;
}

/** Pure: (candidate, requirements, config?) → RouteScore */
export function scoreCandidate(
  candidate: CandidateProfile,
  requirements: TaskRequirements,
  config?: Partial<MarketConfig>,
): RouteScore {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  const trust = computeTrust(candidate.trust_record);
  const success_rate = computeSuccessRate(candidate.trust_record);
  const latency = computeLatency(candidate.latency_stats, cfg.latency_norm_k);
  const price_efficiency = computePriceEfficiency(candidate.listing, requirements);
  const capability_match = computeCapabilityMatch(candidate.listing, requirements);
  const availability = candidate.is_online ? 1.0 : 0.0;

  // Hard filters: blocked agents and missing capabilities score 0
  const blocked = candidate.trust_record?.trust_level === AgentTrustLevel.Blocked;

  const composite = blocked || capability_match === 0
    ? 0
    : trust * cfg.weight_trust
      + success_rate * cfg.weight_success_rate
      + latency * cfg.weight_latency
      + price_efficiency * cfg.weight_price_efficiency
      + capability_match * cfg.weight_capability_match
      + availability * cfg.weight_availability;

  return {
    motebit_id: candidate.motebit_id,
    composite,
    sub_scores: { trust, success_rate, latency, price_efficiency, capability_match, availability },
    selected: false,
  };
}

/** Pure: (candidates[], requirements, config?) → sorted RouteScore[] with top N selected */
export function rankCandidates(
  candidates: CandidateProfile[],
  requirements: TaskRequirements,
  config?: Partial<MarketConfig>,
): RouteScore[] {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const scores = candidates.map((c) => scoreCandidate(c, requirements, cfg));
  scores.sort((a, b) => b.composite - a.composite);

  // Mark top N as selected (skip zero-scored)
  let selected = 0;
  for (const score of scores) {
    if (selected >= cfg.max_candidates || score.composite === 0) break;
    score.selected = true;
    selected++;
  }

  return scores;
}
