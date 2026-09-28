/**
 * #943 — a task's signed receipt embeds only the delegation receipts its OWN
 * turn produced.
 *
 * Before this fix every hire stashed into one shared bucket that only
 * `handleAgentTask` drained. The owner's hires — a `delegate_to_agent` call
 * in an owner turn, an `invokeCapability` tap, an owner MCP tool call to
 * another motebit — were signed into the NEXT customer's `motebit_task`
 * receipt as `delegation_receipts`, each carrying the verbatim `result` of
 * the owner's private request, and sent to the submitter and the relay.
 *
 * Now receipts are collected per turn (`TurnDelegationReceipts`, opened and
 * closed by the runtime's single-writer hold); a task's turn hands its own
 * receipts to the handler through its sink, and nothing else reaches it.
 *
 * Real runtime and loop; a fake motebit MCP adapter stands in for a
 * worker-backed MCP tool (its receipt bucket is what `mcp-client` fills).
 *
 * Tampers (each goes red): make `TurnDelegationReceipts.close` also return
 * the owner's record (the shared bucket); make `open` stop flushing the MCP
 * adapters' pre-turn receipts; make `recordOwnerAct` record into the
 * in-flight turn.
 */
import { describe, it, expect, vi } from "vitest";
import { MotebitRuntime, NullRenderer, createInMemoryStorage } from "../index";
import type { StreamChunk } from "../index";
import type { StreamingProvider } from "@motebit/ai-core";
import type {
  AIResponse,
  AgentTask,
  ContextPack,
  ExecutionReceipt,
  ToolDefinition,
} from "@motebit/sdk";
import { AgentTaskStatus, RiskLevel } from "@motebit/sdk";
import { generateKeypair } from "@motebit/encryption";

const OWNER = "owner-mote";
const OWNER_SECRET = "OWNERSECRET943-hire-result";

function workerReceipt(taskId: string, result: string): ExecutionReceipt {
  return {
    task_id: taskId,
    motebit_id: "worker-1",
    device_id: "worker-dev",
    submitted_at: Date.now() - 1000,
    completed_at: Date.now(),
    status: "completed",
    result,
    tools_used: [],
    memories_formed: 0,
    prompt_hash: "a".repeat(64),
    result_hash: "b".repeat(64),
    suite: "motebit-jcs-ed25519-b64-v1",
    signature: `sig-${taskId}`,
  } as ExecutionReceipt;
}

