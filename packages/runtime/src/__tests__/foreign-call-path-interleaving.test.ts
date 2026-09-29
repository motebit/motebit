/**
 * #943 round 9 — foreign-ness is a property of a CALL PATH, never ambient
 * runtime state. Interleaving harness (the #816 lesson: exhaustive, not
 * whack-a-mole).
 *
 * A runtime-wide "a foreign turn is in flight" mark, read by shared
 * backends, gave the OWNER's own concurrent calls the stranger's treatment
 * while a customer's task happened to be running (a completion refused with
 * the foreign refusal, a recall tap returning nothing). Here every owner
 * door runs while a foreign turn is HELD at each of its phases, and its
 * result must equal what an idle owner gets, at normal sensitivity and at
 * medical/byok:
 *
 *   phases: pre-provider (the model call is parked) · mid-tool (a tool
 *           handler is parked) · deferred formation (the formation queue is
 *           parked after the turn returned) · approval-resume (a foreign
 *           resume's approved call is parked)
 *   doors:  sendMessage · sendMessageStreaming · generateCompletion ·
 *           reflect · invokeLocalTool(recall_memories) ·
 *           invokeLocalTool(outbound) · executePlan (executePlanStep gate) ·
 *           a PlanEngine step's tool calls (getLoopDeps().tools: recall,
 *           outbound) · invokeCapability · invokeLocalTool(retrieve_task_result)
 *           · the owner's approval timeout (writes the owner's history)
 *
 * `sendMessage*` while a foreign turn HOLDS the single-writer slot is refused
 * as busy — the owner's refusal is the descriptive "Already processing a
 * message", never the foreign one; at medical the gate answers first,
 * exactly as for an idle owner.
 *
 * The converse: a foreign call during owner activity still gets the
 * foreign treatment (content-free busy refusal; no localOnly tool; its
 * formation stays isolated), and the owner's own deferred formation that
 * drains while a foreign turn is held still consolidates.
 *
 * Tampers (restore an ambient read at one backend) — each turns a cell red;
 * see the report of the commit that added this file.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("@motebit/memory-graph", async () => {
  const actual =
    await vi.importActual<typeof import("@motebit/memory-graph")>("@motebit/memory-graph");
  return { ...actual, embedText: (text: string) => Promise.resolve(actual.embedTextHash(text)) };
});

/**
 * Parks a formation pass on the runtime's memory graph: the deferred queue
 * calls `formMemory` (isolated / no provider) or `consolidateAndForm`
 * (consolidate) for each candidate; a candidate whose content includes
 * `match` waits for `release` there.
 */
const formHold: { match: string | null; reached: () => void; release: Promise<void> | null } = {
  match: null,
  reached: () => {},
  release: null,
};

import {
  MotebitRuntime,
  NullRenderer,
  createInMemoryStorage,
  FOREIGN_REFUSAL_MESSAGE,
} from "../index";
import type { StreamChunk, ToolCall } from "../index";
import type { StreamingProvider } from "@motebit/ai-core";
import { ConsolidationAction, embedTextHash } from "@motebit/memory-graph";
import type { ConsolidationProvider } from "@motebit/memory-graph";
import type {
  AIResponse,
  AgentTask,
  ContextPack,
  ExecutionReceipt,
  ToolRegistry,
} from "@motebit/sdk";
import { AgentTaskStatus, RiskLevel, SensitivityLevel } from "@motebit/sdk";
import { generateKeypair } from "@motebit/encryption";
import { foreignTurnTools } from "./helpers/foreign-call";

const STRANGER = "STRANGER-943";
const STRANGER_FACT = "STRANGER-FACT-943 the sky is green";
const OWNER_FACT = "My launch is on Tuesday OWNER-FACT-943";
const OWNER_MEMORY = "OWNER-MEMORY-943 launch plan";

type Phase = "pre-provider" | "mid-tool" | "deferred-formation" | "approval-resume";
const PHASES: Phase[] = ["pre-provider", "mid-tool", "deferred-formation", "approval-resume"];
type Tier = "normal" | "medical";
const TIERS: Tier[] = ["normal", "medical"];

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

interface Env {
  runtime: MotebitRuntime;
  /** Parks the foreign path; released by `release()`. */
  hold: ReturnType<typeof deferred>;
  reached: ReturnType<typeof deferred>;
  phase: Phase | null;
  recallCalls: string[];
  classify: ReturnType<typeof vi.fn>;
  foreignContexts: ContextPack[];
  /** Runs inside the owner's OWNER-FORM provider call. */
  onOwnerForm?: () => void;
}

