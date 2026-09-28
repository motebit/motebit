/**
 * #880 E — a Trusted caller is capped at the owner's band.
 *
 * Trusted is earned automatically from this motebit's OUTBOUND hires
 * (20 successes at ≥0.9, `evaluateTrustTransition`). The gate used to read
 * it as unconditional INBOUND authority: `needsApproval = false`. That gave
 * a Trusted caller more than the owner, because under the balanced and
 * cautious presets the owner's own R2/R3 turns ask for approval. The gate's
 * stated contract is "same privileges as local user", so it is now exactly
 * that. A Trusted caller needs approval exactly when the owner's own turn
 * would, and clears what the owner's preset auto-allows.
 *
 * The matrix compares every (preset × risk) cell against the owner's own
 * decision, so no hard-coded expectation can drift from the rule.
 */
import { describe, it, expect } from "vitest";
import { PolicyGate } from "../index.js";
import { APPROVAL_PRESET_CONFIGS } from "@motebit/sdk";
import { AgentTrustLevel, RiskLevel } from "@motebit/protocol";
import type { ToolDefinition, TurnContext } from "@motebit/protocol";

function tool(risk: RiskLevel): ToolDefinition {
  // No tool-level requiresApproval: this isolates the band (step 8a is a separate rule).
  return {
    name: `t_r${risk}`,
    description: "t",
    inputSchema: { type: "object" },
    riskHint: { risk },
  };
}

function ctx(over: Partial<TurnContext> = {}): TurnContext {
  return { turnId: "t", toolCallCount: 0, turnStartMs: Date.now(), costAccumulated: 0, ...over };
}

function gateFor(preset: string): PolicyGate {
  const p = APPROVAL_PRESET_CONFIGS[preset]!;
  return new PolicyGate({
    operatorMode: true,
    maxRiskLevel: p.maxRiskLevel as RiskLevel,
    requireApprovalAbove: p.requireApprovalAbove as RiskLevel,
    denyAbove: p.denyAbove as RiskLevel,
  });
}

const TRUSTED = { callerMotebitId: "hired-worker", callerTrustLevel: AgentTrustLevel.Trusted };
const RISKS = [RiskLevel.R0_READ, RiskLevel.R1_DRAFT, RiskLevel.R2_WRITE, RiskLevel.R3_EXECUTE];

describe("a Trusted caller is capped at the owner's band (#880 E)", () => {
  for (const preset of ["cautious", "balanced", "autonomous"]) {
    for (const risk of RISKS) {
      it(`${preset} / ${RiskLevel[risk]}: Trusted decides exactly as the owner's own turn`, () => {
        const gate = gateFor(preset);
        const owner = gate.validate(tool(risk), {}, ctx());
        const trusted = gate.validate(tool(risk), {}, ctx(TRUSTED));
        expect(trusted.allowed).toBe(owner.allowed);
        expect(trusted.requiresApproval).toBe(owner.requiresApproval);
      });
    }
  }

  it("balanced: a Trusted caller's R2 and R3 need approval (the old bypass cleared both)", () => {
    const gate = gateFor("balanced");
    expect(gate.validate(tool(RiskLevel.R2_WRITE), {}, ctx(TRUSTED)).requiresApproval).toBe(true);
    expect(gate.validate(tool(RiskLevel.R3_EXECUTE), {}, ctx(TRUSTED)).requiresApproval).toBe(true);
  });

  it("cautious: a Trusted caller's R1 needs approval", () => {
    expect(
      gateFor("cautious").validate(tool(RiskLevel.R1_DRAFT), {}, ctx(TRUSTED)).requiresApproval,
    ).toBe(true);
  });

  it("autonomous is unchanged: a Trusted caller's R3 auto-allows, as the owner's does", () => {
    const d = gateFor("autonomous").validate(tool(RiskLevel.R3_EXECUTE), {}, ctx(TRUSTED));
    expect(d.allowed).toBe(true);
    expect(d.requiresApproval).toBe(false);
  });

  it("Trusted still differs from Unknown: it clears what the owner auto-allows, Unknown never does", () => {
    const gate = gateFor("balanced");
    const r1 = tool(RiskLevel.R1_DRAFT);
    expect(gate.validate(r1, {}, ctx(TRUSTED)).requiresApproval).toBe(false);
    expect(
      gate.validate(
        r1,
        {},
        ctx({ callerMotebitId: "x", callerTrustLevel: AgentTrustLevel.Unknown }),
      ).requiresApproval,
    ).toBe(true);
  });
});
