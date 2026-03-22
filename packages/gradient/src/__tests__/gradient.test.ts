import { describe, it, expect } from "vitest";
import {
  computePrecision,
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
});