function text(t: string): AIResponse {
  return { text: t, confidence: 0.9, memory_candidates: [], state_updates: {} };
}

async function build(): Promise<Env> {
  const env = {
    hold: deferred(),
    reached: deferred(),
    phase: null as Phase | null,
    recallCalls: [] as string[],
    foreignContexts: [] as ContextPack[],
  } as Env;
  const respond = async (ctx: ContextPack): Promise<AIResponse> => {
    const msg = ctx.user_message ?? "";
    const history = JSON.stringify(ctx.conversation_history ?? []);
    if (msg.includes(STRANGER)) {
      env.foreignContexts.push(ctx);
      if (env.phase === "pre-provider") {
        env.reached.resolve();
        await env.hold.promise;
      }
      if (env.phase === "mid-tool" && !history.includes("zz_block")) {
        return {
          ...text(""),
          tool_calls: [{ id: "b1", name: "zz_block", args: {} }],
        };
      }
      if (env.phase === "deferred-formation") {
        return {
          ...text("noted"),
          memory_candidates: [
            { content: STRANGER_FACT, confidence: 0.9, sensitivity: SensitivityLevel.None },
          ],
        };
      }
      if (msg.includes("RECALL") && !history.includes("recall_memories")) {
        return {
          ...text(""),
          tool_calls: [{ id: "r1", name: "recall_memories", args: { query: OWNER_MEMORY } }],
        };
      }
      return { ...text("stranger-done"), state_updates: { trust_mode: "minimal" as never } };
    }
    if (msg.includes("OWNER-FORM")) {
      env.onOwnerForm?.();
      return {
        ...text("owner noted"),
        memory_candidates: [
          { content: OWNER_FACT, confidence: 0.9, sensitivity: SensitivityLevel.None },
        ],
      };
    }
    if (msg.includes("OWNER-HOLD")) {
      env.reached.resolve();
      await env.hold.promise;
    }
    return text("owner-ok");
  };
  const provider: StreamingProvider = {
    model: "mock-model",
    setModel: vi.fn(),
    generate: vi.fn(async (ctx: ContextPack) => respond(ctx)),
    estimateConfidence: vi.fn(async () => 0.9),
    extractMemoryCandidates: vi.fn(async () => []),
    async *generateStream(ctx: ContextPack) {
      const r = await respond(ctx);
      if (r.text) yield { type: "text" as const, text: r.text };
      yield { type: "done" as const, response: r };
    },
  };
  const runtime = new MotebitRuntime(
    { motebitId: "owner-mote", tickRateHz: 0, deferMemoryFormation: true, approvalTimeoutMs: 20 },
    { storage: createInMemoryStorage(), renderer: new NullRenderer(), ai: provider },
  );
  runtime.setProviderMode("byok");
  env.runtime = runtime;
  const graph = runtime.memory as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
  for (const method of ["formMemory", "consolidateAndForm"]) {
    const original = graph[method]!.bind(runtime.memory);
    graph[method] = async (...a: unknown[]) => {
      const content = (a[0] as { content?: string }).content ?? "";
      if (formHold.match != null && content.includes(formHold.match) && formHold.release) {
        formHold.reached();
        await formHold.release;
      }
      return original(...a);
    };
  }
  await runtime.memory.formMemory(
    {
      content: OWNER_MEMORY,
      confidence: 0.9,
      sensitivity: SensitivityLevel.None,
      source: "user_stated",
    },
    embedTextHash(OWNER_MEMORY),
  );
  env.classify = vi.fn<ConsolidationProvider["classify"]>(async () => ({
    action: ConsolidationAction.ADD,
    reason: "test",
  }));

  const reg = runtime.getToolRegistry();
  reg.register(
    {
      name: "zz_block",
      mode: "api",
      description: "parks",
      inputSchema: { type: "object", properties: {} },
      riskHint: { risk: RiskLevel.R0_READ },
    },
    async () => {
      if (env.phase === "mid-tool" || env.phase === "approval-resume") {
        env.reached.resolve();
        await env.hold.promise;
      }
      return { ok: true, data: "unblocked" };
    },
  );
  reg.register(
    {
      name: "zz_out",
      mode: "api",
      description: "outbound",
      inputSchema: { type: "object", properties: {} },
      outbound: true,
      riskHint: { risk: RiskLevel.R0_READ },
    },
    async () => ({ ok: true, data: "sent" }),
  );
  // Mirrors @motebit/tools' recall_memories (localOnly), call-aware: the
  // backend's principal is this call's.
  reg.register(
    {
      name: "recall_memories",
      mode: "api",
      description: "recall",
      inputSchema: { type: "object", properties: { query: { type: "string" } } },
      localOnly: true,
      riskHint: { risk: RiskLevel.R0_READ },
    },
    async (args: Record<string, unknown>, call?: ToolCall) => {
      env.recallCalls.push(String(args.query));
      const found = await runtime.recallMemoriesForTool(
        String(args.query),
        { limit: 5 },
        (call as ToolCall).principal,
      );
      return { ok: true, data: found.map((f) => f.content) };
    },
  );
  runtime.enableInteractiveDelegation({
    syncUrl: "https://relay.invalid",
    authToken: async () => "t",
  });
  // Last: setup calls above may rewire the loop deps.
  (
    runtime as unknown as { loopDeps: { consolidationProvider: ConsolidationProvider } }
  ).loopDeps.consolidationProvider = {
    classify: env.classify as ConsolidationProvider["classify"],
  };
  return env;
}

