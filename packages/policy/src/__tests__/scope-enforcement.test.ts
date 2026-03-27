import { describe, it, expect } from "vitest";
import { PolicyGate, InMemoryAuditSink } from "../index.js";
import type { ToolDefinition, TurnContext } from "@motebit/protocol";

function makeTool(name: string): ToolDefinition {
  return { name, description: `Tool ${name}`, inputSchema: { type: "object" } };
}

function makeGate(): PolicyGate {
  const sink = new InMemoryAuditSink();
  return new PolicyGate({ operatorMode: true }, sink);
}

function makeCtx(delegationScope?: string): TurnContext {
  return {
    turnId: "t-1",
    toolCallCount: 0,
    turnStartMs: Date.now(),
    costAccumulated: 0,
    delegationScope,
  };
}

describe("Scope enforcement on delegation", () => {
  it("allows tool within scope", () => {
    const gate = makeGate();
    const decision = gate.validate(makeTool("web_search"), {}, makeCtx("web_search,file_read"));
    expect(decision.allowed).toBe(true);
  });

  it("denies tool outside scope", () => {
    const gate = makeGate();
    const decision = gate.validate(makeTool("file_write"), {}, makeCtx("web_search"));
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("outside delegated scope");
  });

  it("allows all tools with wildcard scope", () => {
    const gate = makeGate();
    const decision = gate.validate(makeTool("file_write"), {}, makeCtx("*"));
    expect(decision.allowed).toBe(true);
  });

  it("does not restrict when no delegation scope (local user)", () => {
    const gate = makeGate();
    const decision = gate.validate(makeTool("file_write"), {}, makeCtx(undefined));
    expect(decision.allowed).toBe(true);
  });

  it("denies all tools with empty scope (fail-closed)", () => {
    const gate = makeGate();
    const decision = gate.validate(makeTool("web_search"), {}, makeCtx(""));
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("outside delegated scope");
  });
});
