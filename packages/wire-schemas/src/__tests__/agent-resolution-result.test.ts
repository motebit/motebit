/**
 * Runtime-parse tests for AgentResolutionResultSchema. Validates the
 * shape every external client receives from `GET /api/v1/discover/{id}`.
 */
import { describe, expect, it } from "vitest";

import { AgentResolutionResultSchema } from "../agent-resolution-result.js";

const FOUND: Record<string, unknown> = {
  motebit_id: "019530a1-7b2c-7000-8000-000000000042",
  found: true,
  relay_id: "019530a1-7b2c-7000-8000-000000000001",
  relay_url: "https://relay.example.com",
  capabilities: ["web_search", "code_review"],
  public_key: "a".repeat(64),
  settlement_address: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgHkv",
  settlement_modes: ["relay", "p2p"],
  resolved_via: ["019530a1-...local", "019530a1-...peer1"],
  cached: false,
  ttl: 300,
};

const NOT_FOUND: Record<string, unknown> = {
  motebit_id: "019530a1-7b2c-7000-8000-000000000099",
  found: false,
  resolved_via: ["019530a1-...local", "019530a1-...peer1", "019530a1-...peer2"],
  cached: false,
  ttl: 60,
};

describe("AgentResolutionResultSchema", () => {
  it("parses the full found response (the spec's canonical example)", () => {
    const r = AgentResolutionResultSchema.parse(FOUND);
    expect(r.found).toBe(true);
    expect(r.relay_url).toBe("https://relay.example.com");
    expect(r.settlement_modes).toEqual(["relay", "p2p"]);
  });

  it("parses a minimal not-found response (no `if found` fields)", () => {
    const r = AgentResolutionResultSchema.parse(NOT_FOUND);
    expect(r.found).toBe(false);
    expect(r.relay_id).toBeUndefined();
    expect(r.public_key).toBeUndefined();
  });

  it("preserves absence of settlement_modes (no implicit default)", () => {
    const r = AgentResolutionResultSchema.parse({ ...FOUND, settlement_modes: undefined });
    expect(r.settlement_modes).toBeUndefined();
  });

  it("requires resolved_via even when not found", () => {
    const bad = { ...NOT_FOUND };
    delete bad.resolved_via;
    expect(() => AgentResolutionResultSchema.parse(bad)).toThrow();
  });

  it("rejects a non-URL relay_url", () => {
    expect(() => AgentResolutionResultSchema.parse({ ...FOUND, relay_url: "not a url" })).toThrow();
  });

  it("preserves unknown top-level keys (forward-compat — unsigned envelope)", () => {
    const r = AgentResolutionResultSchema.parse({ ...FOUND, future_v2_field: "preserved" });
    expect((r as Record<string, unknown>).future_v2_field).toBe("preserved");
  });

  it("rejects empty strings inside resolved_via", () => {
    expect(() => AgentResolutionResultSchema.parse({ ...FOUND, resolved_via: [""] })).toThrow();
  });

  it("accepts an empty capabilities array (agent registered but advertises nothing)", () => {
    const r = AgentResolutionResultSchema.parse({ ...FOUND, capabilities: [] });
    expect(r.capabilities).toEqual([]);
  });
});
