import { describe, it, expect } from "vitest";
import { scoreQuality } from "../quality-gate.js";

describe("scoreQuality", () => {
  it("high-quality result passes", () => {
    const score = scoreQuality(800, 5, 3000);
    expect(score.length_score).toBe(1); // capped at 500/500
    expect(score.tool_score).toBe(1); // capped at 3/3
    // latency: 1 - (3000-500)/4500 ≈ 0.4444
    expect(score.latency_score).toBeCloseTo(0.4444, 3);
    // 0.6*1 + 0.3*1 + 0.1*0.4444 ≈ 0.9444
    expect(score.quality).toBeCloseTo(0.9444, 2);
    expect(score.passed).toBe(true);
  });

  it("empty result fails quality gate", () => {
    const score = scoreQuality(0, 0, 100);
    expect(score.length_score).toBe(0);
    expect(score.tool_score).toBe(0);
    expect(score.latency_score).toBe(1); // min clamped to 500 → 1 - 0/4500 = 1.0
    expect(score.quality).toBeCloseTo(0.1, 2); // 0.6*0 + 0.3*0 + 0.1*1.0
    expect(score.passed).toBe(false);
  });

  it("short result with some tools is borderline", () => {
    const score = scoreQuality(50, 1, 1000);
    expect(score.length_score).toBe(0.1); // 50/500
    expect(score.tool_score).toBeCloseTo(0.333, 2); // 1/3
    // latency: 1 - (1000-500)/4500 ≈ 0.8889
    expect(score.latency_score).toBeCloseTo(0.8889, 3);
    // 0.6*0.1 + 0.3*0.333 + 0.1*0.8889 ≈ 0.249
    expect(score.quality).toBeCloseTo(0.249, 1);
    expect(score.passed).toBe(true); // >= 0.2
  });

  it("respects custom threshold", () => {
    const score = scoreQuality(100, 1, 1000, { threshold: 0.1 });
    expect(score.passed).toBe(true); // would fail at 0.2 default
  });

  it("clamps latency to [500, 5000] and inverts", () => {
    const fast = scoreQuality(500, 3, 10); // way under 500ms → clamped to 500 → score 1.0
    const slow = scoreQuality(500, 3, 100000); // way over 5000ms → clamped to 5000 → score 0.0
    expect(fast.latency_score).toBe(1); // fastest possible
    expect(slow.latency_score).toBe(0); // slowest possible
  });

  it("clamps length at 500", () => {
    const short = scoreQuality(250, 0, 1000);
    const long = scoreQuality(10000, 0, 1000);
    expect(short.length_score).toBe(0.5);
    expect(long.length_score).toBe(1); // capped
  });

  it("clamps tools at 3", () => {
    const few = scoreQuality(0, 1, 1000);
    const many = scoreQuality(0, 10, 1000);
    expect(few.tool_score).toBeCloseTo(0.333, 2);
    expect(many.tool_score).toBe(1); // capped at 3/3
  });

  it("custom weights change scoring", () => {
    // All weight on tools
    const score = scoreQuality(0, 3, 100, {
      weight_length: 0,
      weight_tools: 1,
      weight_latency: 0,
    });
    expect(score.quality).toBe(1);
    expect(score.passed).toBe(true);
  });
});
