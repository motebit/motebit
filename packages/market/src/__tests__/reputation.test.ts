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
    expect(rep.sub_scores.reliability).toBe(1.0);
    expect(rep.sample_size).toBe(10);
  });

  it("penalizes failures in reliability", () => {
    const receipts = [
      makeReceipt(),
      makeReceipt({ status: "failed" }),
      makeReceipt({ status: "failed" }),
    ];
    const rep = computeServiceReputation(MID, receipts, makeTrust());
    expect(rep.sub_scores.reliability).toBeCloseTo(1 / 3);
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
});