async function drain(gen: AsyncGenerator<StreamChunk>): Promise<string> {
  let out = "";
  for await (const c of gen) if (c.type === "text") out += c.text;
  return out;
}

const describeErr = (e: unknown) =>
  e instanceof Error ? { error: e.name, message: e.message } : { error: String(e) };

async function settle(p: Promise<unknown>): Promise<unknown> {
  try {
    return { ok: await p };
  } catch (e) {
    return describeErr(e);
  }
}

type Door = { name: string; busyWhileHeld?: boolean; run: (env: Env) => Promise<unknown> };

const DOORS: Door[] = [
  {
    name: "sendMessage",
    busyWhileHeld: true,
    run: async ({ runtime }) => (await runtime.sendMessage("owner hello")).response,
  },
  {
    name: "sendMessageStreaming",
    busyWhileHeld: true,
    run: ({ runtime }) => drain(runtime.sendMessageStreaming("owner hello")),
  },
  { name: "generateCompletion", run: ({ runtime }) => runtime.generateCompletion("classify") },
  { name: "reflect", run: ({ runtime }) => runtime.reflect() },
  {
    name: "invokeLocalTool(recall_memories)",
    run: ({ runtime }) => runtime.invokeLocalTool("recall_memories", { query: OWNER_MEMORY }),
  },
  {
    name: "invokeLocalTool(outbound)",
    run: ({ runtime }) => runtime.invokeLocalTool("zz_out", {}),
  },
  {
    name: "invokeLocalTool(retrieve_task_result)",
    run: ({ runtime }) => runtime.invokeLocalTool("retrieve_task_result", {}),
  },
  {
    name: "executePlan (executePlanStep gate)",
    run: async ({ runtime }) => {
      const kinds: string[] = [];
      for await (const c of runtime.executePlan("goal-1", "owner goal")) kinds.push(c.type);
      return kinds.slice(0, 1);
    },
  },
  {
    name: "PlanEngine step tool: recall_memories (getLoopDeps().tools)",
    run: async ({ runtime }) => {
      const tools = (runtime.getLoopDeps() as unknown as { tools: ToolRegistry }).tools;
      return tools.execute("recall_memories", { query: OWNER_MEMORY });
    },
  },
  {
    // A step took its deps before the session's tier rose, then calls an
    // outbound tool: the refusal is decided at the tool call — the OWNER's.
    name: "PlanEngine step tool: outbound, tier raised mid-step (getLoopDeps().tools)",
    run: async ({ runtime }) => {
      const tier = runtime.getSessionSensitivity();
      runtime.setSessionSensitivity(SensitivityLevel.None);
      const tools = (runtime.getLoopDeps() as unknown as { tools: ToolRegistry }).tools;
      runtime.setSessionSensitivity(tier);
      return tools.execute("zz_out", {});
    },
  },
  {
    name: "invokeCapability",
    run: async ({ runtime }) => {
      const out: unknown[] = [];
      for await (const c of runtime.invokeCapability("web_search", "q")) out.push(c);
      return out;
    },
  },
  {
    name: "owner approval timeout (writes the owner's history)",
    run: async ({ runtime }) => {
      const s = (
        runtime as unknown as {
          streaming: {
            _pendingApproval: unknown;
            startApprovalTimeout(): void;
          };
        }
      ).streaming;
      s._pendingApproval = {
        toolCallId: "own-1",
        toolName: "zz_owner_tool",
        args: {},
        userMessage: "owner asked",
        requestedAt: Date.now(),
      };
      s.startApprovalTimeout();
      await new Promise((r) => setTimeout(r, 60));
      return runtime.getConversationHistory().some((m) => m.content.includes("Approval timed out"));
    },
  },
];

