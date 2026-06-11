/**
 * Finding (h): `invokeLocalTool` must route through the SAME policy gate as
 * the AI loop — a local frontend is not an exception
 * (docs/doctrine/surface-authority-model.md § keystone).
 *
 * These tests pin the gate semantics against the REAL `PolicyGate`:
 *   - a hard deny (denylist / band) blocks regardless of origin;
 *   - a genuine `user-tap` IS the human approval for reversible/irreversible
 *     local tools (R0–R3) — it satisfies the approval band without a modal;
 *   - a non-tap origin cannot grant that approval;
 *   - R4_MONEY is NEVER satisfiable by a bare tap (only a verified standing
 *     grant clears it, and a per-invocation TurnContext carries none);
 *   - an unknown / unclassifiable tool fails closed.
 *
 * The shared `executed[]` log is the ground truth: a blocked tool never runs.
 */
import { describe, it, expect } from "vitest";
import { MotebitRuntime, NullRenderer, createInMemoryStorage, SimpleToolRegistry } from "../index";
import type { PlatformAdapters } from "../index";
import { RiskLevel } from "@motebit/sdk";
import type { ToolDefinition, ToolResult } from "@motebit/sdk";
import type { PolicyConfig } from "@motebit/policy";

function toolDef(name: string, risk: RiskLevel): ToolDefinition {
  return {
    name,
    description: `test tool ${name}`,
    inputSchema: { type: "object" },
    riskHint: { risk },
  };
}

function setup(policy: Partial<PolicyConfig> = {}) {
  const executed: string[] = [];
  const reg = new SimpleToolRegistry();
  const tiers: Array<[string, RiskLevel]> = [
    ["read_thing", RiskLevel.R0_READ],
    ["write_thing", RiskLevel.R2_WRITE],
    ["pay_thing", RiskLevel.R4_MONEY],
  ];
  for (const [name, risk] of tiers) {
    reg.register(toolDef(name, risk), async (): Promise<ToolResult> => {
      executed.push(name);
      return { ok: true, data: name };
    });
  }
  const adapters: PlatformAdapters = {
    storage: createInMemoryStorage(),
    renderer: new NullRenderer(),
  };
  const runtime = new MotebitRuntime(
    {
      motebitId: "test-mote",
      tickRateHz: 0,
      // R0–R1 auto-allow; R2–R4 require approval; nothing hard-denied by band
      // (so R4 reaches the requiresApproval path, not allowed:false).
      policy: {
        requireApprovalAbove: RiskLevel.R1_DRAFT,
        denyAbove: RiskLevel.R4_MONEY,
        ...policy,
      },
    },
    adapters,
  );
  runtime.registerExternalTools("test", reg);
  return { runtime, executed };
}

describe("invokeLocalTool — the policy gate is unbypassable (finding h)", () => {
  it("executes an allowed R0 read tool", async () => {
    const { runtime, executed } = setup();
    const r = await runtime.invokeLocalTool("read_thing", {});
    expect(r.ok).toBe(true);
    expect(executed).toEqual(["read_thing"]);
  });

  it("a user tap satisfies approval for a reversible (R2) write tool", async () => {
    const { runtime, executed } = setup();
    const r = await runtime.invokeLocalTool("write_thing", {}, { invocationOrigin: "user-tap" });
    expect(r.ok).toBe(true);
    expect(executed).toContain("write_thing");
  });

  it("a non-tap origin cannot grant approval — blocked, not executed", async () => {
    const { runtime, executed } = setup();
    const r = await runtime.invokeLocalTool("write_thing", {}, { invocationOrigin: "ai-loop" });
    expect(r.ok).toBe(false);
    expect(executed).not.toContain("write_thing");
  });

  it("a hard deny (denylist) blocks even a user tap", async () => {
    const { runtime, executed } = setup({ toolDenyList: ["write_thing"] });
    const r = await runtime.invokeLocalTool("write_thing", {}, { invocationOrigin: "user-tap" });
    expect(r.ok).toBe(false);
    expect(executed).not.toContain("write_thing");
  });

  it("R4 money is NEVER satisfiable by a bare tap — blocked without a verified grant", async () => {
    const { runtime, executed } = setup();
    const r = await runtime.invokeLocalTool("pay_thing", {}, { invocationOrigin: "user-tap" });
    expect(r.ok).toBe(false);
    expect(executed).not.toContain("pay_thing");
  });

  it("an unknown tool fails closed", async () => {
    const { runtime, executed } = setup();
    const r = await runtime.invokeLocalTool("nonexistent_thing", {});
    expect(r.ok).toBe(false);
    expect(executed).toEqual([]);
  });
});
