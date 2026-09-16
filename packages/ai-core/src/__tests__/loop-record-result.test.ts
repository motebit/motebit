/**
 * The loop closes the gate's audit row after execution — the completion
 * half of the durable execution ledger. `validate` opened the row (intent)
 * BEFORE the call; `recordResult` must fire the moment `tools.execute`
 * returns or throws, with the tool's own verdict, so a crash-window row
 * (intent with no completion) means exactly "prepared; effect unknown" — it
 * cannot establish that dispatch occurred.
 */
import { describe, it, expect, vi } from "vitest";
import { runTurnStreaming } from "../loop";
import type { MotebitLoopDependencies } from "../loop";
import type { SensitivityCleared } from "@motebit/sdk";
import type { StreamingProvider } from "../index";
import { EventStore, InMemoryEventStore } from "@motebit/event-log";
import { MemoryGraph, InMemoryMemoryStorage } from "@motebit/memory-graph";
import { StateVectorEngine } from "@motebit/state-vector";
import { BehaviorEngine } from "@motebit/behavior-engine";
import type {
  AIResponse,
  ContextPack,
  ToolDefinition,
  ToolResult,
  ToolRegistry,
  PolicyDecision,
} from "@motebit/sdk";

const MOTEBIT_ID = "motebit-ledger-test";

function makeMockProvider(responses: AIResponse[]): StreamingProvider {
  let i = 0;
  return {
    model: "test-model",
    setModel: vi.fn(),
    async generate(_c: ContextPack): Promise<AIResponse> {
      const r = responses[i] ?? responses[responses.length - 1]!;
      i++;
      return r;
    },
    async *generateStream(_c: ContextPack) {
      const r = responses[i] ?? responses[responses.length - 1]!;
      i++;
      if (r.text) yield { type: "text" as const, text: r.text };
      yield { type: "done" as const, response: r };
    },
    estimateConfidence: () => Promise.resolve(0.8),
    extractMemoryCandidates: (r: AIResponse) => Promise.resolve(r.memory_candidates),
  };
}

function registry(execute: (name: string) => Promise<ToolResult>): ToolRegistry {
  const def: ToolDefinition = {
    name: "write_thing",
    description: "write",
    inputSchema: { type: "object", properties: {} },
  };
  return {
    list: () => [def],
    execute: (name: string) => execute(name),
    register(): void {},
  };
}

function deps(provider: StreamingProvider, tools: ToolRegistry, gate: unknown) {
  const eventStore = new EventStore(new InMemoryEventStore());
  const memoryGraph = new MemoryGraph(new InMemoryMemoryStorage(), eventStore, MOTEBIT_ID);
  return {
    motebitId: MOTEBIT_ID,
    eventStore,
    memoryGraph,
    stateEngine: new StateVectorEngine(),
    behaviorEngine: new BehaviorEngine(),
    provider,
    tools,
    policyGate: gate,
  } as unknown as SensitivityCleared<MotebitLoopDependencies>;
}

const turnWithTool: AIResponse = {
  text: "Writing.",
  confidence: 0.8,
  memory_candidates: [],
  state_updates: {},
  tool_calls: [{ id: "tc_1", name: "write_thing", args: { path: "/tmp/x" } }],
};
const finalTurn: AIResponse = {
  text: "Done.",
  confidence: 0.8,
  memory_candidates: [],
  state_updates: {},
};

function gateSpy(decision: PolicyDecision) {
  const recordResult = vi.fn();
  const order: string[] = [];
  const gate = {
    filterTools: (t: ToolDefinition[]) => t,
    createTurnContext: () => ({
      turnId: "turn-1",
      runId: "run-9",
      toolCallCount: 0,
      turnStartMs: 0,
      costAccumulated: 0,
    }),
    validate: () => {
      order.push("validate");
      return decision;
    },
    classify: () => ({
      risk: 2,
      dataClass: "private",
      sideEffect: "reversible",
      requiresApproval: false,
    }),
    recordToolCall: (ctx: unknown) => ctx,
    sanitizeResult: (r: ToolResult) => r,
    recordResult: (...args: unknown[]) => {
      order.push("recordResult");
      recordResult(...args);
    },
  };
  return { gate, recordResult, order };
}

