import { describe, it, expect } from "vitest";
import { scoreCandidate, rankCandidates } from "../scoring.js";
import type { CandidateProfile, TaskRequirements } from "../scoring.js";
import { AgentTrustLevel, asMotebitId, asListingId } from "@motebit/sdk";
import type { AgentTrustRecord, AgentServiceListing } from "@motebit/sdk";

function makeTrustRecord(
  overrides: Partial<AgentTrustRecord> = {},
): AgentTrustRecord {
  return {
    motebit_id: "local",
    remote_motebit_id: "remote-1",
    trust_level: AgentTrustLevel.Verified,
    first_seen_at: Date.now() - 100_000,
    last_seen_at: Date.now(),
    interaction_count: 10,
    successful_tasks: 8,
    failed_tasks: 2,
    ...overrides,
  };
}

function makeListing(
  overrides: Partial<AgentServiceListing> = {},
): AgentServiceListing {
  return {
    listing_id: asListingId("listing-1"),
    motebit_id: asMotebitId("remote-1"),
    capabilities: ["web_search", "read_url"],
    pricing: [{ capability: "web_search", unit_cost: 0.01, currency: "USD", per: "task" }],
    sla: { max_latency_ms: 5000, availability_guarantee: 0.99 },
    description: "Test service",
    updated_at: Date.now(),
    ...overrides,
  };
}

function makeCandidate(
  overrides: Partial<CandidateProfile> = {},
): CandidateProfile {
  return {
    motebit_id: asMotebitId("remote-1"),
    trust_record: makeTrustRecord(),
    listing: makeListing(),
    latency_stats: { avg_ms: 1000, p95_ms: 3000, sample_count: 50 },
    is_online: true,
    ...overrides,
  };
}

const defaultReqs: TaskRequirements = {
  required_capabilities: ["web_search"],
  max_budget: 1.0,
};

