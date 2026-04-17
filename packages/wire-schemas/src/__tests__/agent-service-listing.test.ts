/**
 * Runtime-parse tests for AgentServiceListingSchema. Validates the
 * shape any external worker (or motebit agent) must emit to advertise
 * on the relay.
 */
import { describe, expect, it } from "vitest";

import { AgentServiceListingSchema } from "../agent-service-listing.js";

const SAMPLE: Record<string, unknown> = {
  listing_id: "019cd9d4-3275-7b24-8265-listing01",
  motebit_id: "019cd9d4-3275-7b24-8265-61ebee41d9d0",
  capabilities: ["web_search", "summarize"],
  pricing: [
    { capability: "web_search", unit_cost: 0.05, currency: "USD", per: "task" },
    { capability: "summarize", unit_cost: 0.0001, currency: "USD", per: "token" },
  ],
  sla: { max_latency_ms: 30_000, availability_guarantee: 0.99 },
  description: "General research & summarization.",
  updated_at: 1_713_456_000_000,
};

describe("AgentServiceListingSchema", () => {
  it("parses a minimal valid listing", () => {
    const l = AgentServiceListingSchema.parse(SAMPLE);
    expect(l.capabilities).toEqual(["web_search", "summarize"]);
    expect(l.pricing).toHaveLength(2);
  });

  it("accepts optional pay_to_address + regulatory_risk", () => {
    const l = AgentServiceListingSchema.parse({
      ...SAMPLE,
      pay_to_address: "0x1234567890abcdef1234567890abcdef12345678",
      regulatory_risk: 0.1,
    });
    expect(l.pay_to_address).toMatch(/^0x/);
    expect(l.regulatory_risk).toBe(0.1);
  });

  it("accepts wildcard `*` capability in pricing", () => {
    const l = AgentServiceListingSchema.parse({
      ...SAMPLE,
      pricing: [{ capability: "*", unit_cost: 0.1, currency: "USD", per: "task" }],
    });
    expect(l.pricing[0]?.capability).toBe("*");
  });

  it("accepts all three `per` units: task, tool_call, token", () => {
    for (const per of ["task", "tool_call", "token"] as const) {
      const l = AgentServiceListingSchema.parse({
        ...SAMPLE,
        pricing: [{ capability: "x", unit_cost: 1, currency: "USD", per }],
      });
      expect(l.pricing[0]?.per).toBe(per);
    }
  });

  it("rejects an unknown `per` unit (not one of task | tool_call | token)", () => {
    expect(() =>
      AgentServiceListingSchema.parse({
        ...SAMPLE,
        pricing: [{ capability: "x", unit_cost: 1, currency: "USD", per: "hour" }],
      }),
    ).toThrow();
  });

  it("rejects missing `sla.max_latency_ms`", () => {
    expect(() =>
      AgentServiceListingSchema.parse({
        ...SAMPLE,
        sla: { availability_guarantee: 0.99 },
      }),
    ).toThrow();
  });

  it("rejects extra top-level keys (strict mode)", () => {
    expect(() => AgentServiceListingSchema.parse({ ...SAMPLE, sneak: "not allowed" })).toThrow();
  });

  it("rejects empty capability strings", () => {
    expect(() => AgentServiceListingSchema.parse({ ...SAMPLE, capabilities: [""] })).toThrow();
  });
});
