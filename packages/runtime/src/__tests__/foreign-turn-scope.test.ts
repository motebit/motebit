/**
 * #880 round 2 — the foreign scope belongs to the foreign TURN, never to
 * the runtime.
 *
 * The reviewer's race probe, as regressions. A foreign task's turn ends,
 * `_isProcessing` is released, and the task's tail (receipt drain, trust
 * bump, signing, event append) keeps running. A runtime-wide "foreign
 * tasks in flight" counter stayed up through that tail, so an OWNER turn
 * admitted in it was treated as foreign:
 *   - its approval was refused (no-approval-channel view), and it lost its
 *     `localOnly` tools;
 *   - an owner approval paused in that window was stamped foreign, so the
 *     continuation lost its tools and an approved `localOnly` call was
 *     discarded.
 * Every foreign-turn decision now keys on the turn's own flag.
 *
 * The event store's `agent_task*` append is held open to pin the tail.
 */
import { describe, it, expect, vi } from "vitest";
import { MotebitRuntime, NullRenderer, createInMemoryStorage } from "../index";
import type { StreamChunk } from "../index";
import type { AIResponse, ContextPack, ToolDefinition, AgentTask } from "@motebit/sdk";
import { AgentTaskStatus, RiskLevel } from "@motebit/sdk";
import { generateKeypair } from "@motebit/encryption";

const READ_FILE: ToolDefinition = {
  name: "read_file",
  mode: "api",
  description: "Read a local file",
  inputSchema: { type: "object", properties: {} },
  riskHint: { risk: RiskLevel.R0_READ },
  localOnly: true,
};
const LOCAL_WRITE: ToolDefinition = {
  name: "local_write",
  mode: "api",
  description: "Write a local record",
  inputSchema: { type: "object", properties: {} },
  riskHint: { risk: RiskLevel.R2_WRITE },
  localOnly: true,
};
const EXT_WRITE: ToolDefinition = {
  name: "ext_write",
  mode: "api",
  description: "Store a record in the external store",
  inputSchema: { type: "object", properties: {} },
  riskHint: { risk: RiskLevel.R2_WRITE },
};

function deferred(): { p: Promise<void>; r: () => void } {
  let r!: () => void;
  const p = new Promise<void>((res) => (r = res));
  return { p, r };
}

/**
 * A prompt containing "TASK" answers at once. Any other prompt asks for
 * `ownerTool` until a tool result is in the history, then answers. Every
 * generation's offered tools are recorded.
 */
