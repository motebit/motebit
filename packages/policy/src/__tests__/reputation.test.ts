import { describe, it, expect } from "vitest";
import { AgentTrustLevel } from "@motebit/sdk";
import type { AgentTrustRecord } from "@motebit/sdk";
import { computeReputationScore } from "../reputation.js";

const NOW = Date.now();

function makeRecord(overrides: Partial<AgentTrustRecord> = {}): AgentTrustRecord {
  return {
    motebit_id: "test-local",
    remote_motebit_id: "test-remote",
    trust_level: AgentTrustLevel.Verified,
    first_seen_at: NOW - 86_400_000 * 30,
    last_seen_at: NOW,
    interaction_count: 10,
    successful_tasks: 5,
    failed_tasks: 0,
    ...overrides,
  };
}

describe("computeReputationScore", () => {
  it("returns 0.0 for Blocked agents", () => {
    const record = makeRecord({ trust_level: AgentTrustLevel.Blocked });
    expect(computeReputationScore(record, NOW)).toBe(0.0);
  });

  it("returns 0.0 for Unknown agents", () => {
    const record = makeRecord({ trust_level: AgentTrustLevel.Unknown });
    expect(computeReputationScore(record, NOW)).toBe(0.0);
  });

  it("returns high score for perfect record", () => {
    const record = makeRecord({
      interaction_count: 100,
      successful_tasks: 100,
      failed_tasks: 0,
      last_seen_at: NOW,
    });
    const score = computeReputationScore(record, NOW);
    // successRate=(1+100)/(2+100)≈0.99, volumeScore=1.0 (capped), recencyScore≈1.0
    expect(score).toBeGreaterThan(0.8);
  });

  it("returns low-medium score for new agent with few interactions", () => {
    const record = makeRecord({
      interaction_count: 1,
      successful_tasks: 1,
      failed_tasks: 0,
      last_seen_at: NOW,
    });
    const score = computeReputationScore(record, NOW);
    // successRate=(1+1)/(2+1)=0.667, volumeScore=1/50=0.02, recencyScore≈1.0
    // (0.667 + 0.02 + 1.0) / 3 ≈ 0.562
    expect(score).toBeGreaterThan(0.4);
    expect(score).toBeLessThan(0.7);
  });

  it("returns low score for stale agent (180 days old)", () => {
    const record = makeRecord({
      interaction_count: 50,
      successful_tasks: 50,
      failed_tasks: 0,
      last_seen_at: NOW - 86_400_000 * 180,
    });
    const score = computeReputationScore(record, NOW);
    // successRate=(1+50)/(2+50)≈0.981, volumeScore=1.0, recencyScore=exp(-180/90)≈0.135
    // (0.981 + 1.0 + 0.135) / 3 ≈ 0.705
    expect(score).toBeLessThan(0.75);
  });

  it("returns low score for agent with mostly failed tasks", () => {
    const record = makeRecord({
      interaction_count: 50,
      successful_tasks: 2,
      failed_tasks: 48,
      last_seen_at: NOW,
    });
    const score = computeReputationScore(record, NOW);
    // successRate=(1+2)/(2+50)=3/52≈0.058, volumeScore=1.0, recencyScore≈1.0
    // (0.058 + 1.0 + 1.0) / 3 ≈ 0.686
    expect(score).toBeLessThan(0.7);
  });

  it("defaults successRate to 0.5 when no tasks recorded (Beta-binomial prior)", () => {
    const record = makeRecord({
      interaction_count: 10,
      successful_tasks: 0,
      failed_tasks: 0,
      last_seen_at: NOW,
    });
    const score = computeReputationScore(record, NOW);
    // successRate=(1+0)/(2+0)=0.5, volumeScore=10/50=0.2, recencyScore≈1.0
    // (0.5 + 0.2 + 1.0) / 3 ≈ 0.567
    expect(score).toBeCloseTo(0.567, 1);
  });

  it("caps volumeScore at 1.0 for 50+ interactions", () => {
    const at50 = computeReputationScore(
      makeRecord({ interaction_count: 50, last_seen_at: NOW }),
      NOW,
    );
    const at100 = computeReputationScore(
      makeRecord({ interaction_count: 100, last_seen_at: NOW }),
      NOW,
    );
    // Volume component is the same once saturated
    expect(at50).toBeCloseTo(at100, 5);
  });

  it("returns minimal score for FirstContact with 0 interactions", () => {
    const record = makeRecord({
      trust_level: AgentTrustLevel.FirstContact,
      interaction_count: 0,
      successful_tasks: 0,
      failed_tasks: 0,
      last_seen_at: NOW,
    });
    const score = computeReputationScore(record, NOW);
    // successRate=(1+0)/(2+0)=0.5, volumeScore=0.0, recencyScore≈1.0
    // (0.5 + 0.0 + 1.0) / 3 = 0.5
    expect(score).toBeCloseTo(0.5, 2);
  });

  it("handles undefined successful_tasks (defaults to 0)", () => {
    const record = makeRecord({
      successful_tasks: undefined as unknown as number,
      failed_tasks: 5,
      interaction_count: 10,
      last_seen_at: NOW,
    });
    const score = computeReputationScore(record, NOW);
    // successRate = (1+0)/(2+5) = 1/7 ≈ 0.143
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(1);
  });

  it("handles undefined failed_tasks (defaults to 0)", () => {
    const record = makeRecord({
      successful_tasks: 10,
      failed_tasks: undefined as unknown as number,
      interaction_count: 10,
      last_seen_at: NOW,
    });
    const score = computeReputationScore(record, NOW);
    // successRate = (1+10)/(2+10) = 11/12 ≈ 0.917
    expect(score).toBeGreaterThan(0.5);
  });

  it("handles both successful_tasks and failed_tasks undefined", () => {
    const record = makeRecord({
      successful_tasks: undefined as unknown as number,
      failed_tasks: undefined as unknown as number,
      interaction_count: 5,
      last_seen_at: NOW,
    });
    const score = computeReputationScore(record, NOW);
    // successRate = (1+0)/(2+0) = 0.5
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(1);
  });

  it("uses Date.now() when no timestamp provided", () => {
    const record = makeRecord({
      interaction_count: 10,
      successful_tasks: 5,
      failed_tasks: 0,
      last_seen_at: Date.now(),
    });
    const score = computeReputationScore(record);
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(1);
  });

  it("always returns a score in [0, 1]", () => {
    const cases: AgentTrustRecord[] = [
      makeRecord({ trust_level: AgentTrustLevel.Blocked }),
      makeRecord({ trust_level: AgentTrustLevel.Unknown }),
      makeRecord({ interaction_count: 0, successful_tasks: 0, failed_tasks: 0 }),
      makeRecord({ interaction_count: 10000, successful_tasks: 10000, failed_tasks: 0 }),
      makeRecord({ last_seen_at: NOW - 86_400_000 * 365 * 5 }), // 5 years stale
      makeRecord({ last_seen_at: NOW + 86_400_000 }), // future (edge case)
    ];
    for (const record of cases) {
      const score = computeReputationScore(record, NOW);
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    }
  });
});
