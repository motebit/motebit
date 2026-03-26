import { describe, it, expect } from "vitest";
import {
  computePrecision,
  computeStateBaseline,
  buildPrecisionContext,
  summarizeGradientHistory,
  narrateEconomicConsequences,
  NEUTRAL_PRECISION,
} from "../index.js";
import type { GradientSnapshot } from "@motebit/sdk";

function makeSnapshot(overrides: Partial<GradientSnapshot> = {}): GradientSnapshot {
  return {
    motebit_id: "test-mote",
    timestamp: Date.now(),
    gradient: 0.5,
    delta: 0,
    knowledge_density: 0.5,
    knowledge_density_raw: 50,
    knowledge_quality: 0.5,
    graph_connectivity: 0.3,
    graph_connectivity_raw: 0.6,
    temporal_stability: 0.5,
    retrieval_quality: 0.5,
    interaction_efficiency: 0.6,
    tool_efficiency: 0.7,
    curiosity_pressure: 0.5,
    stats: {
      live_nodes: 10,
      live_edges: 15,
      semantic_count: 8,
      episodic_count: 2,
      pinned_count: 1,
      avg_confidence: 0.7,
      avg_half_life: 86_400_000 * 14,
      consolidation_add: 5,
      consolidation_update: 3,
      consolidation_reinforce: 2,
      consolidation_noop: 0,
      total_confidence_mass: 7,
      avg_retrieval_score: 0.6,
      retrieval_count: 10,
      avg_iterations_per_turn: 2,
      total_turns: 5,
      tool_calls_succeeded: 8,
      tool_calls_blocked: 1,
      tool_calls_failed: 1,
      curiosity_target_count: 2,
      avg_curiosity_score: 0.4,
    },
    ...overrides,
  };
}

describe("computePrecision", () => {
  it("returns neutral-ish values at gradient 0.5", () => {
    const p = computePrecision(makeSnapshot({ gradient: 0.5, delta: 0 }));
    expect(p.selfTrust).toBeCloseTo(0.5, 1);
    expect(p.explorationDrive).toBeCloseTo(0.5, 1);
  });

  it("high gradient → high self-trust", () => {
    const p = computePrecision(makeSnapshot({ gradient: 0.9, delta: 0.01 }));
    expect(p.selfTrust).toBeGreaterThan(0.8);
    expect(p.explorationDrive).toBeLessThan(0.3);
  });

  it("declining gradient boosts exploration", () => {
    const p = computePrecision(makeSnapshot({ gradient: 0.5, delta: -0.2 }));
    expect(p.explorationDrive).toBeGreaterThan(0.7);
  });
});

describe("buildPrecisionContext", () => {
  it("returns empty string for neutral precision", () => {
    // Neutral precision has selfTrust 0.5 and explorationDrive 0.5 — both in middle band
    const ctx = buildPrecisionContext(NEUTRAL_PRECISION);
    expect(ctx).toContain("moderate");
  });

  it("returns cautious guidance for low trust", () => {
    const ctx = buildPrecisionContext({
      selfTrust: 0.2,
      explorationDrive: 0.8,
      retrievalPrecision: 0.4,
      curiosityModulation: 0.7,
    });
    expect(ctx).toContain("low");
    expect(ctx).toContain("clarifying");
  });

  it("returns decisive guidance for high trust", () => {
    const ctx = buildPrecisionContext({
      selfTrust: 0.9,
      explorationDrive: 0.1,
      retrievalPrecision: 0.8,
      curiosityModulation: 0.1,
    });
    expect(ctx).toContain("high");
    expect(ctx).toContain("decisively");
  });

  it("includes low exploration note for low exploration drive", () => {
    const ctx = buildPrecisionContext({
      selfTrust: 0.9,
      explorationDrive: 0.2,
      retrievalPrecision: 0.8,
      curiosityModulation: 0.2,
    });
    expect(ctx).toContain("well-established");
  });

  it("returns empty string when both in middle band and no exploration", () => {
    const ctx = buildPrecisionContext({
      selfTrust: 0.5,
      explorationDrive: 0.5,
      retrievalPrecision: 0.5,
      curiosityModulation: 0.5,
    });
    expect(ctx).toContain("moderate");
  });
});

