import { describe, it, expect } from "vitest";
import { applyPrecisionToMarketConfig } from "../scoring.js";

// === Active Inference Precision ===
//
// `scoreCandidate` and `rankCandidates` (the linear-weighted-sum
// predecessors) lived here until they were retired in favor of
// `graphRankCandidates` (./graph-routing.ts). The candidate-scoring tests
// now live in `__tests__/graph-routing.test.ts`. This file keeps the
// precision-tuning helper that's still used by the gradient layer.

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

  it("clamps exploration to 0 when below zero", () => {
    const cfg = applyPrecisionToMarketConfig(undefined, -0.5);
    expect(cfg.exploration_weight).toBe(0);
    expect(cfg.weight_trust).toBe(0.25);
  });
});