/** Calls `tool` once per turn (when its history has no result yet), then answers. */
function toolCallingProvider(tool: string): StreamingProvider {
  const gen = (ctx: ContextPack): AIResponse => {
    const history = JSON.stringify(ctx.conversation_history ?? []);
    if (!history.includes(tool)) {
      return {
        text: "",
        confidence: 0.8,
        memory_candidates: [],
        state_updates: {},
        tool_calls: [{ id: `c-${tool}`, name: tool, args: {} }],
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
      const r = gen(ctx);
      if (r.text) yield { type: "text" as const, text: r.text };
      yield { type: "done" as const, response: r };
    },
  };
}

const tool = (name: string): ToolDefinition => ({
  name,
  mode: "api",
  description: name,
  inputSchema: { type: "object", properties: {} },
  riskHint: { risk: RiskLevel.R0_READ },
});

type Internals = {
  mcpAdapters: Array<{ getAndResetDelegationReceipts(): ExecutionReceipt[] }>;
  interactiveDelegation: {
    recordTurnReceipt(r: ExecutionReceipt): void;
    pushReceipt(r: ExecutionReceipt): void;
  };
};

/** A fake motebit MCP adapter: its bucket is filled by the served tool's call. */
function fakeMcpAdapter() {
  let bucket: ExecutionReceipt[] = [];
  return {
    push: (r: ExecutionReceipt) => bucket.push(r),
    adapter: {
      disconnect: async () => {},
      isMotebit: true,
      getAndResetDelegationReceipts: () => {
        const out = bucket;
        bucket = [];
        return out;
      },
    },
  };
}

function setup(providerTool: string) {
  const runtime = new MotebitRuntime(
    { motebitId: OWNER, tickRateHz: 0 },
    {
      storage: createInMemoryStorage(),
      renderer: new NullRenderer(),
      ai: toolCallingProvider(providerTool),
    },
  );
  const mcp = fakeMcpAdapter();
  (runtime as unknown as Internals).mcpAdapters = [mcp.adapter as never];
  return { runtime, mcp, internals: runtime as unknown as Internals };
}

async function runTask(runtime: MotebitRuntime, prompt: string): Promise<ExecutionReceipt> {
  const kp = await generateKeypair();
  const task: AgentTask = {
    task_id: "customer-task",
    motebit_id: OWNER,
    prompt,
    submitted_at: Date.now(),
    status: AgentTaskStatus.Claimed,
    wall_clock_ms: 30_000,
  };
  let receipt: ExecutionReceipt | null = null;
  for await (const c of runtime.handleAgentTask(task, kp.privateKey, "dev-1") as AsyncGenerator<
    StreamChunk & { receipt?: ExecutionReceipt }
  >) {
    if (c.type === "task_result") receipt = c.receipt ?? null;
  }
  if (receipt == null) throw new Error("no task receipt");
  return receipt;
}

async function drain(gen: AsyncGenerator<StreamChunk>): Promise<void> {
  for await (const _c of gen) {
    /* consume */
  }
}

describe("#943 — a task's receipt embeds only its own turn's hires", () => {
  it("an owner turn's hire (AI-loop delegate) is never signed into the next customer's task receipt", async () => {
    const { runtime, internals } = setup("owner_hire");
    // The owner's turn hires; the loop's delegate path records into THAT turn.
    // (Only the first call hires — the task's turn calls the tool too.)
    let hires = 0;
    runtime.getToolRegistry().register(tool("owner_hire"), async () => {
      if (hires++ === 0) {
        internals.interactiveDelegation.recordTurnReceipt(
          workerReceipt("owner-hire-1", OWNER_SECRET),
        );
      }
      return { ok: true, data: "hired" };
    });
    await drain(runtime.sendMessageStreaming("hire someone for me"));

    const receipt = await runTask(runtime, "customer prompt");
    expect(receipt.delegation_receipts ?? []).toEqual([]);
    expect(JSON.stringify(receipt)).not.toContain(OWNER_SECRET);
    // The owner turn's hire went to the owner's record.
    expect(runtime.getAndResetInteractiveDelegationReceipts().map((r) => r.task_id)).toEqual([
      "owner-hire-1",
    ]);
  });

  it("an owner MCP call's receipt left in the adapter is never signed into the task receipt", async () => {
    const { runtime, mcp } = setup("noop");
    runtime.getToolRegistry().register(tool("noop"), async () => ({ ok: true, data: "ok" }));
    // The owner's MCP call to another motebit completed before the task.
    mcp.push(workerReceipt("owner-mcp-1", OWNER_SECRET));

    const receipt = await runTask(runtime, "customer prompt");
    expect(receipt.delegation_receipts ?? []).toEqual([]);
    expect(JSON.stringify(receipt)).not.toContain(OWNER_SECRET);
    // It went to the owner's record.
    expect(runtime.getAndResetInteractiveDelegationReceipts().map((r) => r.task_id)).toEqual([
      "owner-mcp-1",
    ]);
  });

  it("an owner tap made WHILE a customer's task is running is never signed into it", async () => {
    const { runtime, internals } = setup("slow_tool");
    runtime.getToolRegistry().register(tool("slow_tool"), async () => {
      // The owner taps a capability mid-task (invokeCapability's stash).
      internals.interactiveDelegation.pushReceipt(workerReceipt("owner-tap-1", OWNER_SECRET));
      return { ok: true, data: "ok" };
    });
    const receipt = await runTask(runtime, "customer prompt");
    expect(receipt.delegation_receipts ?? []).toEqual([]);
    expect(JSON.stringify(receipt)).not.toContain(OWNER_SECRET);
  });

  it("the task's OWN sub-hire (a served motebit MCP tool called in its turn) still appears — correct provenance", async () => {
    const { runtime, mcp } = setup("sub_hire");
    runtime.getToolRegistry().register(tool("sub_hire"), async () => {
      mcp.push(workerReceipt("task-sub-hire-1", "the customer's sub-result"));
      return { ok: true, data: "sub-hired" };
    });
    // An owner receipt already in the adapter must not ride along.
    mcp.push(workerReceipt("owner-mcp-2", OWNER_SECRET));

    const receipt = await runTask(runtime, "customer prompt");
    expect((receipt.delegation_receipts ?? []).map((r) => r.task_id)).toEqual(["task-sub-hire-1"]);
    expect(JSON.stringify(receipt)).not.toContain(OWNER_SECRET);
  });
});
