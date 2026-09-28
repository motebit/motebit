/**
 * #943 — a task's signed receipt embeds only the delegation receipts its OWN
 * turn produced, attributed at CAPTURE.
 *
 * A worker's signed `ExecutionReceipt` carries the verbatim `result` of what
 * was asked; a `motebit_task` receipt embeds its turn's hires as
 * `delegation_receipts` and goes to the submitter and the relay. Shared
 * buckets (drained by the next task, and later drained at turn close) let
 * the owner's hires ride into a customer's receipt — including an owner call
 * made CONCURRENTLY, out of turn, while a task held the turn.
 *
 * Now a hire's receipt rides ON the tool result and the tool registry
 * records it for the destination the caller threaded into that call: the
 * task's turn key (its loop deps) or the owner (every other door). Owner
 * receipts get their trust credit at owner-record intake.
 *
 * Real runtime and loop. `worker__motebit_task` stands in for a motebit MCP
 * tool (what `@motebit/mcp-client` returns: the result with
 * `delegation_receipt`).
 *
 * Tamper (each goes red): restore a shared drain (record every carried
 * receipt into the open turn regardless of the caller's destination); stop
 * threading the turn key in `loopDepsForTurn`; drop the owner intake.
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
import { AgentTaskStatus, RiskLevel, asMotebitId } from "@motebit/sdk";
import { generateKeypair, signExecutionReceipt } from "@motebit/encryption";

const OWNER = "owner-mote";
const OWNER_SECRET = "OWNERSECRET943-hire-result";

function workerReceipt(taskId: string, result: string, worker = "worker-1"): ExecutionReceipt {
  return {
    task_id: taskId,
    motebit_id: worker,
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

/**
 * A turn whose user message names a tool (`CALL:<tool>`) calls it once, then
 * answers; any other turn just answers.
 */