describe("scoreCandidate", () => {
  it("scores a fully qualified candidate", () => {
    const score = scoreCandidate(makeCandidate(), defaultReqs);
    expect(score.composite).toBeGreaterThan(0);
    expect(score.composite).toBeLessThanOrEqual(1);
    expect(score.sub_scores.trust).toBe(0.6); // Verified
    expect(score.sub_scores.availability).toBe(1.0);
    expect(score.sub_scores.capability_match).toBe(1.0);
  });

  it("returns 0 for blocked agents", () => {
    const score = scoreCandidate(
      makeCandidate({ trust_record: makeTrustRecord({ trust_level: AgentTrustLevel.Blocked }) }),
      defaultReqs,
    );
    expect(score.composite).toBe(0);
    expect(score.sub_scores.trust).toBe(0.0);
  });

  it("returns 0 for missing required capabilities", () => {
    const reqs: TaskRequirements = { required_capabilities: ["code_exec"] };
    const score = scoreCandidate(makeCandidate(), reqs);
    expect(score.composite).toBe(0);
    expect(score.sub_scores.capability_match).toBe(0);
  });

  it("uses defaults for null trust record", () => {
    const score = scoreCandidate(
      makeCandidate({ trust_record: null }),
      defaultReqs,
    );
    expect(score.sub_scores.trust).toBe(0.1);
    expect(score.sub_scores.success_rate).toBe(0.5);
  });

  it("uses defaults for null latency stats", () => {
    const score = scoreCandidate(
      makeCandidate({ latency_stats: null }),
      defaultReqs,
    );
    expect(score.sub_scores.latency).toBe(0.5);
  });

  it("scores offline candidates with 0 availability", () => {
    const score = scoreCandidate(
      makeCandidate({ is_online: false }),
      defaultReqs,
    );
    expect(score.sub_scores.availability).toBe(0.0);
  });

  it("respects all trust levels", () => {
    const levels = [
      [AgentTrustLevel.Unknown, 0.1],
      [AgentTrustLevel.FirstContact, 0.3],
      [AgentTrustLevel.Verified, 0.6],
      [AgentTrustLevel.Trusted, 0.9],
    ] as const;
    for (const [level, expected] of levels) {
      const score = scoreCandidate(
        makeCandidate({ trust_record: makeTrustRecord({ trust_level: level }) }),
        defaultReqs,
      );
      expect(score.sub_scores.trust).toBe(expected);
    }
  });

  it("uses default price efficiency when no pricing", () => {
    const score = scoreCandidate(
      makeCandidate({ listing: makeListing({ pricing: [] }) }),
      defaultReqs,
    );
    expect(score.sub_scores.price_efficiency).toBe(0.7);
  });

  it("respects custom weight config", () => {
    const score = scoreCandidate(makeCandidate(), defaultReqs, {
      weight_trust: 1.0,
      weight_success_rate: 0,
      weight_latency: 0,
      weight_price_efficiency: 0,
      weight_capability_match: 0,
      weight_availability: 0,
    });
    expect(score.composite).toBeCloseTo(0.6); // trust=0.6 * 1.0
  });

  it("normalizes latency with configurable K", () => {
    const scoreDefault = scoreCandidate(
      makeCandidate({ latency_stats: { avg_ms: 5000, p95_ms: 10000, sample_count: 10 } }),
      defaultReqs,
    );
    const scoreHighK = scoreCandidate(
      makeCandidate({ latency_stats: { avg_ms: 5000, p95_ms: 10000, sample_count: 10 } }),
      defaultReqs,
      { latency_norm_k: 10000 },
    );
    expect(scoreHighK.sub_scores.latency).toBeGreaterThan(scoreDefault.sub_scores.latency);
  });

  it("returns 1.0 capability match when no capabilities required", () => {
    const score = scoreCandidate(makeCandidate(), { required_capabilities: [] });
    expect(score.sub_scores.capability_match).toBe(1.0);
  });

  it("returns 0 capability match for null listing with required caps", () => {
    const score = scoreCandidate(
      makeCandidate({ listing: null }),
      defaultReqs,
    );
    expect(score.sub_scores.capability_match).toBe(0);
    expect(score.composite).toBe(0);
  });
});

describe("rankCandidates", () => {
  it("sorts candidates by composite score descending", () => {
    const candidates = [
      makeCandidate({ motebit_id: asMotebitId("low"), trust_record: makeTrustRecord({ trust_level: AgentTrustLevel.Unknown }) }),
      makeCandidate({ motebit_id: asMotebitId("high"), trust_record: makeTrustRecord({ trust_level: AgentTrustLevel.Trusted }) }),
      makeCandidate({ motebit_id: asMotebitId("mid") }),
    ];
    const ranked = rankCandidates(candidates, defaultReqs);
    expect(ranked[0]!.motebit_id).toBe("high");
    expect(ranked[ranked.length - 1]!.motebit_id).toBe("low");
  });

  it("marks top N as selected", () => {
    const candidates = Array.from({ length: 15 }, (_, i) =>
      makeCandidate({ motebit_id: asMotebitId(`agent-${i}`) }),
    );
    const ranked = rankCandidates(candidates, defaultReqs, { max_candidates: 5 });
    const selected = ranked.filter((r) => r.selected);
    expect(selected.length).toBe(5);
  });

  it("does not select zero-scored candidates", () => {
    const candidates = [
      makeCandidate({ trust_record: makeTrustRecord({ trust_level: AgentTrustLevel.Blocked }) }),
      makeCandidate({ motebit_id: asMotebitId("good") }),
    ];
    const ranked = rankCandidates(candidates, defaultReqs);
    const blocked = ranked.find((r) => r.composite === 0);
    expect(blocked?.selected).toBe(false);
  });

  it("handles empty candidates list", () => {
    const ranked = rankCandidates([], defaultReqs);
    expect(ranked).toEqual([]);
  });
});