describe("summarizeGradientHistory", () => {
  it("handles empty history", () => {
    const summary = summarizeGradientHistory([]);
    expect(summary.snapshotCount).toBe(0);
    expect(summary.strengths).toHaveLength(0);
  });

  it("narrates single snapshot", () => {
    const summary = summarizeGradientHistory([makeSnapshot()]);
    expect(summary.snapshotCount).toBe(1);
    expect(summary.trajectory).toContain("First measurement");
  });

  it("detects rising trajectory", () => {
    const old = makeSnapshot({ gradient: 0.3, delta: 0.02, timestamp: Date.now() - 3600000 });
    const recent = makeSnapshot({ gradient: 0.6, delta: 0.05, timestamp: Date.now() });
    const summary = summarizeGradientHistory([recent, old]);
    expect(summary.trajectory).toContain("rising");
  });

  it("identifies strengths and weaknesses", () => {
    const s = makeSnapshot({ tool_efficiency: 0.9, knowledge_density: 0.1 });
    const summary = summarizeGradientHistory([s]);
    expect(summary.strengths.length).toBeGreaterThan(0);
    expect(summary.weaknesses.length).toBeGreaterThan(0);
  });

  it("detects stable trajectory", () => {
    const old = makeSnapshot({ gradient: 0.5, delta: 0.001, timestamp: Date.now() - 3600000 });
    const recent = makeSnapshot({ gradient: 0.51, delta: 0.001, timestamp: Date.now() });
    const summary = summarizeGradientHistory([recent, old]);
    expect(summary.trajectory).toContain("Stable");
  });

  it("detects declining trajectory", () => {
    const old = makeSnapshot({ gradient: 0.6, delta: -0.05, timestamp: Date.now() - 3600000 });
    const recent = makeSnapshot({ gradient: 0.3, delta: -0.05, timestamp: Date.now() });
    const summary = summarizeGradientHistory([recent, old]);
    expect(summary.trajectory).toContain("declining");
  });

  it("narrates rapidly rising trajectory", () => {
    const old = makeSnapshot({ gradient: 0.3, delta: 0.05, timestamp: Date.now() - 3600000 });
    const recent = makeSnapshot({ gradient: 0.6, delta: 0.05, timestamp: Date.now() });
    const summary = summarizeGradientHistory([recent, old]);
    expect(summary.trajectory).toContain("rapidly");
    expect(summary.trajectory).toContain("rising");
  });

  it("narrates gradually rising trajectory", () => {
    const old = makeSnapshot({ gradient: 0.5, delta: 0.002, timestamp: Date.now() - 3600000 });
    const recent = makeSnapshot({ gradient: 0.54, delta: 0.002, timestamp: Date.now() });
    const summary = summarizeGradientHistory([recent, old]);
    expect(summary.trajectory).toContain("gradually");
    expect(summary.trajectory).toContain("rising");
  });

  it("shows consistency note for volatile trajectory", () => {
    // Mix of rising and falling deltas → low consistency
    const s1 = makeSnapshot({ gradient: 0.3, delta: 0.05, timestamp: Date.now() - 3000 });
    const s2 = makeSnapshot({ gradient: 0.35, delta: -0.05, timestamp: Date.now() - 2000 });
    const s3 = makeSnapshot({ gradient: 0.32, delta: 0.05, timestamp: Date.now() - 1000 });
    const s4 = makeSnapshot({ gradient: 0.6, delta: -0.05, timestamp: Date.now() });
    const summary = summarizeGradientHistory([s4, s3, s2, s1]);
    expect(summary.trajectory).toContain("volatility");
  });

  it("shows 'some fluctuation' for moderate consistency", () => {
    // 3 rising, 1 falling → consistency = 3/4 = 0.75 (between 0.5 and 0.8)
    const s1 = makeSnapshot({ gradient: 0.3, delta: 0.05, timestamp: Date.now() - 4000 });
    const s2 = makeSnapshot({ gradient: 0.35, delta: 0.05, timestamp: Date.now() - 3000 });
    const s3 = makeSnapshot({ gradient: 0.4, delta: -0.05, timestamp: Date.now() - 2000 });
    const s4 = makeSnapshot({ gradient: 0.6, delta: 0.05, timestamp: Date.now() });
    const summary = summarizeGradientHistory([s4, s3, s2, s1]);
    expect(summary.trajectory).toContain("some fluctuation");
  });

  it("uses hours format for spans under 48 hours", () => {
    const old = makeSnapshot({ gradient: 0.3, delta: 0.05, timestamp: Date.now() - 10 * 3600000 });
    const recent = makeSnapshot({ gradient: 0.6, delta: 0.05, timestamp: Date.now() });
    const summary = summarizeGradientHistory([recent, old]);
    expect(summary.trajectory).toMatch(/\d+h/);
  });

  it("uses days format for spans over 48 hours", () => {
    const old = makeSnapshot({
      gradient: 0.3,
      delta: 0.05,
      timestamp: Date.now() - 72 * 3600000,
    });
    const recent = makeSnapshot({ gradient: 0.6, delta: 0.05, timestamp: Date.now() });
    const summary = summarizeGradientHistory([recent, old]);
    expect(summary.trajectory).toMatch(/\d+d/);
  });

  it("uses minutes format for spans under 1 hour", () => {
    const old = makeSnapshot({ gradient: 0.3, delta: 0.05, timestamp: Date.now() - 30 * 60000 });
    const recent = makeSnapshot({ gradient: 0.6, delta: 0.05, timestamp: Date.now() });
    const summary = summarizeGradientHistory([recent, old]);
    expect(summary.trajectory).toMatch(/\d+m/);
  });

  it("narrates balanced strengths and weaknesses", () => {
    // One strength, one weakness → balanced
    const s = makeSnapshot({
      gradient: 0.5,
      tool_efficiency: 0.9,
      knowledge_density: 0.1,
      // All others in middle range
      knowledge_quality: 0.5,
      graph_connectivity: 0.3,
      temporal_stability: 0.5,
      retrieval_quality: 0.5,
      interaction_efficiency: 0.6,
      curiosity_pressure: 0.5,
    });
    const summary = summarizeGradientHistory([s]);
    expect(summary.overall).toContain("Balanced");
  });

  it("narrates more strengths than weaknesses", () => {
    const s = makeSnapshot({
      gradient: 0.8,
      tool_efficiency: 0.9,
      knowledge_density: 0.7,
      knowledge_quality: 0.7,
      graph_connectivity: 0.5,
      temporal_stability: 0.7,
      retrieval_quality: 0.7,
      interaction_efficiency: 0.8,
      curiosity_pressure: 0.7,
    });
    const summary = summarizeGradientHistory([s]);
    expect(summary.overall).toContain("More strengths than weaknesses");
  });

  it("narrates more weaknesses than strengths", () => {
    const s = makeSnapshot({
      gradient: 0.2,
      tool_efficiency: 0.3,
      knowledge_density: 0.1,
      knowledge_quality: 0.1,
      graph_connectivity: 0.05,
      temporal_stability: 0.1,
      retrieval_quality: 0.1,
      interaction_efficiency: 0.2,
      curiosity_pressure: 0.1,
    });
    const summary = summarizeGradientHistory([s]);
    expect(summary.overall).toContain("More weaknesses than strengths");
  });

  it("narrates exploring posture for low self-trust", () => {
    // Low gradient → low selfTrust
    const s = makeSnapshot({ gradient: 0.1, delta: -0.1 });
    const summary = summarizeGradientHistory([s]);
    expect(summary.posture).toContain("Exploring");
  });

  it("narrates exploiting posture for high self-trust", () => {
    // High gradient → high selfTrust
    const s = makeSnapshot({ gradient: 0.95, delta: 0 });
    const summary = summarizeGradientHistory([s]);
    expect(summary.posture).toContain("Exploiting");
  });

  it("narrates very low gradient level", () => {
    const s = makeSnapshot({ gradient: 0.1 });
    const summary = summarizeGradientHistory([s]);
    expect(summary.overall).toContain("very low");
  });

  it("narrates high gradient level", () => {
    const s = makeSnapshot({ gradient: 0.8 });
    const summary = summarizeGradientHistory([s]);
    expect(summary.overall).toContain("high");
  });

  it("narrates low gradient level", () => {
    const s = makeSnapshot({ gradient: 0.3 });
    const summary = summarizeGradientHistory([s]);
    expect(summary.overall).toContain("low");
  });
});