function make(ownerTool: string, ownerGate?: { p: Promise<void> }, chainTool?: string) {
  const offered: string[][] = [];
  let chained = false;
  const gen = async (ctx: ContextPack): Promise<AIResponse> => {
    const history = JSON.stringify(ctx.conversation_history ?? []);
    offered.push((ctx.tools ?? []).map((t) => t.name));
    if (ctx.user_message.startsWith("THROW")) throw new Error("provider down");
    // A fresh OWNER prompt proposes `ownerTool` whatever earlier turns left
    // in the history (it answers once its own call's result is the latest).
    if (ctx.user_message.startsWith("OWNER")) {
      const last = JSON.stringify((ctx.conversation_history ?? []).at(-1) ?? {});
      if (!last.includes("tool_result") && !last.includes('"role":"tool"')) {
        return {
          text: "",
          confidence: 0.8,
          memory_candidates: [],
          state_updates: {},
          tool_calls: [{ id: "o1", name: ownerTool, args: {} }],
        };
      }
      return { text: "done", confidence: 0.8, memory_candidates: [], state_updates: {} };
    }
    if (history.includes("tool_result") || history.includes('"role":"tool"')) {
      // Optionally propose ONE more call after the first result.
      if (chainTool != null && !chained) {
        chained = true;
        return {
          text: "",
          confidence: 0.8,
          memory_candidates: [],
          state_updates: {},
          tool_calls: [{ id: "c2", name: chainTool, args: {} }],
        };
      }
      return { text: "done", confidence: 0.8, memory_candidates: [], state_updates: {} };
    }
    if (ctx.user_message.includes("TASK")) {
      return { text: "ok", confidence: 0.8, memory_candidates: [], state_updates: {} };
    }
    if (ownerGate) await ownerGate.p;
    return {
      text: "",
      confidence: 0.8,
      memory_candidates: [],
      state_updates: {},
      tool_calls: [{ id: "c1", name: ownerTool, args: {} }],
    };
  };
  const ai = {
    model: "m",
    setModel: vi.fn(),
    generate: vi.fn(gen),
    estimateConfidence: vi.fn(async () => 0.8),
    extractMemoryCandidates: vi.fn(async () => []),
    async *generateStream(ctx: ContextPack) {
      const r = await gen(ctx);
      if (r.text) yield { type: "text" as const, text: r.text };
      yield { type: "done" as const, response: r };
    },
  };
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
    { storage: createInMemoryStorage(), renderer: new NullRenderer(), ai: ai as never },
  );
  const calls: string[] = [];
  for (const def of [READ_FILE, LOCAL_WRITE, EXT_WRITE]) {
    runtime.getToolRegistry().register(def, async () => {
      calls.push(def.name);
      return { ok: true, data: "x" };
    });
  }
  // Pin the task's tail: hold its `agent_task*` event append open.
  const tail = deferred();
  const reached = deferred();
  const events = (
    runtime as unknown as {
      events: { appendWithClock: (e: { event_type: string }) => Promise<unknown> };
    }
  ).events;
  const orig = events.appendWithClock.bind(events);
  events.appendWithClock = async (e) => {
    if (String(e.event_type).startsWith("agent_task")) {
      reached.r();
      await tail.p;
    }
    return orig(e as never);
  };
  return { runtime, offered, calls, tail, reached };
}

const task = (): AgentTask => ({
  task_id: "t1",
  motebit_id: "owner",
  prompt: "TASK",
  submitted_at: Date.now(),
  status: AgentTaskStatus.Claimed,
  wall_clock_ms: 30_000,
});

async function drain(g: AsyncGenerator<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = [];
  for await (const c of g) out.push(c);
  return out;
}

const pendingMark = (runtime: MotebitRuntime): boolean | undefined =>
  (
    runtime as unknown as {
      streaming: { _pendingApproval: { foreignPrincipal?: boolean } | null };
    }
  ).streaming._pendingApproval?.foreignPrincipal;

