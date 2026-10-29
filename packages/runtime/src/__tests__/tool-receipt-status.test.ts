/**
 * Honest tool-receipt status on every path of the general runtime, recorded
 * in the durable sink (`RuntimeConfig.toolReceiptSink`):
 *   - AI loop: success ⇒ completed, a throw or `ok:false` ⇒ failed, a policy
 *     refusal ⇒ denied — WITH a receipt (refusals used to get none);
 *   - approval resume: approved ⇒ the executed call's status, refused ⇒ denied;
 *   - `invokeLocalTool`: a refusal ⇒ denied;
 *   - the sink is fail-closed: a rejection, or a missing key, stops the turn.
 * Drives the real ai-core loop end to end (no loop mock).
 */
import { describe, expect, it, vi } from "vitest";
import { generateKeypair, verifyToolInvocationReceipt } from "@motebit/crypto";
import type { StreamingProvider } from "@motebit/ai-core";
import type { AIResponse, ContextPack, ToolDefinition, ToolResult } from "@motebit/sdk";
import { RiskLevel } from "@motebit/sdk";

import { MotebitRuntime, NullRenderer, createInMemoryStorage } from "../index";
import type { StreamChunk } from "../index";
import { InMemoryToolReceiptSink } from "../tool-receipt-sink.js";
import type { ToolReceiptSink } from "../tool-receipt-sink.js";

const tool = (name: string, risk: RiskLevel): ToolDefinition => ({
  name,
  mode: "api",
  description: name,
  inputSchema: { type: "object", properties: {} },
  riskHint: { risk },
});

/** The first `proposals` calls ask for `calls`; every later call answers. */
function provider(calls: string[], proposals = 1): StreamingProvider {
  let n = 0;
  const respond = (): AIResponse =>
    n++ < proposals
      ? {
          text: "",
          confidence: 1,
          memory_candidates: [],
          state_updates: {},
          tool_calls: calls.map((name) => ({ id: `id_${name}`, name, args: { n: name } })),
        }
      : { text: "ok", confidence: 1, memory_candidates: [], state_updates: {} };
  return {
    model: "mock-model",
    setModel: vi.fn(),
    generate: vi.fn(async (_: ContextPack) => respond()),
    estimateConfidence: vi.fn(async () => 1),
    extractMemoryCandidates: vi.fn(async () => []),
    async *generateStream(_: ContextPack) {
      yield { type: "done" as const, response: respond() };
    },
  };
}

async function drain(gen: AsyncGenerator<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = [];
  for await (const c of gen) out.push(c);
  return out;
}

async function makeRuntime(
  calls: string[],
  sink: ToolReceiptSink,
  opts: { keys?: boolean; proposals?: number; approvalTimeoutMs?: number } = {},
) {
  const kp = await generateKeypair();
  const runtime = new MotebitRuntime(
    {
      motebitId: "owner",
      tickRateHz: 0,
      deviceId: "dev-1",
      ...(opts.keys === false ? {} : { signingKeys: kp }),
      toolReceiptSink: sink,
      ...(opts.approvalTimeoutMs != null ? { approvalTimeoutMs: opts.approvalTimeoutMs } : {}),
      policy: {
        operatorMode: true,
        maxRiskLevel: RiskLevel.R3_EXECUTE,
        requireApprovalAbove: RiskLevel.R1_DRAFT,
        denyAbove: RiskLevel.R2_WRITE,
      },
    },
    {
      storage: createInMemoryStorage(),
      renderer: new NullRenderer(),
      ai: provider(calls, opts.proposals),
    },
  );
  const handlers: Record<string, () => Promise<ToolResult>> = {
    good: async () => ({ ok: true, data: "fine" }),
    soft_fail: async () => ({ ok: false, error: "nope" }),
    throws: async () => {
      throw new Error("boom");
    },
    forbidden: async () => ({ ok: true, data: "must not run" }),
    gated: async () => ({ ok: true, data: "ran after approval" }),
    gated2: async () => ({ ok: true, data: "the second gated call ran" }),
    gated_throws: async () => {
      throw new Error("approved, then boom");
    },
  };
  const risks: Record<string, RiskLevel> = {
    good: RiskLevel.R0_READ,
    soft_fail: RiskLevel.R0_READ,
    throws: RiskLevel.R0_READ,
    forbidden: RiskLevel.R3_EXECUTE,
    gated: RiskLevel.R2_WRITE,
    gated2: RiskLevel.R2_WRITE,
    gated_throws: RiskLevel.R2_WRITE,
  };
  const spies: Record<string, ReturnType<typeof vi.fn>> = {};
  for (const [name, h] of Object.entries(handlers)) {
    spies[name] = vi.fn(h);
    runtime.getToolRegistry().register(tool(name, risks[name]!), spies[name] as never);
  }
  return { runtime, kp, spies };
}