describe("narrateEconomicConsequences", () => {
  it("returns empty for healthy snapshot", () => {
    const consequences = narrateEconomicConsequences(
      makeSnapshot({ gradient: 0.6, delta: 0.01, tool_efficiency: 0.8, retrieval_quality: 0.7 }),
    );
    expect(consequences).toHaveLength(0);
  });

  it("flags low tool efficiency", () => {
    const consequences = narrateEconomicConsequences(makeSnapshot({ tool_efficiency: 0.3 }));
    expect(consequences.some((c) => c.includes("Tool calls"))).toBe(true);
  });

  it("flags declining gradient", () => {
    const consequences = narrateEconomicConsequences(makeSnapshot({ delta: -0.1 }));
    expect(consequences.some((c) => c.includes("declining"))).toBe(true);
  });

  it("notes strong gradient positively", () => {
    const consequences = narrateEconomicConsequences(makeSnapshot({ gradient: 0.8 }));
    expect(consequences.some((c) => c.includes("Strong gradient"))).toBe(true);
  });

  it("flags low retrieval quality", () => {
    const consequences = narrateEconomicConsequences(makeSnapshot({ retrieval_quality: 0.2 }));
    expect(consequences.some((c) => c.includes("Retrieval quality"))).toBe(true);
  });

  it("flags low interaction efficiency", () => {
    const consequences = narrateEconomicConsequences(makeSnapshot({ interaction_efficiency: 0.3 }));
    expect(consequences.some((c) => c.includes("many iterations"))).toBe(true);
  });

  it("flags sparse knowledge base", () => {
    const consequences = narrateEconomicConsequences(makeSnapshot({ knowledge_density: 0.1 }));
    expect(consequences.some((c) => c.includes("sparse"))).toBe(true);
  });

  it("flags decaying knowledge (low curiosity pressure)", () => {
    const consequences = narrateEconomicConsequences(makeSnapshot({ curiosity_pressure: 0.2 }));
    expect(consequences.some((c) => c.includes("decaying"))).toBe(true);
  });

  it("flags low overall gradient", () => {
    const consequences = narrateEconomicConsequences(
      makeSnapshot({ gradient: 0.2, tool_efficiency: 0.8, retrieval_quality: 0.7 }),
    );
    expect(consequences.some((c) => c.includes("Overall gradient is low"))).toBe(true);
  });
});

