/**
 * Runtime-parse tests for RouteScoreSchema. Validates the routing-
 * transparency envelope returned alongside TaskResponse.
 */
import { describe, expect, it } from "vitest";

import { RouteScoreSchema } from "../route-score.js";

const SAMPLE: Record<string, unknown> = {
  motebit_id: "019cd9d4-3275-7b24-8265-61ebee41d9d0",
  composite: 0.87,
  sub_scores: {
    trust: 0.95,
    success_rate: 0.98,
    latency: 0.7,
    price_efficiency: 0.8,
    capability_match: 1.0,
    availability: 0.99,
  },
  selected: true,
};

describe("RouteScoreSchema", () => {
  it("parses a fully-populated route score", () => {
    const r = RouteScoreSchema.parse(SAMPLE);
    expect(r.composite).toBe(0.87);
    expect(r.sub_scores.trust).toBe(0.95);
    expect(r.selected).toBe(true);
  });

  it("parses a runner-up (selected: false)", () => {
    const r = RouteScoreSchema.parse({ ...SAMPLE, selected: false, composite: 0.62 });
    expect(r.selected).toBe(false);
    expect(r.composite).toBe(0.62);
  });

  it("requires every sub_score (transparency is non-optional)", () => {
    const subs = [
      "trust",
      "success_rate",
      "latency",
      "price_efficiency",
      "capability_match",
      "availability",
    ];
    for (const k of subs) {
      const bad: Record<string, unknown> = {
        ...SAMPLE,
        sub_scores: { ...(SAMPLE.sub_scores as Record<string, unknown>) },
      };
      delete (bad.sub_scores as Record<string, unknown>)[k];
      expect(() => RouteScoreSchema.parse(bad), `missing sub_score: ${k}`).toThrow();
    }
  });

  it("rejects extra sub_scores keys (strict — protocol-defined surface only)", () => {
    expect(() =>
      RouteScoreSchema.parse({
        ...SAMPLE,
        sub_scores: { ...(SAMPLE.sub_scores as Record<string, unknown>), creativity: 0.5 },
      }),
    ).toThrow();
  });

  it("preserves unknown top-level keys (forward-compat — unsigned envelope)", () => {
    const r = RouteScoreSchema.parse({ ...SAMPLE, future_v2_field: "preserved" });
    expect((r as Record<string, unknown>).future_v2_field).toBe("preserved");
  });

  it("accepts negative or zero composite (relay policy may produce these)", () => {
    const zero = RouteScoreSchema.parse({ ...SAMPLE, composite: 0 });
    expect(zero.composite).toBe(0);
    const neg = RouteScoreSchema.parse({ ...SAMPLE, composite: -0.5 });
    expect(neg.composite).toBe(-0.5);
  });

  it("rejects empty motebit_id", () => {
    expect(() => RouteScoreSchema.parse({ ...SAMPLE, motebit_id: "" })).toThrow();
  });

  it("rejects non-numeric sub_score values", () => {
    expect(() =>
      RouteScoreSchema.parse({
        ...SAMPLE,
        sub_scores: { ...(SAMPLE.sub_scores as Record<string, unknown>), trust: "high" },
      }),
    ).toThrow();
  });
});
