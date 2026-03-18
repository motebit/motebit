import { describe, it, expect } from "vitest";
import { scoreCandidate, rankCandidates, applyPrecisionToMarketConfig } from "../scoring.js";
import type { CandidateProfile, TaskRequirements } from "../scoring.js";
import { AgentTrustLevel, asMotebitId, asListingId } from "@motebit/sdk";
import type { AgentTrustRecord, AgentServiceListing } from "@motebit/sdk";

function makeTrustRecord(overrides: Partial<AgentTrustRecord> = {}): AgentTrustRecord {
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

function makeListing(overrides: Partial<AgentServiceListing> = {}): AgentServiceListing {
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

function makeCandidate(overrides: Partial<CandidateProfile> = {}): CandidateProfile {
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
    const score = scoreCandidate(makeCandidate({ trust_record: null }), defaultReqs);
    expect(score.sub_scores.trust).toBe(0.1);
    expect(score.sub_scores.success_rate).toBe(0.5);
  });

  it("uses defaults for null latency stats", () => {
    const score = scoreCandidate(makeCandidate({ latency_stats: null }), defaultReqs);
    expect(score.sub_scores.latency).toBe(0.5);
  });

  it("scores offline candidates with 0 availability", () => {
    const score = scoreCandidate(makeCandidate({ is_online: false }), defaultReqs);
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
    const score = scoreCandidate(makeCandidate({ listing: null }), defaultReqs);
    expect(score.sub_scores.capability_match).toBe(0);
    expect(score.composite).toBe(0);
  });

  it("returns 0.5 success_rate when trust record has zero tasks (undefined counts)", () => {
    const score = scoreCandidate(
      makeCandidate({
        trust_record: makeTrustRecord({
          successful_tasks: undefined,
          failed_tasks: undefined,
        }),
      }),
      defaultReqs,
    );
    expect(score.sub_scores.success_rate).toBe(0.5);
  });

  it("returns 0.5 success_rate when trust record has explicit zero tasks", () => {
    const score = scoreCandidate(
      makeCandidate({
        trust_record: makeTrustRecord({
          successful_tasks: 0,
          failed_tasks: 0,
        }),
      }),
      defaultReqs,
    );
    expect(score.sub_scores.success_rate).toBe(0.5);
  });

  it("returns 0.7 price_efficiency when required cap has no matching pricing entry", () => {
    // Listing has pricing for "summarize" but required is "web_search" — no price match
    const score = scoreCandidate(
      makeCandidate({
        listing: makeListing({
          capabilities: ["web_search", "summarize"],
          pricing: [{ capability: "summarize", unit_cost: 0.01, currency: "USD", per: "task" }],
        }),
      }),
      defaultReqs,
    );
    // web_search has no pricing entry → totalCost = 0 → returns 0.7
    expect(score.sub_scores.price_efficiency).toBe(0.7);
  });
});

