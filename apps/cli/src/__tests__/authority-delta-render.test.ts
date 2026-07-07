/**
 * Owner-side AuthorityDelta rendering — every residual class produces a
 * repair line (the gate-repair-instructions contract; sibling of the
 * grant pre-flight renderer).
 */
import { describe, it, expect } from "vitest";
import { renderAuthorityDelta } from "../authority-delta-render.js";
import { RiskLevel } from "@motebit/sdk";

describe("renderAuthorityDelta", () => {
  it("scope residual names the missing scope and the mint command", () => {
    const out = renderAuthorityDelta("delegate_to_agent", {
      missing_scope: ["delegate_to_agent"],
    }).join("\n");
    expect(out).toContain("does not cover delegate_to_agent");
    expect(out).toContain("--scope delegate_to_agent");
  });

  it("grant-required residual teaches the grant-or-tap disjunction", () => {
    const out = renderAuthorityDelta("delegate_to_agent", {
      required_risk: RiskLevel.R4_MONEY,
      requires_verified_grant: true,
    }).join("\n");
    expect(out).toContain("verified grant or your live approval");
    expect(out).toContain("motebit grant create");
  });

  it("posture residual names both risk levels and the deliberate change", () => {
    const out = renderAuthorityDelta("delegate_to_agent", {
      required_risk: RiskLevel.R4_MONEY,
      posture_ceiling: RiskLevel.R3_EXECUTE,
    }).join("\n");
    expect(out).toContain("R4_MONEY");
    expect(out).toContain("R3_EXECUTE");
    expect(out).toContain("approvalPreset");
  });

  it("spend + window residuals render dollars and the unlock time", () => {
    const out = renderAuthorityDelta("delegate_to_agent", {
      spend_overage_micro: 400_000,
      not_before: 1_783_425_600_000,
    }).join("\n");
    expect(out).toContain("$0.4000");
    expect(out).toContain(new Date(1_783_425_600_000).toISOString());
  });

  it("terminal residual short-circuits to re-mint", () => {
    const out = renderAuthorityDelta("delegate_to_agent", { terminal: "revoked" }).join("\n");
    expect(out).toContain("revoked — terminal");
    expect(out).toContain("grant create");
  });
});
