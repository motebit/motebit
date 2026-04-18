/**
 * Runtime-parse tests for the credential-subject triple — Reputation,
 * Trust, Gradient. The three VC body types motebit issues.
 */
import { describe, expect, it } from "vitest";

import {
  GradientCredentialSubjectSchema,
  ReputationCredentialSubjectSchema,
  TrustCredentialSubjectSchema,
} from "../credential-subjects.js";

const SUBJECT_ID = "did:key:z6MkfTV...";

// ---------------------------------------------------------------------------
// ReputationCredentialSubject
// ---------------------------------------------------------------------------

describe("ReputationCredentialSubjectSchema", () => {
  const SAMPLE: Record<string, unknown> = {
    id: SUBJECT_ID,
    success_rate: 0.97,
    avg_latency_ms: 1_250,
    task_count: 432,
    trust_score: 0.85,
    availability: 0.99,
    sample_size: 432,
    measured_at: 1_713_456_000_000,
  };

  it("parses a valid reputation subject", () => {
    const r = ReputationCredentialSubjectSchema.parse(SAMPLE);
    expect(r.success_rate).toBe(0.97);
    expect(r.sample_size).toBe(432);
  });

  it("rejects success_rate outside [0, 1]", () => {
    expect(() =>
      ReputationCredentialSubjectSchema.parse({ ...SAMPLE, success_rate: 1.1 }),
    ).toThrow();
    expect(() =>
      ReputationCredentialSubjectSchema.parse({ ...SAMPLE, success_rate: -0.1 }),
    ).toThrow();
  });

  it("rejects availability outside [0, 1]", () => {
    expect(() =>
      ReputationCredentialSubjectSchema.parse({ ...SAMPLE, availability: 1.5 }),
    ).toThrow();
  });

  it("rejects negative avg_latency_ms (latency cannot be negative)", () => {
    expect(() =>
      ReputationCredentialSubjectSchema.parse({ ...SAMPLE, avg_latency_ms: -1 }),
    ).toThrow();
  });

  it("rejects non-integer task_count and sample_size", () => {
    expect(() => ReputationCredentialSubjectSchema.parse({ ...SAMPLE, task_count: 1.5 })).toThrow();
    expect(() =>
      ReputationCredentialSubjectSchema.parse({ ...SAMPLE, sample_size: 1.5 }),
    ).toThrow();
  });

  it("accepts a fresh-agent zero-sample credential", () => {
    const r = ReputationCredentialSubjectSchema.parse({
      ...SAMPLE,
      task_count: 0,
      sample_size: 0,
      success_rate: 0,
      availability: 0,
    });
    expect(r.sample_size).toBe(0);
  });

  it("rejects extra top-level keys (strict mode)", () => {
    expect(() => ReputationCredentialSubjectSchema.parse({ ...SAMPLE, sneak: "no" })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// TrustCredentialSubject
// ---------------------------------------------------------------------------

describe("TrustCredentialSubjectSchema", () => {
  const SAMPLE: Record<string, unknown> = {
    id: SUBJECT_ID,
    trust_level: "verified",
    interaction_count: 50,
    successful_tasks: 47,
    failed_tasks: 3,
    first_seen_at: 1_700_000_000_000,
    last_seen_at: 1_713_400_000_000,
  };

  it("parses a valid trust subject", () => {
    const t = TrustCredentialSubjectSchema.parse(SAMPLE);
    expect(t.trust_level).toBe("verified");
  });

  it("accepts arbitrary trust_level strings (issuer-policy)", () => {
    for (const level of ["untrusted", "verified", "trusted", "revoked", "custom-tier"]) {
      const t = TrustCredentialSubjectSchema.parse({ ...SAMPLE, trust_level: level });
      expect(t.trust_level).toBe(level);
    }
  });

  it("rejects empty trust_level", () => {
    expect(() => TrustCredentialSubjectSchema.parse({ ...SAMPLE, trust_level: "" })).toThrow();
  });

  it("rejects negative task counts", () => {
    expect(() => TrustCredentialSubjectSchema.parse({ ...SAMPLE, successful_tasks: -1 })).toThrow();
    expect(() => TrustCredentialSubjectSchema.parse({ ...SAMPLE, failed_tasks: -1 })).toThrow();
    expect(() =>
      TrustCredentialSubjectSchema.parse({ ...SAMPLE, interaction_count: -1 }),
    ).toThrow();
  });

  it("rejects non-integer counts", () => {
    expect(() =>
      TrustCredentialSubjectSchema.parse({ ...SAMPLE, interaction_count: 1.5 }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// GradientCredentialSubject
// ---------------------------------------------------------------------------

describe("GradientCredentialSubjectSchema", () => {
  const SAMPLE: Record<string, unknown> = {
    id: SUBJECT_ID,
    gradient: 0.42,
    knowledge_density: 0.71,
    knowledge_quality: 0.85,
    graph_connectivity: 0.6,
    temporal_stability: 0.92,
    retrieval_quality: 0.78,
    interaction_efficiency: 0.55,
    tool_efficiency: 0.66,
    curiosity_pressure: 0.3,
    measured_at: 1_713_456_000_000,
  };

  it("parses a valid gradient subject", () => {
    const g = GradientCredentialSubjectSchema.parse(SAMPLE);
    expect(g.gradient).toBe(0.42);
    expect(g.knowledge_quality).toBe(0.85);
  });

  it("accepts negative gradient (regression / drift case)", () => {
    const g = GradientCredentialSubjectSchema.parse({ ...SAMPLE, gradient: -0.2 });
    expect(g.gradient).toBe(-0.2);
  });

  it("rejects missing required signal (every field is non-optional)", () => {
    const fields = [
      "gradient",
      "knowledge_density",
      "knowledge_quality",
      "graph_connectivity",
      "temporal_stability",
      "retrieval_quality",
      "interaction_efficiency",
      "tool_efficiency",
      "curiosity_pressure",
      "measured_at",
    ];
    for (const f of fields) {
      const bad = { ...SAMPLE };
      delete bad[f];
      expect(() => GradientCredentialSubjectSchema.parse(bad), `missing ${f}`).toThrow();
    }
  });

  it("rejects extra top-level keys (strict mode)", () => {
    expect(() => GradientCredentialSubjectSchema.parse({ ...SAMPLE, sneak: "no" })).toThrow();
  });

  it("rejects empty subject id", () => {
    expect(() => GradientCredentialSubjectSchema.parse({ ...SAMPLE, id: "" })).toThrow();
  });
});