function scriptedProvider(): StreamingProvider {
  const gen = (ctx: ContextPack): AIResponse => {
    const history = JSON.stringify(ctx.conversation_history ?? []);
    const firstUser =
      (ctx.conversation_history ?? []).find((m) => m.role === "user")?.content ?? ctx.user_message;
    const want = /CALL:(\w+)/.exec(String(firstUser))?.[1];
    if (want != null && !history.includes(want)) {
      return {
        text: "",
        confidence: 0.8,
        memory_candidates: [],
        state_updates: {},
        tool_calls: [{ id: `c-${want}`, name: want, args: {} }],
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

function setup() {
  const storage = createInMemoryStorage();
  const runtime = new MotebitRuntime(
    { motebitId: OWNER, tickRateHz: 0 },
    { storage, renderer: new NullRenderer(), ai: scriptedProvider() },
  );
  // The motebit MCP tool: each call returns the NEXT queued receipt on its result.
  const queued: ExecutionReceipt[] = [];
  runtime.getToolRegistry().register(tool("worker__motebit_task"), async () => {
    const receipt = queued.shift();
    return { ok: true, data: "worker done", ...(receipt ? { delegation_receipt: receipt } : {}) };
  });
  // A tool the task's turn blocks in, until released.
  let release: () => void = () => {};
  const blocked = new Promise<void>((r) => {
    release = r;
  });
  let entered: () => void = () => {};
  const inTool = new Promise<void>((r) => {
    entered = r;
  });
  runtime.getToolRegistry().register(tool("slow_tool"), async () => {
    entered();
    await blocked;
    return { ok: true, data: "slow done" };
  });
  return { runtime, storage, queued, release, inTool };
}

function startTask(runtime: MotebitRuntime, prompt: string): Promise<ExecutionReceipt> {
  return (async () => {
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
  })();
}

async function drain(gen: AsyncGenerator<StreamChunk>): Promise<void> {
  for await (const _c of gen) {
    /* consume */
  }
}

const settle = () => new Promise((r) => setTimeout(r, 20));

describe("#943 — a task's receipt embeds only its own turn's hires", () => {
  it("an owner's CONCURRENT out-of-turn invokeLocalTool hire, made while a task holds the turn, is never signed into the task's receipt", async () => {
    const { runtime, queued, release, inTool } = setup();
    const task = startTask(runtime, "CALL:slow_tool");
    await inTool; // the task's turn is blocked inside slow_tool
    queued.push(workerReceipt("owner-tap-1", OWNER_SECRET));
    const r = await runtime.invokeLocalTool("worker__motebit_task", {});
    expect(r.ok).toBe(true);
    release();
    const receipt = await task;
    expect(receipt.delegation_receipts ?? []).toEqual([]);
    expect(JSON.stringify(receipt)).not.toContain(OWNER_SECRET);
    expect(runtime.getAndResetInteractiveDelegationReceipts().map((x) => x.task_id)).toEqual([
      "owner-tap-1",
    ]);
  });

  it("an owner PlanEngine step's hire (the owner loop deps), made while a task holds the turn, is never signed into it", async () => {
    const { runtime, queued, release, inTool } = setup();
    const task = startTask(runtime, "CALL:slow_tool");
    await inTool;
    queued.push(workerReceipt("owner-plan-1", OWNER_SECRET));
    // A plan step executes through `getLoopDeps()` — the owner's loop deps.
    const planDeps = runtime.getLoopDeps();
    await planDeps!.tools!.execute("worker__motebit_task", {});
    release();
    const receipt = await task;
    expect(receipt.delegation_receipts ?? []).toEqual([]);
    expect(JSON.stringify(receipt)).not.toContain(OWNER_SECRET);
  });

  it("an owner turn's hire is never signed into the next customer's task receipt", async () => {
    const { runtime, queued } = setup();
    queued.push(workerReceipt("owner-turn-1", OWNER_SECRET));
    await drain(runtime.sendMessageStreaming("CALL:worker__motebit_task"));
    const receipt = await startTask(runtime, "customer prompt");
    expect(receipt.delegation_receipts ?? []).toEqual([]);
    expect(JSON.stringify(receipt)).not.toContain(OWNER_SECRET);
    expect(runtime.getAndResetInteractiveDelegationReceipts().map((x) => x.task_id)).toEqual([
      "owner-turn-1",
    ]);
  });

  it("an owner tap (invokeCapability's stash) made mid-task is never signed into it", async () => {
    const { runtime, release, inTool } = setup();
    const task = startTask(runtime, "CALL:slow_tool");
    await inTool;
    (
      runtime as unknown as { interactiveDelegation: { pushReceipt(r: ExecutionReceipt): void } }
    ).interactiveDelegation.pushReceipt(workerReceipt("owner-cap-1", OWNER_SECRET));
    release();
    const receipt = await task;
    expect(JSON.stringify(receipt)).not.toContain(OWNER_SECRET);
  });

  it("the task's OWN sub-hire (a motebit MCP tool its turn called) still appears — correct provenance", async () => {
    const { runtime, queued } = setup();
    queued.push(workerReceipt("task-sub-hire-1", "the customer's sub-result"));
    const receipt = await startTask(runtime, "CALL:worker__motebit_task");
    expect((receipt.delegation_receipts ?? []).map((d) => d.task_id)).toEqual(["task-sub-hire-1"]);
  });

  it("an owner hire still earns its trust credit — attributed to the owner, at owner-record intake", async () => {
    const { runtime, storage, queued } = setup();
    // A receipt that VERIFIES under its embedded key (round 5: owner intake
    // credits only a verifiable signature).
    const kp = await generateKeypair();
    const {
      signature: _unsigned,
      public_key: _pk,
      ...body
    } = workerReceipt("owner-tap-2", "fine", "worker-credit");
    queued.push(await signExecutionReceipt(body, kp.privateKey, kp.publicKey));
    await runtime.invokeLocalTool("worker__motebit_task", {});
    await settle();
    const rec = await storage.agentTrustStore!.getAgentTrust(
      asMotebitId(OWNER),
      asMotebitId("worker-credit"),
    );
    expect(rec).not.toBeNull();
    expect(rec?.interaction_count ?? 0).toBeGreaterThan(0);
  });

  it("owner intake credits nothing for a shape-checked receipt that does not verify", async () => {
    const { runtime, storage, queued } = setup();
    queued.push(workerReceipt("owner-tap-3", "fine", "worker-unsigned"));
    await runtime.invokeLocalTool("worker__motebit_task", {});
    await settle();
    const rec = await storage.agentTrustStore!.getAgentTrust(
      asMotebitId(OWNER),
      asMotebitId("worker-unsigned"),
    );
    expect(rec).toBeNull();
  });

  it("a hire already credited where it was made is credited ONCE in a task turn (the flag survives the sink)", async () => {
    const { runtime } = setup();
    const bump = vi.spyOn(
      runtime as unknown as {
        bumpTrustFromReceipt: (r: ExecutionReceipt, v: boolean) => Promise<void>;
      },
      "bumpTrustFromReceipt",
    );
    // Like `delegate_to_agent`: credit at creation, then return the receipt
    // carried with `delegation_receipt_trust_credited: true`.
    runtime.getToolRegistry().register(tool("credited_hire"), async () => {
      const r = workerReceipt("task-credited-1", "sub-result", "worker-once");
      await (
        runtime as unknown as {
          bumpTrustFromReceipt: (r: ExecutionReceipt, v: boolean) => Promise<void>;
        }
      ).bumpTrustFromReceipt(r, true);
      return {
        ok: true,
        data: "hired",
        delegation_receipt: r,
        delegation_receipt_trust_credited: true,
      };
    });
    const receipt = await startTask(runtime, "CALL:credited_hire");
    expect((receipt.delegation_receipts ?? []).map((d) => d.task_id)).toEqual(["task-credited-1"]);
    const forWorker = bump.mock.calls.filter(([r]) => r.motebit_id === "worker-once");
    expect(forWorker).toHaveLength(1);
  });
});