const statuses = (sink: InMemoryToolReceiptSink) => sink.list().map((r) => [r.tool_name, r.status]);

describe("tool receipts carry the call's real status (AI loop)", () => {
  it("success completed, ok:false failed, a throw failed, a policy refusal denied — all in the durable sink", async () => {
    const sink = new InMemoryToolReceiptSink();
    const { runtime, kp, spies } = await makeRuntime(
      ["good", "soft_fail", "throws", "forbidden"],
      sink,
    );
    await drain(runtime.sendMessageStreaming("go"));
    expect(statuses(sink)).toEqual([
      ["good", "completed"],
      ["soft_fail", "failed"],
      ["throws", "failed"],
      ["forbidden", "denied"],
    ]);
    expect(spies.forbidden).not.toHaveBeenCalled();
    for (const r of sink.list()) {
      expect(await verifyToolInvocationReceipt(r, kp.publicKey)).toBe(true);
    }
    // The in-session buffer still sees every receipt, after the durable record.
    expect(runtime.getRecentReceipts().map((r) => r.status)).toEqual([
      "completed",
      "failed",
      "failed",
      "denied",
    ]);
  });

  it("a durable sink that rejects stops the turn (fail-closed): no later call runs", async () => {
    const failing: ToolReceiptSink = { append: () => Promise.reject(new Error("disk gone")) };
    const { runtime, spies } = await makeRuntime(["good", "soft_fail"], failing);
    await expect(drain(runtime.sendMessageStreaming("go"))).rejects.toThrow("disk gone");
    expect(spies.good).toHaveBeenCalledTimes(1);
    expect(spies.soft_fail).not.toHaveBeenCalled();
  });

  it("with a durable sink, a receipt that cannot be signed (no key) stops the turn", async () => {
    const sink = new InMemoryToolReceiptSink();
    const { runtime, spies } = await makeRuntime(["good", "soft_fail"], sink, { keys: false });
    await expect(drain(runtime.sendMessageStreaming("go"))).rejects.toThrow(/cannot be signed/);
    expect(spies.soft_fail).not.toHaveBeenCalled();
    expect(sink.list()).toHaveLength(0);
  });
});

describe("tool receipts on the approval resume path", () => {
  it("an approved call that runs gets its completed receipt", async () => {
    const sink = new InMemoryToolReceiptSink();
    const { runtime } = await makeRuntime(["gated"], sink);
    const first = await drain(runtime.sendMessageStreaming("go"));
    expect(first.some((c) => c.type === "approval_request")).toBe(true);
    expect(sink.list()).toHaveLength(0);
    await drain(runtime.resumeAfterApproval(true));
    expect(statuses(sink)).toEqual([["gated", "completed"]]);
    expect(sink.list()[0]!.invocation_id).toBe("id_gated");
  });

  it("an approved call that throws gets a failed receipt", async () => {
    const sink = new InMemoryToolReceiptSink();
    const { runtime } = await makeRuntime(["gated_throws"], sink);
    await drain(runtime.sendMessageStreaming("go"));
    // The registry turns the throw into `ok:false`; the receipt says failed.
    await drain(runtime.resumeAfterApproval(true));
    expect(statuses(sink)).toEqual([["gated_throws", "failed"]]);
  });

  it("a call the human refuses gets a denied receipt", async () => {
    const sink = new InMemoryToolReceiptSink();
    const { runtime, spies } = await makeRuntime(["gated"], sink);
    await drain(runtime.sendMessageStreaming("go"));
    await drain(runtime.resumeAfterApproval(false));
    expect(statuses(sink)).toEqual([["gated", "denied"]]);
    expect(spies.gated).not.toHaveBeenCalled();
  });
});

