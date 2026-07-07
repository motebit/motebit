/**
 * AuthorityDelta — every refusal a typed, owner-facing repair
 * instruction. Pins that each deny/raise site populates its residual
 * from the single producer module, that allows carry none, and that the
 * blast-radius evaluator's overage/window math is exact.
 * The asymmetry invariant (delta never reaches the model) is pinned in
 * ai-core's loop tests — this suite owns the producer side.
 */
import { describe, it, expect } from "vitest";
import { PolicyGate } from "../policy-gate.js";
import { RiskLevel } from "../index.js";
import { evaluateBlastRadius, freshGrantSpendState } from "../grant-blast-radius.js";
import type { ToolDefinition } from "@motebit/sdk";

const MONEY_TOOL = {
  name: "delegate_to_agent",
  description: "delegate",
  parameters: { type: "object", properties: {} },
  riskHint: { risk: RiskLevel.R4_MONEY },
} as unknown as ToolDefinition;

describe("policy-gate deny/raise sites populate typed residuals", () => {
  it("scope fence → missing_scope", () => {
    const g = new PolicyGate({ maxRiskLevel: RiskLevel.R4_MONEY } as never);
    const d = g.validate(MONEY_TOOL, {}, {
      ...g.createTurnContext(),
      delegationScope: "pay_invoice",
      verifiedGrant: { grant_id: "g" },
    } as never);
    expect(d.allowed).toBe(false);
    expect(d.missing_authority).toEqual({ missing_scope: ["delegate_to_agent"] });
  });

  it("denyAbove hard ceiling → required_risk + posture_ceiling", () => {
    const g = new PolicyGate({
      maxRiskLevel: RiskLevel.R3_EXECUTE,
      requireApprovalAbove: RiskLevel.R1_DRAFT,
      denyAbove: RiskLevel.R3_EXECUTE,
    } as never);
    const d = g.validate(MONEY_TOOL, {}, g.createTurnContext());
    expect(d.allowed).toBe(false);
    expect(d.missing_authority).toEqual({
      required_risk: RiskLevel.R4_MONEY,
      posture_ceiling: RiskLevel.R3_EXECUTE,
    });
  });

  it("legacy max-risk deny → required_risk + posture_ceiling", () => {
    const g = new PolicyGate({ maxRiskLevel: RiskLevel.R2_WRITE } as never);
    const d = g.validate(MONEY_TOOL, {}, g.createTurnContext());
    expect(d.allowed).toBe(false);
    expect(d.missing_authority).toEqual({
      required_risk: RiskLevel.R4_MONEY,
      posture_ceiling: RiskLevel.R2_WRITE,
    });
  });

  it("8b raise (R4, no grant) → requires_verified_grant", () => {
    const g = new PolicyGate({
      maxRiskLevel: RiskLevel.R4_MONEY,
      requireApprovalAbove: RiskLevel.R3_EXECUTE,
      denyAbove: RiskLevel.R4_MONEY,
    } as never);
    const d = g.validate(MONEY_TOOL, {}, g.createTurnContext());
    expect(d.allowed).toBe(true);
    expect(d.requiresApproval).toBe(true);
    expect(d.missing_authority).toEqual({
      required_risk: RiskLevel.R4_MONEY,
      requires_verified_grant: true,
    });
  });

  it("grant-cleared R4 (8c) carries NO residual — nothing is missing", () => {
    const g = new PolicyGate({
      maxRiskLevel: RiskLevel.R4_MONEY,
      requireApprovalAbove: RiskLevel.R3_EXECUTE,
      denyAbove: RiskLevel.R4_MONEY,
    } as never);
    const d = g.validate(MONEY_TOOL, {}, {
      ...g.createTurnContext(),
      delegationScope: "delegate_to_agent",
      verifiedGrant: { grant_id: "g" },
    } as never);
    expect(d.allowed).toBe(true);
    expect(d.requiresApproval).toBe(false);
    expect(d.missing_authority).toBeUndefined();
  });
});

describe("blast-radius residuals — exact overage and window math", () => {
  const CEILING = {
    lifetime_limit_micro: 1_000_000,
    cumulative_limit_micro: 100_000,
    window_ms: 3_600_000,
  } as never;

  it("lifetime overage is exact, with no window unlock (lifetime never rolls)", () => {
    const state = { ...freshGrantSpendState("g", 0), lifetime_spent_micro: 990_000 };
    const r = evaluateBlastRadius(
      CEILING,
      state as never,
      {
        amount_micro: 60_000,
        counterparty: "addr1",
      } as never,
      1,
      10,
    );
    expect(r.decision.allowed).toBe(false);
    expect(r.decision.denial).toBe("lifetime_exceeded");
    expect(r.decision.missing_authority).toEqual({ spend_overage_micro: 50_000 });
  });

  it("window overage carries the overage AND when headroom returns", () => {
    const state = {
      ...freshGrantSpendState("g", 1_000),
      window_spent_micro: 90_000,
      window_started_at: 1_000,
    };
    const r = evaluateBlastRadius(
      CEILING,
      state as never,
      {
        amount_micro: 52_632,
        counterparty: "addr1",
      } as never,
      2,
      2_000,
    );
    expect(r.decision.allowed).toBe(false);
    expect(r.decision.denial).toBe("cumulative_exceeded");
    expect(r.decision.missing_authority).toEqual({
      spend_overage_micro: 42_632,
      not_before: 1_000 + 3_600_000,
    });
  });

  it("structural denials (replay) carry NO residual — no repair exists in-band", () => {
    const state = { ...freshGrantSpendState("g", 0), high_water_nonce: 99 };
    const r = evaluateBlastRadius(
      CEILING,
      state as never,
      {
        amount_micro: 1_000,
        counterparty: "addr1",
      } as never,
      99,
      10,
    );
    expect(r.decision.denial).toBe("replay");
    expect(r.decision.missing_authority).toBeUndefined();
  });

  it("allowed actions carry no residual", () => {
    const r = evaluateBlastRadius(
      CEILING,
      freshGrantSpendState("g", 0) as never,
      {
        amount_micro: 1_000,
        counterparty: "addr1",
      } as never,
      1,
      10,
    );
    expect(r.decision.allowed).toBe(true);
    expect(r.decision.missing_authority).toBeUndefined();
  });
});
