import { describe, it, expect } from "vitest";
import { computeServiceReputation } from "../reputation.js";
import { AgentTrustLevel, asMotebitId } from "@motebit/sdk";
import type { AgentTrustRecord, ExecutionReceipt } from "@motebit/sdk";

const MID = asMotebitId("agent-1");

function makeReceipt(overrides: Partial<ExecutionReceipt> = {}): ExecutionReceipt {
  const now = Date.now();
  return {
    task_id: "task-1",
    motebit_id: "agent-1",
    device_id: "device-1",
    submitted_at: now - 2000,
    completed_at: now,
    status: "completed",
    result: "done",
    tools_used: ["web_search"],
    memories_formed: 0,
    prompt_hash: "abc",
    result_hash: "def",
    signature: "sig-123",
    ...overrides,
  };
}

function makeTrust(overrides: Partial<AgentTrustRecord> = {}): AgentTrustRecord {
  return {
    motebit_id: "local",
    remote_motebit_id: "agent-1",
    trust_level: AgentTrustLevel.Verified,
    first_seen_at: Date.now() - 100_000,
    last_seen_at: Date.now(),
    interaction_count: 10,
    ...overrides,
  };
}

describe("computeServiceReputation", () => {
  it("computes reputation from successful receipts", () => {
    const receipts = Array.from({ length: 10 }, () => makeReceipt());
    const rep = computeServiceReputation(MID, receipts, makeTrust());
    expect(rep.composite).toBeGreaterThan(0);
    expect(rep.composite).toBeLessThanOrEqual(1);
    expect(rep.sub_scores.reliability).toBeCloseTo(11 / 12); // Beta-binomial: (1+10)/(2+10)
    expect(rep.sample_size).toBe(10);
  });

  it("penalizes failures in reliability", () => {
    const receipts = [
      makeReceipt(),
      makeReceipt({ status: "failed" }),
      makeReceipt({ status: "failed" }),
    ];
    const rep = computeServiceReputation(MID, receipts, makeTrust());
    expect(rep.sub_scores.reliability).toBeCloseTo(2 / 5); // Beta-binomial: (1+1)/(2+3)
  });

  it("returns low score for empty receipt history", () => {
    const rep = computeServiceReputation(MID, [], makeTrust());
    expect(rep.sample_size).toBe(0);
    expect(rep.sub_scores.recency).toBe(0.0);
    expect(rep.composite).toBeGreaterThan(0); // trust contributes
  });

  it("returns minimal score with no trust and no receipts", () => {
    const rep = computeServiceReputation(MID, [], null);
    expect(rep.composite).toBeCloseTo(0.1 * 0.3); // unknown trust * weight
    expect(rep.sub_scores.trust_level).toBe(0.1);
  });

  it("filters receipts by time window", () => {
    const old = makeReceipt({ completed_at: Date.now() - 100 * 24 * 60 * 60 * 1000 });
    const recent = makeReceipt();
    const rep = computeServiceReputation(MID, [old, recent], makeTrust(), 7 * 24 * 60 * 60 * 1000);
    expect(rep.sample_size).toBe(1); // only recent
  });

  it("reflects trust level in sub_scores", () => {
    const rep = computeServiceReputation(
      MID,
      [makeReceipt()],
      makeTrust({ trust_level: AgentTrustLevel.Trusted }),
    );
    expect(rep.sub_scores.trust_level).toBe(0.9);
  });

  it("high recency for very recent receipts", () => {
    const rep = computeServiceReputation(MID, [makeReceipt()], makeTrust());
    expect(rep.sub_scores.recency).toBeGreaterThan(0.9);
  });

  it("consistency is high for uniform durations", () => {
    const now = Date.now();
    const receipts = Array.from({ length: 5 }, () =>
      makeReceipt({ submitted_at: now - 2000, completed_at: now }),
    );
    const rep = computeServiceReputation(MID, receipts, makeTrust());
    expect(rep.sub_scores.consistency).toBeGreaterThan(0.9);
  });

  it("consistency defaults to 0.5 when fewer than 2 valid durations", () => {
    const now = Date.now();
    // Single receipt → only 1 duration → consistency stays at default 0.5
    const receipts = [makeReceipt({ submitted_at: now - 2000, completed_at: now })];
    const rep = computeServiceReputation(MID, receipts, makeTrust());
    expect(rep.sub_scores.consistency).toBe(0.5);
  });

  it("consistency is low for highly variable durations", () => {
    const now = Date.now();
    const receipts = [
      makeReceipt({ submitted_at: now - 1000, completed_at: now }), // 1s
      makeReceipt({ submitted_at: now - 20000, completed_at: now }), // 20s
      makeReceipt({ submitted_at: now - 500, completed_at: now }), // 0.5s
      makeReceipt({ submitted_at: now - 30000, completed_at: now }), // 30s
    ];
    const rep = computeServiceReputation(MID, receipts, makeTrust());
    // High CV (coefficient of variation) → low consistency
    expect(rep.sub_scores.consistency).toBeLessThan(0.5);
  });

  it("speed is default 0.5-region when no valid durations (completed_at <= submitted_at)", () => {
    const now = Date.now();
    // Receipts where completed_at == submitted_at → no valid duration → avgDuration = 10000 default
    const receipts = [
      makeReceipt({ submitted_at: now, completed_at: now }),
      makeReceipt({ submitted_at: now, completed_at: now }),
    ];
    const rep = computeServiceReputation(MID, receipts, makeTrust());
    // avgDuration = 10000 → speed = 1 - 10000 / (10000 + 5000) = 1/3
    expect(rep.sub_scores.speed).toBeCloseTo(1 / 3, 5);
  });

  it("handles receipts where completed_at equals submitted_at (zero duration filtered)", () => {
    const now = Date.now();
    const receipts = [
      makeReceipt({ submitted_at: now, completed_at: now }), // 0 → filtered out
      makeReceipt({ submitted_at: now - 3000, completed_at: now }), // 3s → valid
    ];
    const rep = computeServiceReputation(MID, receipts, makeTrust());
    // Only the 3s receipt contributes to speed
    expect(rep.sub_scores.speed).toBeCloseTo(1 - 3000 / (3000 + 5000), 5);
  });

  it("uses 0.1 trust when trustRecord is null and recent receipts exist", () => {
    const rep = computeServiceReputation(MID, [makeReceipt()], null);
    expect(rep.sub_scores.trust_level).toBe(0.1);
    expect(rep.sample_size).toBe(1);
  });
});
