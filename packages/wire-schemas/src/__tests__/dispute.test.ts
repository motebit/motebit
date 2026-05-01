/**
 * Runtime-parse tests for the dispute cluster — Request, Evidence,
 * AdjudicatorVote, Resolution, Appeal. The five artifacts that make
 * dispute resolution auditable from outside motebit's runtime.
 */
import { describe, expect, it } from "vitest";

import {
  AdjudicatorVoteSchema,
  DisputeAppealSchema,
  DisputeEvidenceSchema,
  DisputeRequestSchema,
  DisputeResolutionSchema,
} from "../dispute.js";

const SUITE = "motebit-jcs-ed25519-b64-v1";
const SIG = "sig-base64url";
const FILER = "019cd9d4-3275-7b24-8265-filer000001";
const RESPONDENT = "019cd9d4-3275-7b24-8265-respondent01";

// ---------------------------------------------------------------------------
// DisputeRequest
// ---------------------------------------------------------------------------

describe("DisputeRequestSchema", () => {
  const SAMPLE: Record<string, unknown> = {
    dispute_id: "01HTV8X9QZ-dispute-1",
    task_id: "01HTV8X9QZ-task-1",
    allocation_id: "01HTV8X9QZ-alloc-1",
    filed_by: FILER,
    respondent: RESPONDENT,
    category: "quality",
    description: "Result was incoherent.",
    evidence_refs: ["receipt:01HTV..."],
    filed_at: 1_713_456_000_000,
    suite: SUITE,
    signature: SIG,
  };

  it("parses a minimal valid request", () => {
    const r = DisputeRequestSchema.parse(SAMPLE);
    expect(r.category).toBe("quality");
    expect(r.evidence_refs).toHaveLength(1);
  });

  it("accepts every defined dispute category", () => {
    const cats = ["quality", "non_payment", "receipt_invalid", "unauthorized", "other"];
    for (const category of cats) {
      const r = DisputeRequestSchema.parse({ ...SAMPLE, category });
      expect(r.category).toBe(category);
    }
  });

  it("rejects an unknown category (closed enum)", () => {
    expect(() => DisputeRequestSchema.parse({ ...SAMPLE, category: "vibes" })).toThrow();
  });

  it("rejects empty evidence_refs (≥1 required at filing time per §4.4)", () => {
    expect(() => DisputeRequestSchema.parse({ ...SAMPLE, evidence_refs: [] })).toThrow();
  });

  it("rejects missing task_id (no economic binding, no dispute)", () => {
    const bad = { ...SAMPLE };
    delete bad.task_id;
    expect(() => DisputeRequestSchema.parse(bad)).toThrow();
  });

  it("rejects missing allocation_id", () => {
    const bad = { ...SAMPLE };
    delete bad.allocation_id;
    expect(() => DisputeRequestSchema.parse(bad)).toThrow();
  });

  it("rejects extra top-level keys", () => {
    expect(() => DisputeRequestSchema.parse({ ...SAMPLE, sneak: "no" })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// DisputeEvidence
// ---------------------------------------------------------------------------

describe("DisputeEvidenceSchema", () => {
  const SAMPLE: Record<string, unknown> = {
    dispute_id: "01HTV8X9QZ-dispute-1",
    submitted_by: FILER,
    evidence_type: "execution_receipt",
    evidence_data: { task_id: "01HTV...", status: "completed" },
    description: "The receipt the respondent emitted.",
    submitted_at: 1_713_456_001_000,
    suite: SUITE,
    signature: SIG,
  };

  it("parses a valid evidence submission", () => {
    const e = DisputeEvidenceSchema.parse(SAMPLE);
    expect(e.evidence_type).toBe("execution_receipt");
  });

  it("accepts every defined evidence type", () => {
    const types = [
      "execution_receipt",
      "credential",
      "anchor_proof",
      "settlement_proof",
      "execution_ledger",
      "attestation",
    ];
    for (const evidence_type of types) {
      const e = DisputeEvidenceSchema.parse({ ...SAMPLE, evidence_type });
      expect(e.evidence_type).toBe(evidence_type);
    }
  });

  it("rejects an unknown evidence type", () => {
    expect(() =>
      DisputeEvidenceSchema.parse({ ...SAMPLE, evidence_type: "vibes_evidence" }),
    ).toThrow();
  });

  it("accepts arbitrary inner evidence_data shape (per-entry validation deferred)", () => {
    const e = DisputeEvidenceSchema.parse({
      ...SAMPLE,
      evidence_data: { anything: "goes", deep: { nested: 1 } },
    });
    expect((e.evidence_data as Record<string, unknown>).anything).toBe("goes");
  });
});

// ---------------------------------------------------------------------------
// AdjudicatorVote
// ---------------------------------------------------------------------------

describe("AdjudicatorVoteSchema", () => {
  const SAMPLE: Record<string, unknown> = {
    dispute_id: "01HTV8X9QZ-dispute-1",
    round: 1,
    peer_id: "019cd9d4-3275-7b24-8265-peer00000001",
    vote: "upheld",
    rationale: "Evidence clearly shows the receipt was tampered.",
    suite: SUITE,
    signature: SIG,
  };

  it("rejects a vote without round (round-binding: signature MUST cover round per §6.5 + §8.3)", () => {
    const bad = { ...SAMPLE };
    delete bad.round;
    expect(() => AdjudicatorVoteSchema.parse(bad)).toThrow();
  });

  it("rejects round < 1 (round counter is 1-indexed; 0 has no §8.3 semantics)", () => {
    expect(() => AdjudicatorVoteSchema.parse({ ...SAMPLE, round: 0 })).toThrow();
  });

  it("accepts round = 2 (§8.3 appeal round)", () => {
    const v = AdjudicatorVoteSchema.parse({ ...SAMPLE, round: 2 });
    expect(v.round).toBe(2);
  });

  it("parses a valid vote", () => {
    const v = AdjudicatorVoteSchema.parse(SAMPLE);
    expect(v.vote).toBe("upheld");
    expect(v.dispute_id).toBe("01HTV8X9QZ-dispute-1");
  });

  it("rejects a vote without dispute_id (replay-safety: signature MUST cover dispute_id per §6.5)", () => {
    const bad = { ...SAMPLE };
    delete bad.dispute_id;
    expect(() => AdjudicatorVoteSchema.parse(bad)).toThrow();
  });

  it("rejects an empty dispute_id", () => {
    expect(() => AdjudicatorVoteSchema.parse({ ...SAMPLE, dispute_id: "" })).toThrow();
  });

  it("accepts every defined outcome", () => {
    for (const vote of ["upheld", "overturned", "split"]) {
      const v = AdjudicatorVoteSchema.parse({ ...SAMPLE, vote });
      expect(v.vote).toBe(vote);
    }
  });

  it("rejects an unknown outcome", () => {
    expect(() => AdjudicatorVoteSchema.parse({ ...SAMPLE, vote: "abstain" })).toThrow();
  });

  it("accepts empty rationale (optional in practice)", () => {
    const v = AdjudicatorVoteSchema.parse({ ...SAMPLE, rationale: "" });
    expect(v.rationale).toBe("");
  });
});

// ---------------------------------------------------------------------------
// DisputeResolution
// ---------------------------------------------------------------------------

describe("DisputeResolutionSchema", () => {
  const VOTE = {
    dispute_id: "01HTV8X9QZ-dispute-1",
    round: 1,
    peer_id: "peer-1",
    vote: "upheld" as const,
    rationale: "ok",
    suite: SUITE,
    signature: SIG,
  };

  const SAMPLE: Record<string, unknown> = {
    dispute_id: "01HTV8X9QZ-dispute-1",
    resolution: "upheld",
    rationale: "Receipt invalid; refunding the delegator.",
    fund_action: "refund_to_delegator",
    split_ratio: 0,
    adjudicator: "019cd9d4-3275-7b24-8265-adjudicat001",
    adjudicator_votes: [],
    resolved_at: 1_713_456_002_000,
    suite: SUITE,
    signature: SIG,
  };

  it("parses a single-relay resolution (empty adjudicator_votes)", () => {
    const r = DisputeResolutionSchema.parse(SAMPLE);
    expect(r.resolution).toBe("upheld");
    expect(r.adjudicator_votes).toEqual([]);
  });

  it("parses a federation resolution with multiple votes", () => {
    const r = DisputeResolutionSchema.parse({
      ...SAMPLE,
      adjudicator_votes: [VOTE, { ...VOTE, peer_id: "peer-2", vote: "upheld" }],
    });
    expect(r.adjudicator_votes).toHaveLength(2);
  });

  it("rejects when a nested vote is malformed", () => {
    expect(() =>
      DisputeResolutionSchema.parse({
        ...SAMPLE,
        adjudicator_votes: [{ ...VOTE, vote: "telepathy" }],
      }),
    ).toThrow();
  });

  it("rejects every defined fund_action and accepts the others", () => {
    for (const fund_action of ["release_to_worker", "refund_to_delegator", "split"]) {
      const r = DisputeResolutionSchema.parse({ ...SAMPLE, fund_action });
      expect(r.fund_action).toBe(fund_action);
    }
    expect(() => DisputeResolutionSchema.parse({ ...SAMPLE, fund_action: "burn" })).toThrow();
  });

  it("rejects split_ratio outside [0, 1]", () => {
    expect(() => DisputeResolutionSchema.parse({ ...SAMPLE, split_ratio: -0.1 })).toThrow();
    expect(() => DisputeResolutionSchema.parse({ ...SAMPLE, split_ratio: 1.1 })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// DisputeAppeal
// ---------------------------------------------------------------------------

describe("DisputeAppealSchema", () => {
  const SAMPLE: Record<string, unknown> = {
    dispute_id: "01HTV8X9QZ-dispute-1",
    appealed_by: FILER,
    reason: "New evidence has surfaced.",
    appealed_at: 1_713_456_003_000,
    suite: SUITE,
    signature: SIG,
  };

  it("parses a minimal appeal (no additional evidence)", () => {
    const a = DisputeAppealSchema.parse(SAMPLE);
    expect(a.appealed_by).toBe(FILER);
    expect(a.additional_evidence).toBeUndefined();
  });

  it("parses an appeal with additional evidence references", () => {
    const a = DisputeAppealSchema.parse({
      ...SAMPLE,
      additional_evidence: ["receipt:01HTV...", "credential:01HTV..."],
    });
    expect(a.additional_evidence).toHaveLength(2);
  });

  it("rejects empty strings inside additional_evidence", () => {
    expect(() => DisputeAppealSchema.parse({ ...SAMPLE, additional_evidence: [""] })).toThrow();
  });

  it("rejects extra top-level keys", () => {
    expect(() => DisputeAppealSchema.parse({ ...SAMPLE, sneak: "no" })).toThrow();
  });
});