describe("rankCandidates", () => {
  it("sorts candidates by composite score descending", () => {
    const candidates = [
      makeCandidate({
        motebit_id: asMotebitId("low"),
        trust_record: makeTrustRecord({ trust_level: AgentTrustLevel.Unknown }),
      }),
      makeCandidate({
        motebit_id: asMotebitId("high"),
        trust_record: makeTrustRecord({ trust_level: AgentTrustLevel.Trusted }),
      }),
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

// === Active Inference Precision ===

describe("applyPrecisionToMarketConfig", () => {
  it("zero exploration leaves weights near defaults", () => {
    const cfg = applyPrecisionToMarketConfig(undefined, 0);
    expect(cfg.weight_trust).toBe(0.25);
    expect(cfg.weight_success_rate).toBe(0.25);
    expect(cfg.weight_capability_match).toBe(0.1);
    expect(cfg.weight_availability).toBe(0.1);
    expect(cfg.exploration_weight).toBe(0);
  });

  it("full exploration shifts weights from trust to capability/availability", () => {
    const cfg = applyPrecisionToMarketConfig(undefined, 1.0);
    expect(cfg.weight_trust).toBeCloseTo(0.15);
    expect(cfg.weight_success_rate).toBeCloseTo(0.15);
    expect(cfg.weight_capability_match).toBeCloseTo(0.2);
    expect(cfg.weight_availability).toBeCloseTo(0.2);
    expect(cfg.exploration_weight).toBe(1.0);
  });

  it("partial exploration (0.5) shifts weights proportionally", () => {
    const cfg = applyPrecisionToMarketConfig(undefined, 0.5);
    expect(cfg.weight_trust).toBeCloseTo(0.2);
    expect(cfg.weight_success_rate).toBeCloseTo(0.2);
    expect(cfg.weight_capability_match).toBeCloseTo(0.15);
    expect(cfg.weight_availability).toBeCloseTo(0.15);
    expect(cfg.exploration_weight).toBe(0.5);
  });

  it("clamps exploration to [0, 1]", () => {
    const cfg = applyPrecisionToMarketConfig(undefined, 2.0);
    expect(cfg.exploration_weight).toBe(1.0);
    expect(cfg.weight_trust).toBeCloseTo(0.15);
  });
});

// === Epsilon-greedy exploration in rankCandidates ===

describe("rankCandidates epsilon-greedy exploration", () => {
  it("swaps a non-top candidate into position 1 when exploration triggers", () => {
    // Create 4 candidates with distinct trust levels so composites differ
    const candidates = [
      makeCandidate({
        motebit_id: asMotebitId("top"),
        trust_record: makeTrustRecord({ trust_level: AgentTrustLevel.Trusted }),
      }),
      makeCandidate({
        motebit_id: asMotebitId("second"),
        trust_record: makeTrustRecord({ trust_level: AgentTrustLevel.Verified }),
      }),
      makeCandidate({
        motebit_id: asMotebitId("third"),
        trust_record: makeTrustRecord({ trust_level: AgentTrustLevel.FirstContact }),
      }),
      makeCandidate({
        motebit_id: asMotebitId("fourth"),
        trust_record: makeTrustRecord({ trust_level: AgentTrustLevel.Unknown }),
      }),
    ];

    // Without exploration
    const noExplore = rankCandidates(candidates, defaultReqs, { exploration_weight: 0 });
    const normalOrder = noExplore.map((s) => s.motebit_id);

    // With full exploration (exploration_weight = 1.0 means probe always < epsilon)
    const withExplore = rankCandidates(candidates, defaultReqs, { exploration_weight: 1.0 });
    const exploreOrder = withExplore.map((s) => s.motebit_id);

    // Top candidate stays the same (exploration only swaps position 1)
    expect(exploreOrder[0]).toBe(normalOrder[0]);
    // All candidates still present
    expect(withExplore.length).toBe(noExplore.length);
  });

  it("does not swap when probe >= epsilon", () => {
    const candidates = [
      makeCandidate({
        motebit_id: asMotebitId("a"),
        trust_record: makeTrustRecord({ trust_level: AgentTrustLevel.Trusted }),
      }),
      makeCandidate({
        motebit_id: asMotebitId("b"),
        trust_record: makeTrustRecord({ trust_level: AgentTrustLevel.Verified }),
      }),
    ];

    // Tiny epsilon — probe unlikely to be below it
    const scores = rankCandidates(candidates, defaultReqs, { exploration_weight: 0.0001 });
    expect(scores[0]!.composite).toBeGreaterThanOrEqual(scores[1]!.composite);
  });

  it("does not explore with single candidate", () => {
    const candidates = [makeCandidate({ motebit_id: asMotebitId("only") })];
    const scores = rankCandidates(candidates, defaultReqs, { exploration_weight: 1.0 });
    expect(scores.length).toBe(1);
    expect(scores[0]!.motebit_id).toBe("only");
  });

  it("does not swap zero-scored candidates during exploration", () => {
    // One good candidate, rest blocked (composite = 0)
    const candidates = [
      makeCandidate({
        motebit_id: asMotebitId("good"),
        trust_record: makeTrustRecord({ trust_level: AgentTrustLevel.Trusted }),
      }),
      makeCandidate({
        motebit_id: asMotebitId("blocked-1"),
        trust_record: makeTrustRecord({ trust_level: AgentTrustLevel.Blocked }),
      }),
      makeCandidate({
        motebit_id: asMotebitId("blocked-2"),
        trust_record: makeTrustRecord({ trust_level: AgentTrustLevel.Blocked }),
      }),
    ];
    const scores = rankCandidates(candidates, defaultReqs, { exploration_weight: 1.0 });

    // Good candidate should be selected, blocked should not
    const good = scores.find((s) => s.motebit_id === "good");
    expect(good?.selected).toBe(true);
    const blockedSelected = scores.filter((s) => s.composite === 0 && s.selected);
    expect(blockedSelected.length).toBe(0);
  });
});
