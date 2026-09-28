/**
 * #880 — a foreign task's approval never outlives the task.
 *
 * A customer's `motebit_task` that proposed an approval-required tool used
 * to PAUSE: the task returned, the pending approval survived, and when the
 * owner later approved, the customer's prompt resumed inside the OWNER's
 * conversation (with the owner's history, and web tools that could carry
 * it out). Ruling: in a foreign turn, a call that would need approval is
 * DENIED immediately, with a typed reason. No pending approval is created,
 * the task ends normally, and its receipt reflects the refusal. That is how
 * an MCP caller is already treated (no approval channel).
 *
 * The resume-side foreign guard stays as defense in depth; the last test
 * drives it directly, since no new foreign approval can reach it.
 */
import { describe, it, expect, vi } from "vitest";
import { MotebitRuntime, NullRenderer, createInMemoryStorage } from "../index";
import type { StreamChunk } from "../index";
import type { StreamingProvider } from "@motebit/ai-core";
import type { AIResponse, ContextPack, ToolDefinition, AgentTask } from "@motebit/sdk";
import { AgentTaskStatus, RiskLevel } from "@motebit/sdk";
import { generateKeypair } from "@motebit/encryption";

const READ_FILE: ToolDefinition = {
  name: "read_file",
  mode: "api",
  description: "Read a local file",
  inputSchema: { type: "object", properties: { path: { type: "string" } } },
  riskHint: { risk: RiskLevel.R0_READ },
  localOnly: true,
};
const EXT_WRITE: ToolDefinition = {
  name: "ext_write",
  mode: "api",
  description: "Store a record in the external store",
  inputSchema: { type: "object", properties: { v: { type: "string" } } },
  riskHint: { risk: RiskLevel.R2_WRITE },
};

/**
 * Until a tool result is in the history, asks for `ext_write`; after, it
 * answers. Records the tool names every generation was offered.
 */
function scriptedProvider(offered: string[][]): StreamingProvider {
  const gen = (ctx: ContextPack): AIResponse => {
    offered.push((ctx.tools ?? []).map((t) => t.name));
    const history = JSON.stringify(ctx.conversation_history ?? []);
    const seenResult = history.includes("tool_result") || history.includes('"role":"tool"');
    if (!seenResult) {
      return {
        text: "",
        confidence: 0.8,
        memory_candidates: [],
        state_updates: {},
        tool_calls: [{ id: "c1", name: "ext_write", args: { v: "x" } }],
      };
    }
    return { text: "done", confidence: 0.8, memory_candidates: [], state_updates: {} };
  };
  return {
    model: "mock-model",
    setModel: vi.fn(),
    generate: vi.fn(async (ctx: ContextPack) => gen(ctx)),
    estimateConfidence: vi.fn(async () => 0.8),
    extractMemoryCandidates: vi.fn(async () => []),
    async *generateStream(ctx: ContextPack) {
      const response = gen(ctx);
      if (response.text) yield { type: "text" as const, text: response.text };
      yield { type: "done" as const, response };
    },
  };
}

async function drain(gen: AsyncGenerator<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = [];
  for await (const c of gen) out.push(c);
  return out;
}

function balancedRuntime(offered: string[][]) {
  const runtime = new MotebitRuntime(
    {
      motebitId: "owner",
      tickRateHz: 0,
      policy: {
        operatorMode: true,
        maxRiskLevel: RiskLevel.R3_EXECUTE,
        requireApprovalAbove: RiskLevel.R1_DRAFT, // balanced
        denyAbove: RiskLevel.R3_EXECUTE,
      },
    },
    {
      storage: createInMemoryStorage(),
      renderer: new NullRenderer(),
      ai: scriptedProvider(offered),
    },
  );
  const readFile = vi.fn(async () => ({ ok: true, data: "SECRET" }));
  const extWrite = vi.fn(async () => ({ ok: true, data: "stored" }));
  runtime.getToolRegistry().register(READ_FILE, readFile);
  runtime.getToolRegistry().register(EXT_WRITE, extWrite);
  return { runtime, readFile, extWrite };
}

function customerTask(): AgentTask {
  return {
    task_id: "task-880-approval",
    motebit_id: "owner",
    prompt: "store x",
    submitted_at: Date.now(),
    status: AgentTaskStatus.Claimed,
    wall_clock_ms: 30_000,
  };
}

describe("a foreign task never pauses for the owner's approval (#880)", () => {
  it("an approval-required call is refused at once; no approval is pending; the receipt says denied", async () => {
    const offered: string[][] = [];
    const { runtime, extWrite } = balancedRuntime(offered);
    const kp = await generateKeypair();

    const chunks = await drain(runtime.handleAgentTask(customerTask(), kp.privateKey, "dev"));

    expect(chunks.some((c) => c.type === "approval_request")).toBe(false);
    expect(runtime.hasPendingApproval).toBe(false);
    expect(extWrite).not.toHaveBeenCalled();
    const refusal = chunks.find(
      (c) => c.type === "tool_status" && c.name === "ext_write" && c.status === "done",
    ) as { result?: unknown } | undefined;
    expect(String(refusal?.result)).toContain(
      "requires the owner's approval — not available to another principal's task",
    );
    const result = chunks.find((c) => c.type === "task_result") as
      { receipt: { status: string } } | undefined;
    expect(result?.receipt.status).toBe("denied");

    // Nothing can resume: a late "approve" runs no continuation.
    const generationsBefore = offered.length;
    const late = await drain(runtime.resumeAfterApproval(true));
    expect(late.map((c) => c.type)).toEqual(["approval_expired"]);
    expect(offered.length).toBe(generationsBefore);
    expect(extWrite).not.toHaveBeenCalled();
  });

  it("the owner's own turn is unaffected: the same call pauses for approval, with every tool", async () => {
    const offered: string[][] = [];
    const { runtime, extWrite } = balancedRuntime(offered);
    const kp = await generateKeypair();
    await drain(runtime.handleAgentTask(customerTask(), kp.privateKey, "dev"));

    offered.length = 0;
    const own = await drain(runtime.sendMessageStreaming("store x"));
    expect(own.some((c) => c.type === "approval_request")).toBe(true);
    expect(runtime.hasPendingApproval).toBe(true);
    expect(offered[0]).toContain("read_file");
    await drain(runtime.resumeAfterApproval(true));
    expect(extWrite).toHaveBeenCalledTimes(1);
  });

  it("defense in depth: a foreign pending approval, if one existed, resumes foreign", async () => {
    const offered: string[][] = [];
    const { runtime, readFile, extWrite } = balancedRuntime(offered);
    // No code path creates one any more — plant it directly.
    (
      runtime as unknown as {
        streaming: { _pendingApproval: Record<string, unknown> };
      }
    ).streaming._pendingApproval = {
      toolCallId: "c1",
      toolName: "ext_write",
      args: { v: "x" },
      userMessage: "store x",
      requestedAt: Date.now(),
      foreignPrincipal: true,
    };
    await drain(runtime.resumeAfterApproval(true));
    expect(extWrite).toHaveBeenCalledTimes(1);
    expect(offered.length).toBeGreaterThan(0);
    for (const names of offered) expect(names).not.toContain("read_file");
    expect(readFile).not.toHaveBeenCalled();
  });
});
