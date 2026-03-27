import { describe, it, expect } from "vitest";
import { PolicyGate, InMemoryAuditSink } from "../index.js";
import { RiskLevel, DataClass, SideEffect } from "@motebit/protocol";
import type { ToolDefinition, TurnContext } from "@motebit/protocol";

function makeTool(name: string, riskHint?: ToolDefinition["riskHint"]): ToolDefinition {
  return { name, description: `Tool ${name}`, inputSchema: { type: "object" }, riskHint };
}

function makeGate(quorum?: {
  threshold: number;
  approvers: string[];
  risk_floor?: string;
}): PolicyGate {
  const sink = new InMemoryAuditSink();
  return new PolicyGate(
    {
      operatorMode: true,
      requireApprovalAbove: RiskLevel.R1_DRAFT,
      denyAbove: RiskLevel.R4_MONEY,
      approvalQuorum: quorum,
    },
    sink,
  );
}

function makeCtx(): TurnContext {
  return {
    turnId: "t-1",
    toolCallCount: 0,
    turnStartMs: Date.now(),
    costAccumulated: 0,
  };
}

describe("PolicyGate quorum metadata", () => {
  it("attaches quorum metadata when quorum configured and approval needed", () => {
    const gate = makeGate({ threshold: 2, approvers: ["alice", "bob", "charlie"] });
    // R2_WRITE > requireApprovalAbove (R1_DRAFT), so needs approval
    const tool = makeTool("write_file", {
      risk: RiskLevel.R2_WRITE,
      dataClass: DataClass.PUBLIC,
      sideEffect: SideEffect.REVERSIBLE,
    });
    const decision = gate.validate(tool, {}, makeCtx());
    expect(decision.requiresApproval).toBe(true);
    expect(decision.quorum).toBeDefined();
    expect(decision.quorum!.required).toBe(2);
    expect(decision.quorum!.approvers).toEqual(["alice", "bob", "charlie"]);
    expect(decision.quorum!.collected).toEqual([]);
  });

  it("does not attach quorum when threshold is 1", () => {
    const gate = makeGate({ threshold: 1, approvers: ["alice"] });
    const tool = makeTool("write_file", {
      risk: RiskLevel.R2_WRITE,
      dataClass: DataClass.PUBLIC,
      sideEffect: SideEffect.REVERSIBLE,
    });
    const decision = gate.validate(tool, {}, makeCtx());
    expect(decision.requiresApproval).toBe(true);
    expect(decision.quorum).toBeUndefined();
  });

  it("does not attach quorum when risk is below floor", () => {
    const gate = makeGate({ threshold: 2, approvers: ["alice", "bob"], risk_floor: "R3_EXECUTE" });
    // R2_WRITE is below R3_EXECUTE floor
    const tool = makeTool("write_file", {
      risk: RiskLevel.R2_WRITE,
      dataClass: DataClass.PUBLIC,
      sideEffect: SideEffect.REVERSIBLE,
    });
    const decision = gate.validate(tool, {}, makeCtx());
    expect(decision.requiresApproval).toBe(true);
    expect(decision.quorum).toBeUndefined();
  });

  it("attaches quorum when risk meets floor", () => {
    const gate = makeGate({ threshold: 2, approvers: ["alice", "bob"], risk_floor: "R2_WRITE" });
    const tool = makeTool("shell_exec", {
      risk: RiskLevel.R3_EXECUTE,
      dataClass: DataClass.PUBLIC,
      sideEffect: SideEffect.IRREVERSIBLE,
    });
    const decision = gate.validate(tool, {}, makeCtx());
    expect(decision.requiresApproval).toBe(true);
    expect(decision.quorum).toBeDefined();
    expect(decision.quorum!.required).toBe(2);
  });

  it("no quorum when no approval needed (auto-allowed tool)", () => {
    const gate = makeGate({ threshold: 2, approvers: ["alice", "bob"] });
    // R0_READ <= requireApprovalAbove (R1_DRAFT), auto-allowed
    const tool = makeTool("web_search");
    const decision = gate.validate(tool, {}, makeCtx());
    expect(decision.allowed).toBe(true);
    expect(decision.requiresApproval).toBe(false);
    expect(decision.quorum).toBeUndefined();
  });

  it("backward compat: no quorum configured means no quorum metadata", () => {
    const gate = makeGate(undefined);
    const tool = makeTool("write_file", {
      risk: RiskLevel.R2_WRITE,
      dataClass: DataClass.PUBLIC,
      sideEffect: SideEffect.REVERSIBLE,
    });
    const decision = gate.validate(tool, {}, makeCtx());
    expect(decision.requiresApproval).toBe(true);
    expect(decision.quorum).toBeUndefined();
  });
});