async function startForeign(env: Env, phase: Phase): Promise<{ done: Promise<unknown> }> {
  env.phase = phase;
  const { runtime } = env;
  if (phase === "pre-provider" || phase === "mid-tool") {
    const p = settle(
      drain(runtime.sendMessageStreaming(`${STRANGER} ask`, undefined, { foreignPrincipal: true })),
    );
    await env.reached.promise;
    return { done: p };
  }
  if (phase === "deferred-formation") {
    formHold.match = STRANGER_FACT;
    formHold.release = env.hold.promise;
    const reached = deferred();
    formHold.reached = reached.resolve;
    await drain(
      runtime.sendMessageStreaming(`${STRANGER} ask`, undefined, { foreignPrincipal: true }),
    );
    await reached.promise;
    return { done: settle(runtime.awaitPendingMemoryFormation()) };
  }
  // approval-resume: a paused FOREIGN approval whose approved call parks.
  (runtime as unknown as { streaming: { _pendingApproval: unknown } }).streaming._pendingApproval =
    {
      toolCallId: "f-1",
      toolName: "zz_block",
      args: {},
      userMessage: `${STRANGER} ask`,
      requestedAt: Date.now(),
      foreignPrincipal: true,
    };
  const p = settle(drain(runtime.resumeAfterApproval(true)));
  await env.reached.promise;
  return { done: p };
}

function resetFormHold() {
  formHold.match = null;
  formHold.release = null;
  formHold.reached = () => {};
}

/** Run a door; if it blocks on the parked foreign path, release it and finish. */
async function runDoor(env: Env, door: Door): Promise<{ result: unknown; waited: boolean }> {
  const p = settle(door.run(env));
  const raced = await Promise.race([
    p.then(() => "done" as const),
    new Promise<"blocked">((r) => setTimeout(() => r("blocked"), 150)),
  ]);
  if (raced === "blocked") env.hold.resolve();
  return { result: await p, waited: raced === "blocked" };
}

async function idleResult(door: Door, tier: Tier): Promise<unknown> {
  const env = await build();
  if (tier === "medical") env.runtime.setSessionSensitivity(SensitivityLevel.Medical);
  const { result } = await runDoor(env, door);
  return result;
}

describe("#943 round 9 — an owner door gets the idle-owner result while a foreign turn is held", () => {
  for (const tier of TIERS) {
    for (const phase of PHASES) {
      for (const door of DOORS) {
        it(`[${tier}] [${phase}] ${door.name}`, async () => {
          const expected = await idleResult(door, tier);
          const env = await build();
          const foreign = await startForeign(env, phase);
          if (tier === "medical") env.runtime.setSessionSensitivity(SensitivityLevel.Medical);
          const { result } = await runDoor(env, door);
          env.hold.resolve();
          await foreign.done;
          resetFormHold();

          const holdsTurn = phase !== "deferred-formation";
          if (door.busyWhileHeld === true && holdsTurn && tier === "normal") {
            // The single-writer slot is taken: the OWNER's busy refusal is
            // the descriptive one, never the foreign content-free refusal.
            expect(result).toEqual({ error: "Error", message: "Already processing a message" });
          } else {
            expect(result).toEqual(expected);
          }
          expect(JSON.stringify(result)).not.toContain(FOREIGN_REFUSAL_MESSAGE);
        });
      }
    }
  }
});