async function drain(gen: AsyncGenerator<unknown>) {
  for await (const _c of gen) {
    // drain
  }
}

describe("runTurnStreaming — completion row after execution", () => {
  it("records the tool's verdict against the decision's callId, strictly after execute", async () => {
    const decision: PolicyDecision = { allowed: true, requiresApproval: false, callId: "call-A" };
    const { gate, recordResult, order } = gateSpy(decision);
    const tools = registry(async () => {
      order.push("execute");
      return { ok: true, data: "written" };
    });
    await drain(
      runTurnStreaming(deps(makeMockProvider([turnWithTool, finalTurn]), tools, gate), "go"),
    );

    expect(order).toEqual(["validate", "execute", "recordResult"]);
    expect(recordResult).toHaveBeenCalledTimes(1);
    const [ctx, d, tool, args, ok, durationMs] = recordResult.mock.calls[0]!;
    expect((ctx as { turnId: string; runId: string }).runId).toBe("run-9");
    expect((d as PolicyDecision).callId).toBe("call-A");
    expect(tool).toBe("write_thing");
    expect(args).toEqual({ path: "/tmp/x" });
    expect(ok).toBe(true);
    expect(typeof durationMs).toBe("number");
  });

  it("a handler that returns ok:false is recorded as a failed completion, not left open", async () => {
    const { gate, recordResult } = gateSpy({ allowed: true, requiresApproval: false, callId: "c" });
    const tools = registry(async () => ({ ok: false, error: "disk full" }));
    await drain(
      runTurnStreaming(deps(makeMockProvider([turnWithTool, finalTurn]), tools, gate), "go"),
    );
    expect(recordResult).toHaveBeenCalledTimes(1);
    expect(recordResult.mock.calls[0]![4]).toBe(false);
  });

  it("a handler that THROWS still closes the row (ok:false)", async () => {
    const { gate, recordResult } = gateSpy({ allowed: true, requiresApproval: false, callId: "c" });
    const tools = registry(async () => {
      throw new Error("boom");
    });
    await drain(
      runTurnStreaming(deps(makeMockProvider([turnWithTool, finalTurn]), tools, gate), "go"),
    );
    expect(recordResult).toHaveBeenCalledTimes(1);
    expect(recordResult.mock.calls[0]![4]).toBe(false);
  });

  it("a denied call never executes and never records a completion", async () => {
    const { gate, recordResult } = gateSpy({
      allowed: false,
      requiresApproval: false,
      reason: "no",
      callId: "c",
    });
    const execute = vi.fn(async () => ({ ok: true }) as ToolResult);
    await drain(
      runTurnStreaming(
        deps(makeMockProvider([turnWithTool, finalTurn]), registry(execute), gate),
        "go",
      ),
    );
    expect(execute).not.toHaveBeenCalled();
    expect(recordResult).not.toHaveBeenCalled();
  });

  it("an approval pause carries the audit callId and turn id on the chunk, and records nothing yet", async () => {
    const { gate, recordResult } = gateSpy({
      allowed: true,
      requiresApproval: true,
      callId: "call-P",
    });
    const execute = vi.fn(async () => ({ ok: true }) as ToolResult);
    const chunks: unknown[] = [];
    for await (const c of runTurnStreaming(
      deps(makeMockProvider([turnWithTool, finalTurn]), registry(execute), gate),
      "go",
    )) {
      chunks.push(c);
    }
    const approval = chunks.find((c) => (c as { type: string }).type === "approval_request") as
      { audit_call_id?: string; turn_id?: string } | undefined;
    expect(approval).toBeDefined();
    expect(approval!.audit_call_id).toBe("call-P");
    expect(approval!.turn_id).toBe("turn-1");
    expect(execute).not.toHaveBeenCalled();
    expect(recordResult).not.toHaveBeenCalled();
  });
});
