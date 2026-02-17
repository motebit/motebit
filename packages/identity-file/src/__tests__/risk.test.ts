import { describe, it, expect } from "vitest";
import { RiskLevel } from "@motebit/sdk";
import { parseRiskLevel, governanceToPolicyConfig } from "../index.js";

describe("parseRiskLevel", () => {
  it("maps all 5 risk levels", () => {
    expect(parseRiskLevel("R0_READ")).toBe(RiskLevel.R0_READ);
    expect(parseRiskLevel("R1_DRAFT")).toBe(RiskLevel.R1_DRAFT);
    expect(parseRiskLevel("R2_WRITE")).toBe(RiskLevel.R2_WRITE);
    expect(parseRiskLevel("R3_EXECUTE")).toBe(RiskLevel.R3_EXECUTE);
    expect(parseRiskLevel("R4_MONEY")).toBe(RiskLevel.R4_MONEY);
  });

  it("throws on unknown names", () => {
    expect(() => parseRiskLevel("INVALID")).toThrow('Unknown risk level "INVALID"');
    expect(() => parseRiskLevel("")).toThrow('Unknown risk level ""');
    expect(() => parseRiskLevel("r1_draft")).toThrow('Unknown risk level "r1_draft"');
  });
});

describe("governanceToPolicyConfig", () => {
  it("converts governance section with all three thresholds", () => {
    const result = governanceToPolicyConfig({
      trust_mode: "guarded",
      max_risk_auto: "R1_DRAFT",
      require_approval_above: "R1_DRAFT",
      deny_above: "R4_MONEY",
      operator_mode: false,
    });

    expect(result.operatorMode).toBe(false);
    expect(result.maxRiskAuto).toBe(RiskLevel.R1_DRAFT);
    expect(result.requireApprovalAbove).toBe(RiskLevel.R1_DRAFT);
    expect(result.denyAbove).toBe(RiskLevel.R4_MONEY);
  });

  it("converts governance section with operator_mode=true", () => {
    const result = governanceToPolicyConfig({
      trust_mode: "full",
      max_risk_auto: "R3_EXECUTE",
      require_approval_above: "R3_EXECUTE",
      deny_above: "R4_MONEY",
      operator_mode: true,
    });

    expect(result.operatorMode).toBe(true);
    expect(result.maxRiskAuto).toBe(RiskLevel.R3_EXECUTE);
    expect(result.requireApprovalAbove).toBe(RiskLevel.R3_EXECUTE);
    expect(result.denyAbove).toBe(RiskLevel.R4_MONEY);
  });

  it("throws on invalid governance risk levels", () => {
    expect(() => governanceToPolicyConfig({
      trust_mode: "guarded",
      max_risk_auto: "UNKNOWN",
      require_approval_above: "R1_DRAFT",
      deny_above: "R4_MONEY",
      operator_mode: false,
    })).toThrow('Unknown risk level "UNKNOWN"');
  });
});