describe("the foreign scope is the turn's, never the runtime's (#880 round 2)", () => {
  it("an owner turn started during a foreign task's tail is the owner's", async () => {
    const kp = await generateKeypair();
    const { runtime, offered, calls, tail, reached } = make("ext_write");
    const taskP = drain(runtime.handleAgentTask(task(), kp.privateKey, "dev"));
    await reached.p; // the task's turn is over; its tail is in flight

    offered.length = 0;
    const own = await drain(runtime.sendMessageStreaming("store x"));
    // Pauses normally (not refused), with every tool offered.
    expect(own.some((c) => c.type === "approval_request")).toBe(true);
    expect(runtime.hasPendingApproval).toBe(true);
    expect(offered[0]).toContain("read_file");
    // The approval is stamped as the owner's.
    expect(pendingMark(runtime)).toBeUndefined();

    tail.r();
    await taskP;
    offered.length = 0;
    await drain(runtime.resumeAfterApproval(true));
    expect(calls).toContain("ext_write");
    // The continuation is the owner's too.
    for (const names of offered) expect(names).toContain("read_file");
  });

  it("an owner approval paused while a foreign task's tail runs is honored — even for a localOnly tool", async () => {
    const kp = await generateKeypair();
    const ownerGate = deferred();
    const { runtime, calls, tail, reached } = make("local_write", ownerGate);
    const ownP = drain(runtime.sendMessageStreaming("write it"));
    await new Promise((r) => setTimeout(r, 20));
    // A foreign task arrives mid-turn: refused by the single-writer guard,
    // its tail still runs.
    const taskP = drain(runtime.handleAgentTask(task(), kp.privateKey, "dev"));
    await reached.p;
    ownerGate.r();
    const own = await ownP;

    expect(own.some((c) => c.type === "approval_request")).toBe(true);
    expect(pendingMark(runtime)).toBeUndefined();

    tail.r();
    await taskP;
    await drain(runtime.resumeAfterApproval(true));
    expect(calls).toEqual(["local_write"]);
  });

  it("a resumed foreign continuation runs through the no-approval view — it cannot chain a new pending approval", async () => {
    // After the approved call's result, the continuation's model proposes
    // ext_write AGAIN, which would pause under balanced.
    const { runtime, offered, calls } = make("ext_write", undefined, "ext_write");
    // No code path creates a foreign pending approval any more — plant one.
    (
      runtime as unknown as { streaming: { _pendingApproval: Record<string, unknown> } }
    ).streaming._pendingApproval = {
      toolCallId: "c0",
      toolName: "ext_write",
      args: {},
      userMessage: "store x",
      requestedAt: Date.now(),
      foreignPrincipal: true,
    };
    const out = await drain(runtime.resumeAfterApproval(true));
    // The approved call ran once; the chained proposal was refused, not paused.
    expect(calls).toEqual(["ext_write"]);
    expect(out.some((c) => c.type === "approval_request")).toBe(false);
    expect(runtime.hasPendingApproval).toBe(false);
    const refused = out.find(
      (c) =>
        c.type === "tool_status" &&
        String((c as { result?: unknown }).result).includes(
          "not available to another principal's task",
        ),
    );
    expect(refused).toBeDefined();
    expect(offered.length).toBeGreaterThan(0);
    for (const names of offered) expect(names).not.toContain("read_file");
  });

  it("the foreign resume's mark is released: the owner's next turn is offered read_file and pauses normally", async () => {
    const { runtime, offered } = make("ext_write");
    (
      runtime as unknown as { streaming: { _pendingApproval: Record<string, unknown> } }
    ).streaming._pendingApproval = {
      toolCallId: "c0",
      toolName: "ext_write",
      args: {},
      userMessage: "store x",
      requestedAt: Date.now(),
      foreignPrincipal: true,
    };
    await drain(runtime.resumeAfterApproval(true));
    expect(isForeign(runtime)).toBe(false);

    offered.length = 0;
    const own = await drain(runtime.sendMessageStreaming("OWNER store y"));
    expect(offered[0]).toContain("read_file");
    expect(own.some((c) => c.type === "approval_request")).toBe(true);
    expect(runtime.hasPendingApproval).toBe(true);
  });

  it("a foreign non-streaming sendMessage (motebit_query) clears its mark — on success and on a throw", async () => {
    const { runtime, calls } = make("ext_write");
    const scoped = (
      runtime as unknown as {
        scopedToolRegistry: { execute(n: string, a: object): Promise<{ ok: boolean }> };
      }
    ).scopedToolRegistry;

    await runtime.sendMessage("TASK q", undefined, { foreignPrincipal: true });
    expect(isForeign(runtime)).toBe(false);
    expect((await scoped.execute("read_file", {})).ok).toBe(true);

    await expect(
      runtime.sendMessage("THROW q", undefined, { foreignPrincipal: true }),
    ).rejects.toThrow();
    expect(isForeign(runtime)).toBe(false);
    expect((await scoped.execute("read_file", {})).ok).toBe(true);
    expect(calls).toEqual(["read_file", "read_file"]);
  });
});

/**
 * #943 round 9: the runtime keeps NO foreign mark at all — whose words a
 * turn runs travels on that turn's call path — so nothing can outlive it.
 */
function isForeign(runtime: MotebitRuntime): boolean {
  const r = runtime as unknown as Record<string, unknown>;
  return (
    "_foreignTurn" in r ||
    "_foreignResume" in r ||
    typeof r["isForeignPrincipalTurn"] === "function"
  );
}