describe("#943 round 9 — the converse: a foreign call during owner activity keeps the foreign treatment", () => {
  for (const tier of TIERS) {
    it(`[${tier}] a foreign sendMessage / sendMessageStreaming / task while an owner turn is in flight is refused content-free`, async () => {
      const env = await build();
      const owner = settle(drain(env.runtime.sendMessageStreaming("OWNER-HOLD please")));
      await env.reached.promise;
      if (tier === "medical") env.runtime.setSessionSensitivity(SensitivityLevel.Medical);

      const q = await settle(
        env.runtime.sendMessage(`${STRANGER} q`, undefined, { foreignPrincipal: true }),
      );
      const s = await settle(
        drain(
          env.runtime.sendMessageStreaming(`${STRANGER} s`, undefined, { foreignPrincipal: true }),
        ),
      );
      const kp = await generateKeypair();
      const task: AgentTask = {
        task_id: "t-busy",
        motebit_id: "owner-mote",
        prompt: `${STRANGER} task`,
        submitted_at: Date.now(),
        status: AgentTaskStatus.Claimed,
        wall_clock_ms: 30_000,
      };
      let receipt: ExecutionReceipt | undefined;
      for await (const c of env.runtime.handleAgentTask(
        task,
        kp.privateKey,
        "dev-1",
      ) as AsyncGenerator<StreamChunk & { type: string; receipt?: ExecutionReceipt }>) {
        if (c.type === "task_result" && c.receipt !== undefined) receipt = c.receipt;
      }
      env.hold.resolve();
      await owner;

      const refused = { error: "ForeignTurnRefusedError", message: FOREIGN_REFUSAL_MESSAGE };
      expect(q).toEqual(refused);
      expect(s).toEqual(refused);
      expect(receipt?.result).toBe(FOREIGN_REFUSAL_MESSAGE);
      expect(JSON.stringify(receipt)).not.toMatch(/Already processing|medical/);
    });
  }

  it("a foreign turn run while an owner tool call is parked is offered and served no localOnly tool", async () => {
    const env = await build();
    env.phase = "mid-tool";
    const owner = settle(env.runtime.invokeLocalTool("zz_block", {}));
    await env.reached.promise;
    env.phase = null;
    await drain(
      env.runtime.sendMessageStreaming(`${STRANGER} RECALL`, undefined, { foreignPrincipal: true }),
    );
    env.hold.resolve();
    await owner;
    expect(env.recallCalls).toEqual([]);
    expect(env.foreignContexts.length).toBeGreaterThan(0);
    for (const ctx of env.foreignContexts) {
      expect((ctx.tools ?? []).map((t) => t.name)).not.toContain("recall_memories");
    }
    expect(JSON.stringify(env.foreignContexts)).not.toContain(OWNER_MEMORY);
    // Named anyway on the turn's own registry, it is refused, not run.
    const refused = await foreignTurnTools(env.runtime).execute("recall_memories", {
      query: OWNER_MEMORY,
    });
    expect(refused.ok).toBe(false);
    expect(env.recallCalls).toEqual([]);
  });

  it("the owner's deferred formation that drains while a foreign turn is held still consolidates", async () => {
    const env = await build();
    // An existing owner node the new owner fact consolidates against.
    const SEED = "The owner's launch is on Tuesday";
    await env.runtime.memory.formMemory(
      { content: SEED, confidence: 0.9, sensitivity: SensitivityLevel.None, source: "user_stated" },
      embedTextHash(SEED),
    );
    // Park the formation QUEUE (a job ahead of the owner's) so the owner's
    // formation job STARTS only once a foreign turn is in flight — the mode
    // must still be the owner turn's own decision, not whatever is running.
    const blocker = deferred();
    env.onOwnerForm = () =>
      (
        env.runtime as unknown as { memoryFormation: { enqueue(job: () => Promise<void>): void } }
      ).memoryFormation.enqueue(() => blocker.promise);
    await drain(env.runtime.sendMessageStreaming("OWNER-FORM remember this"));
    env.onOwnerForm = undefined;
    env.phase = "pre-provider";
    const foreign = settle(
      drain(
        env.runtime.sendMessageStreaming(`${STRANGER} ask`, undefined, { foreignPrincipal: true }),
      ),
    );
    await env.reached.promise;
    blocker.resolve();
    await env.runtime.awaitPendingMemoryFormation();
    expect(env.classify).toHaveBeenCalled();
    env.hold.resolve();
    await foreign;
  });

  it("a foreign turn's state_updates never reach the owner's live state (no push, no tick)", async () => {
    const env = await build();
    const tick = () => (env.runtime as unknown as { state: { tickNow(): void } }).state.tickNow();
    tick();
    const before = env.runtime.getState().trust_mode;
    expect(before).not.toBe("minimal");
    await env.runtime.sendMessage(`${STRANGER} be minimal`, undefined, { foreignPrincipal: true });
    await drain(
      env.runtime.sendMessageStreaming(`${STRANGER} be minimal`, undefined, {
        foreignPrincipal: true,
      }),
    );
    tick(); // flush anything a foreign turn might have queued
    expect(env.runtime.getState().trust_mode).toBe(before);
  });
});
