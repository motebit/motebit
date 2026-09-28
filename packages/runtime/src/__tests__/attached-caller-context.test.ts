/**
 * #880 — an attached MCP frontend (`motebit serve` attached) serves OTHER
 * principals. The coordinator used to judge every one of its calls as the
 * owner's own turn (a bare `createTurnContext()`), so no caller-scoped
 * rule could fire on that door. The frontend now forwards the verified
 * caller of the request it is answering; the coordinator applies it, and a
 * forwarded claim may narrow its evaluation but never widen it.
 */
import { describe, it, expect, vi } from "vitest";
import {
  MotebitRuntime,
  NullRenderer,
  createInMemoryStorage,
  resolveAttachedAct,
  resolveAttachedRead,
} from "../index";
import { RiskLevel } from "@motebit/sdk";
import type { PolicyDecision, ToolDefinition } from "@motebit/sdk";

/** A non-local tool that declares its own approval floor (e.g. an MCP tool marked destructive). */
const EXT_WRITE: ToolDefinition = {
  name: "ext_write",
  mode: "api",
  description: "Write a record in the external store",
  inputSchema: { type: "object" },
  requiresApproval: true,
  riskHint: { risk: RiskLevel.R2_WRITE },
};
/** R2 with no tool-level flag. */
const EXT_UPDATE: ToolDefinition = {
  name: "ext_update",
  mode: "api",
  description: "Update a record in the external store",
  inputSchema: { type: "object" },
  riskHint: { risk: RiskLevel.R2_WRITE },
};

function runtimeWith(preset: { requireApprovalAbove: RiskLevel; denyAbove: RiskLevel }) {
  const runtime = new MotebitRuntime(
    {
      motebitId: "coord",
      tickRateHz: 0,
      policy: { operatorMode: true, maxRiskLevel: RiskLevel.R4_MONEY, ...preset },
    },
    { storage: createInMemoryStorage(), renderer: new NullRenderer() },
  );
  const write = vi.fn(async () => ({ ok: true, data: "written" }));
  const update = vi.fn(async () => ({ ok: true, data: "updated" }));
  runtime.getToolRegistry().register(EXT_WRITE, write);
  runtime.getToolRegistry().register(EXT_UPDATE, update);
  return { runtime, write, update };
}

const AUTONOMOUS = { requireApprovalAbove: RiskLevel.R3_EXECUTE, denyAbove: RiskLevel.R4_MONEY };
const BALANCED = { requireApprovalAbove: RiskLevel.R1_DRAFT, denyAbove: RiskLevel.R3_EXECUTE };

describe("attached frontend frames carry the request's caller (#880)", () => {
  it("tool_execute: a remote Verified caller cannot auto-run a tool that declares requiresApproval", async () => {
    const { runtime, write } = runtimeWith(AUTONOMOUS);
    const r = (await resolveAttachedAct(runtime, "tool_execute", {
      name: "ext_write",
      args: {},
      caller: { motebit_id: "peer", trust_level: "verified" },
    })) as { ok: boolean; error?: string };
    expect(r.ok).toBe(false);
    expect(r.error).toContain("requires human approval");
    expect(write).not.toHaveBeenCalled();
  });

  it("policy_validate agrees with tool_execute for the same caller", async () => {
    const { runtime } = runtimeWith(AUTONOMOUS);
    const d = (await resolveAttachedRead(runtime, "policy_validate", {
      name: "ext_write",
      args: {},
      caller: { motebit_id: "peer", trust_level: "verified" },
    })) as PolicyDecision;
    expect(d.requiresApproval).toBe(true);
  });

  it("a Blocked caller is denied — a caller rule the bare owner context could never fire", async () => {
    const { runtime, update } = runtimeWith(AUTONOMOUS);
    const r = (await resolveAttachedAct(runtime, "tool_execute", {
      name: "ext_update",
      args: {},
      caller: { motebit_id: "peer", trust_level: "blocked" },
    })) as { ok: boolean; error?: string };
    expect(r.ok).toBe(false);
    expect(r.error).toContain("blocked");
    expect(update).not.toHaveBeenCalled();
  });

  it("a forwarded Trusted claim never widens: balanced still sends R2 to approval", async () => {
    const { runtime, update } = runtimeWith(BALANCED);
    const r = (await resolveAttachedAct(runtime, "tool_execute", {
      name: "ext_update",
      args: {},
      caller: { motebit_id: "peer", trust_level: "trusted" },
    })) as { ok: boolean; error?: string };
    expect(r.ok).toBe(false);
    expect(update).not.toHaveBeenCalled();
  });

  it("no caller (stdio / static bearer) keeps the pre-#880 evaluation", async () => {
    const { runtime, write } = runtimeWith(AUTONOMOUS);
    const r = (await resolveAttachedAct(runtime, "tool_execute", {
      name: "ext_write",
      args: {},
    })) as { ok: boolean };
    expect(r.ok).toBe(true);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("refuses a malformed caller rather than dropping it", async () => {
    const { runtime } = runtimeWith(AUTONOMOUS);
    await expect(
      resolveAttachedAct(runtime, "tool_execute", {
        name: "ext_update",
        args: {},
        caller: { motebit_id: "peer", trust_level: "owner" },
      }),
    ).rejects.toThrow(/trust_level/);
  });
});
