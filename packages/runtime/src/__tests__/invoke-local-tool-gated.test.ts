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

describe("invokeLocalTool — durable execution ledger (intent row, then completion row)", () => {
  async function setupWithSink() {
    const { InMemoryAuditSink } = await import("@motebit/policy");
    const sink = new InMemoryAuditSink();
    const reg = new SimpleToolRegistry();
    reg.register(toolDef("write_thing", RiskLevel.R2_WRITE), async (): Promise<ToolResult> => ({
      ok: true,
      data: "ok",
    }));
    reg.register(toolDef("explode", RiskLevel.R2_WRITE), async (): Promise<ToolResult> => {
      throw new Error("boom");
    });
    const runtime = new MotebitRuntime(
      {
        motebitId: "test-mote",
        tickRateHz: 0,
        policy: { requireApprovalAbove: RiskLevel.R1_DRAFT, denyAbove: RiskLevel.R4_MONEY },
      },
      {
        storage: { ...createInMemoryStorage(), toolAuditSink: sink },
        renderer: new NullRenderer(),
      },
    );
    runtime.registerExternalTools("test", reg);
    return { runtime, sink };
  }

  it("writes the decision row before execution and closes it with the tool's verdict after", async () => {
    const { runtime, sink } = await setupWithSink();
    const res = await runtime.invokeLocalTool("write_thing", { p: 1 });
    expect(res.ok).toBe(true);
    const rows = sink.getAll().filter((r) => r.tool === "write_thing");
    expect(rows.length).toBeGreaterThanOrEqual(2);
    const callId = rows[0]!.callId;
    expect(rows.every((r) => r.callId === callId)).toBe(true);
    expect(rows[0]!.result).toBeUndefined();
    expect(rows[rows.length - 1]!.result?.ok).toBe(true);
  });

  it("a throwing handler still closes the row as failed", async () => {
    const { runtime, sink } = await setupWithSink();
    const res = await runtime.invokeLocalTool("explode", {});
    expect(res.ok).toBe(false);
    const rows = sink.getAll().filter((r) => r.tool === "explode");
    expect(rows[rows.length - 1]!.result?.ok).toBe(false);
  });

  it("humanApproved satisfies the approval band for a scheduled origin (R2), never R4", async () => {
    const { runtime } = await setupWithSink();
    const ok = await runtime.invokeLocalTool(
      "write_thing",
      {},
      { invocationOrigin: "scheduled", humanApproved: true },
    );
    expect(ok.ok).toBe(true);
    const notApproved = await runtime.invokeLocalTool(
      "write_thing",
      {},
      { invocationOrigin: "scheduled" },
    );
    expect(notApproved.ok).toBe(false);
  });
});

describe("invokeLocalTool — humanApproved never clears R4_MONEY", () => {
  it("R4 stays blocked even with humanApproved (only a verified grant clears it)", async () => {
    const { runtime, executed } = setup();
    const res = await runtime.invokeLocalTool(
      "pay_thing",
      {},
      { invocationOrigin: "scheduled", humanApproved: true },
    );
    expect(res.ok).toBe(false);
    expect(executed).not.toContain("pay_thing");
  });
});
