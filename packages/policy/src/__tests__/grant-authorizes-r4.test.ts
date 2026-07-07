/**
 * Step 8c + grant-aware offering — the disjunct's other half, decided
 * 2026-07-07 after the first live ceremony found the R4 tool INVISIBLE
 * to the model (offering filtered by max risk) and the approval band
 * unmoved by a verified $1 grant. "Money authorization = a signed
 * verified standing grant OR a live human approval"
 * (memory-never-confers-authority.md) — this suite pins the OR, and
 * every bound that keeps it narrow:
 *   - verified grant + in-scope R4  → offered + auto-executes
 *   - grant, OUT-of-scope tool      → still filtered / still fenced
 *   - grantless R4                  → 8b re-raises (unchanged invariant)
 *   - denyAbove < R4                → hard ceiling; grant NEVER overrides
 *   - deny-list                     → grant never overrides
 */
import { describe, it, expect } from "vitest";
import { PolicyGate } from "../policy-gate.js";
import { RiskLevel } from "../index.js";
import type { ToolDefinition } from "@motebit/sdk";

const MONEY_TOOL = {
  name: "delegate_to_agent",
  description: "delegate",
  parameters: { type: "object", properties: {} },
  riskHint: { risk: RiskLevel.R4_MONEY },
} as unknown as ToolDefinition;
const READ_TOOL = {
  name: "recall_self",
  description: "recall",
  parameters: { type: "object", properties: {} },
  riskHint: { risk: RiskLevel.R0_READ },
} as unknown as ToolDefinition;

const GRANT = { grant_id: "g-1", scope: "delegate_to_agent" } as never;

function gate(config: Record<string, unknown> = {}): PolicyGate {
  return new PolicyGate({ maxRiskLevel: RiskLevel.R3_EXECUTE, ...config } as never);
}

function grantCtx(g: PolicyGate, scope = "delegate_to_agent") {
  return { ...g.createTurnContext(), delegationScope: scope, verifiedGrant: GRANT };
}

describe("offering (filterTools)", () => {
  it("R4 tool is INVISIBLE without a grant (the ceremony blocker, preserved for grantless turns)", () => {
    const g = gate();
    const offered = g.filterTools([MONEY_TOOL, READ_TOOL], g.createTurnContext());
    expect(offered.map((t) => t.name)).toEqual(["recall_self"]);
  });

  it("verified in-scope grant makes the R4 tool visible", () => {
    const g = gate();
    const offered = g.filterTools([MONEY_TOOL, READ_TOOL], grantCtx(g));
    expect(offered.map((t) => t.name)).toContain("delegate_to_agent");
  });

  it("grant does NOT offer an R4 tool outside its scope", () => {
    const g = gate();
    const otherMoney = { ...MONEY_TOOL, name: "pay_invoice" } as unknown as ToolDefinition;
    const offered = g.filterTools([otherMoney], grantCtx(g, "delegate_to_agent"));
    expect(offered).toHaveLength(0);
  });

  it("denyAbove is a hard ceiling the grant never lifts", () => {
    const g = gate({ requireApprovalAbove: RiskLevel.R1_DRAFT, denyAbove: RiskLevel.R3_EXECUTE });
    const offered = g.filterTools([MONEY_TOOL], grantCtx(g));
    expect(offered).toHaveLength(0);
  });

  it("deny-list beats the grant", () => {
    const g = gate({ toolDenyList: ["delegate_to_agent"] });
    const offered = g.filterTools([MONEY_TOOL], grantCtx(g));
    expect(offered).toHaveLength(0);
  });
});

describe("approval (validate step 8c)", () => {
  it("verified in-scope grant auto-executes R4 — no human prompt", () => {
    const g = gate({ requireApprovalAbove: RiskLevel.R1_DRAFT, denyAbove: RiskLevel.R4_MONEY });
    const d = g.validate(MONEY_TOOL, {}, grantCtx(g));
    expect(d.allowed).toBe(true);
    expect(d.requiresApproval).toBe(false);
  });

  it("grantless R4 still requires approval (8b unchanged)", () => {
    const g = gate({ requireApprovalAbove: RiskLevel.R1_DRAFT, denyAbove: RiskLevel.R4_MONEY });
    const d = g.validate(MONEY_TOOL, {}, g.createTurnContext());
    expect(d.requiresApproval).toBe(true);
  });

  it("grant with a DIFFERENT scope does not clear the tool (fence at step 2)", () => {
    const g = gate({ requireApprovalAbove: RiskLevel.R1_DRAFT, denyAbove: RiskLevel.R4_MONEY });
    const d = g.validate(MONEY_TOOL, {}, grantCtx(g, "pay_invoice"));
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/outside delegated scope/);
  });

  it("denyAbove < R4 hard-denies even WITH a verified grant", () => {
    const g = gate({ requireApprovalAbove: RiskLevel.R1_DRAFT, denyAbove: RiskLevel.R3_EXECUTE });
    const d = g.validate(MONEY_TOOL, {}, grantCtx(g));
    expect(d.allowed).toBe(false);
    expect(d.requiresApproval).toBe(false);
  });
});