describe("computeStateBaseline", () => {
  it("fresh motebit (gradient 0.5, delta 0) → moderate confidence, neutral valence", () => {
    const snapshot = makeSnapshot({ gradient: 0.5, delta: 0 });
    const precision = computePrecision(snapshot);
    const baseline = computeStateBaseline(snapshot, precision);

    expect(baseline.confidence).toBeCloseTo(0.55, 1); // 0.3 + 0.5 * 0.5
    expect(baseline.affect_valence).toBeCloseTo(0, 1); // stable, neutral gradient
    expect(baseline.affect_arousal).toBeCloseTo(0, 1); // no change
  });

  it("experienced motebit (gradient 0.9) → high confidence, positive valence", () => {
    const snapshot = makeSnapshot({ gradient: 0.9, delta: 0.01 });
    const precision = computePrecision(snapshot);
    const baseline = computeStateBaseline(snapshot, precision);

    expect(baseline.confidence).toBeGreaterThan(0.7); // high selfTrust
    expect(baseline.affect_valence).toBeGreaterThan(0); // above 0.5 gradient + slight growth
  });

  it("declining motebit → negative valence, elevated arousal", () => {
    const snapshot = makeSnapshot({ gradient: 0.4, delta: -0.15 });
    const precision = computePrecision(snapshot);
    const baseline = computeStateBaseline(snapshot, precision);

    expect(baseline.affect_valence).toBeLessThan(0); // declining + below 0.5
    expect(baseline.affect_arousal).toBeGreaterThan(0.1); // rapid change
    expect(baseline.curiosity).toBeGreaterThan(0.5); // exploration drive up
  });

  it("rapidly growing motebit → positive valence, elevated arousal", () => {
    const snapshot = makeSnapshot({ gradient: 0.6, delta: 0.2 });
    const precision = computePrecision(snapshot);
    const baseline = computeStateBaseline(snapshot, precision);

    expect(baseline.affect_valence).toBeGreaterThan(0.2); // strong positive delta
    expect(baseline.affect_arousal).toBeGreaterThan(0.1); // rapid change
  });

  it("all values within valid state vector bounds", () => {
    // Test extremes
    for (const g of [0, 0.1, 0.5, 0.9, 1.0]) {
      for (const d of [-0.5, -0.1, 0, 0.1, 0.5]) {
        const snapshot = makeSnapshot({ gradient: g, delta: d });
        const precision = computePrecision(snapshot);
        const baseline = computeStateBaseline(snapshot, precision);

        expect(baseline.confidence).toBeGreaterThanOrEqual(0);
        expect(baseline.confidence).toBeLessThanOrEqual(1);
        expect(baseline.affect_valence).toBeGreaterThanOrEqual(-1);
        expect(baseline.affect_valence).toBeLessThanOrEqual(1);
        expect(baseline.affect_arousal).toBeGreaterThanOrEqual(0);
        expect(baseline.affect_arousal).toBeLessThanOrEqual(1);
        expect(baseline.curiosity).toBeGreaterThanOrEqual(0);
        expect(baseline.curiosity).toBeLessThanOrEqual(1);
      }
    }
  });
});