describe("tool receipts on the approval refusal paths", () => {
  it("a re-proposal of a refused call is suppressed and denied with a receipt", async () => {
    const sink = new InMemoryToolReceiptSink();
    const { runtime, spies } = await makeRuntime(["gated"], sink, { proposals: 2 });
    await drain(runtime.sendMessageStreaming("go"));
    await drain(runtime.resumeAfterApproval(false));
    expect(statuses(sink)).toEqual([
      ["gated", "denied"],
      ["gated", "denied"],
    ]);
    expect(runtime.hasPendingApproval).toBe(false);
    expect(spies.gated).not.toHaveBeenCalled();
  });

  it("an approval that times out is denied with a receipt", async () => {
    const sink = new InMemoryToolReceiptSink();
    const { runtime, spies } = await makeRuntime(["gated"], sink, { approvalTimeoutMs: 10 });
    await drain(runtime.sendMessageStreaming("go"));
    await vi.waitFor(() => expect(statuses(sink)).toEqual([["gated", "denied"]]));
    expect(spies.gated).not.toHaveBeenCalled();
  });
});

describe("every proposed call that is not executed gets a denied receipt", () => {
  it("two calls needing approval in one response: the superseded one is denied, the kept one approved", async () => {
    const sink = new InMemoryToolReceiptSink();
    const { runtime, spies } = await makeRuntime(["gated", "gated2"], sink);
    await drain(runtime.sendMessageStreaming("go"));
    expect(statuses(sink)).toEqual([["gated", "denied"]]);
    await drain(runtime.resumeAfterApproval(true));
    expect(statuses(sink)).toEqual([
      ["gated", "denied"],
      ["gated2", "completed"],
    ]);
    expect(spies.gated).not.toHaveBeenCalled();
    expect(spies.gated2).toHaveBeenCalledTimes(1);
  });

  it("two calls needing approval in one response, then a refusal: both are denied", async () => {
    const sink = new InMemoryToolReceiptSink();
    const { runtime, spies } = await makeRuntime(["gated", "gated2"], sink);
    await drain(runtime.sendMessageStreaming("go"));
    await drain(runtime.resumeAfterApproval(false));
    expect(statuses(sink)).toEqual([
      ["gated", "denied"],
      ["gated2", "denied"],
    ]);
    expect(spies.gated).not.toHaveBeenCalled();
    expect(spies.gated2).not.toHaveBeenCalled();
  });

  it("a pending approval voided by a new message is denied with a receipt, and is not a no", async () => {
    const sink = new InMemoryToolReceiptSink();
    const { runtime, spies } = await makeRuntime(["gated"], sink, { proposals: 2 });
    await drain(runtime.sendMessageStreaming("go"));
    expect(runtime.hasPendingApproval).toBe(true);
    const second = await drain(runtime.sendMessageStreaming("actually, something else"));
    expect(second.some((c) => c.type === "approval_voided")).toBe(true);
    expect(statuses(sink)).toEqual([["gated", "denied"]]);
    // A void is not a refusal: the re-proposal re-prompts the human.
    expect(second.some((c) => c.type === "approval_request")).toBe(true);
    expect(runtime.hasPendingApproval).toBe(true);
    expect(spies.gated).not.toHaveBeenCalled();
  });
});

describe("tool receipts on invokeLocalTool", () => {
  it("a policy refusal is denied with a receipt; an unknown tool too; success completed", async () => {
    const sink = new InMemoryToolReceiptSink();
    const { runtime, spies } = await makeRuntime([], sink);
    await runtime.invokeLocalTool("forbidden", {});
    await runtime.invokeLocalTool("no_such_tool", {});
    await runtime.invokeLocalTool("good", {});
    await runtime.invokeLocalTool("soft_fail", {});
    expect(statuses(sink)).toEqual([
      ["forbidden", "denied"],
      ["no_such_tool", "denied"],
      ["good", "completed"],
      ["soft_fail", "failed"],
    ]);
    expect(spies.forbidden).not.toHaveBeenCalled();
  });

  it("an approval a scheduled invocation cannot grant is denied with a receipt", async () => {
    const sink = new InMemoryToolReceiptSink();
    const { runtime, spies } = await makeRuntime([], sink);
    await runtime.invokeLocalTool("gated", {}, { invocationOrigin: "scheduled" });
    expect(statuses(sink)).toEqual([["gated", "denied"]]);
    expect(spies.gated).not.toHaveBeenCalled();
  });

  it("a durable sink that rejects makes invokeLocalTool throw", async () => {
    const failing: ToolReceiptSink = { append: () => Promise.reject(new Error("disk gone")) };
    const { runtime } = await makeRuntime([], failing);
    await expect(runtime.invokeLocalTool("good", {})).rejects.toThrow("disk gone");
  });
});
