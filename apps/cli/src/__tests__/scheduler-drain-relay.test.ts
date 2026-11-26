/**
 * Recovered approvals carry their relay (design runtime-relay-binding 4b
 * §2, §3 change 1, §4 PR-1 tests).
 *
 * The REAL `GoalScheduler` over a REAL `MotebitRuntime` and SQLite queue:
 *
 *   - both approval-row writers (a turn's pause and a plan step's pause)
 *     copy the relay ai-core stamped on the chunk — a rebind between the
 *     pause and the write leaves the row naming the pause's relay;
 *   - after a restart, the drain runs a relay-bound tool's approval only
 *     under the relay it was approved under (same pin key, same pinned key
 *     or both null), refusing `relay_changed` otherwise — a null-relay row,
 *     an unpinnable relay, and a relay-bound tool no longer registered are
 *     refused with the drain's own verdict;
 *   - goal tools approved under the Cautious preset still run.
 *
 * The relays are `.invalid` hosts; every fetch is stubbed to fail, so a
 * handler that runs reaches nothing. Ephemeral keys only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@motebit/memory-graph", async () => {
  const actual =
    await vi.importActual<typeof import("@motebit/memory-graph")>("@motebit/memory-graph");
  return { ...actual, embedText: (text: string) => Promise.resolve(actual.embedTextHash(text)) };
});

import { createHash } from "node:crypto";
import {
  MotebitRuntime,
  NullRenderer,
  RELAY_CHANGED_RESULT,
  createInMemoryStorage,
} from "@motebit/runtime";
import type { StreamChunk } from "@motebit/runtime";
import type { StreamingProvider } from "@motebit/ai-core";
import type { AIResponse, ContextPack, ToolDefinition } from "@motebit/sdk";
import { APPROVAL_PRESET_CONFIGS, SensitivityLevel } from "@motebit/sdk";
import { InMemoryPlanStore, PlanEngine } from "@motebit/planner";
import type { PlanChunk } from "@motebit/planner";
import {
  createMotebitDatabase,
  type MotebitDatabase,
  type StampedGoal,
} from "@motebit/persistence";
import { generateKeypair } from "@motebit/crypto";
import { GoalScheduler } from "../scheduler.js";

const ME = "mote-drain";
const RELAY_A = "https://relay-a.invalid";
const RELAY_B = "https://relay-b.invalid";
const UNPINNABLE = "https://relay-a.invalid/?x=1";
const KEYS = await generateKeypair();
const CAUTIOUS = APPROVAL_PRESET_CONFIGS["cautious"]!;
const DELEGATE_ARGS = { prompt: "research X" };

/** A provider that plans one step (plan mode) and proposes `tool` once per prompt. */
function proposing(tool: string, args: Record<string, unknown>): StreamingProvider {
  const plain = (text: string, extra: Partial<AIResponse> = {}): AIResponse => ({
    text,
    confidence: 0.8,
    memory_candidates: [],
    state_updates: {},
    ...extra,
  });
  const gen = (ctx: ContextPack): AIResponse => {
    const history = JSON.stringify(ctx.conversation_history ?? []);
    if (history.includes("planning engine")) {
      return plain(JSON.stringify({ title: "Plan", steps: [{ description: "do", prompt: "do" }] }));
    }
    if (!history.includes('"role":"tool"')) {
      return plain("", { tool_calls: [{ id: "c1", name: tool, args }] });
    }
    return plain("done");
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

function makeRuntime(tool = "delegate_to_agent"): MotebitRuntime {
  const runtime = new MotebitRuntime(
    {
      motebitId: ME,
      tickRateHz: 0,
      signingKeys: KEYS,
      policy: {
        operatorMode: true,
        maxRiskLevel: CAUTIOUS.maxRiskLevel,
        requireApprovalAbove: CAUTIOUS.requireApprovalAbove,
        denyAbove: CAUTIOUS.denyAbove,
      },
    },
    {
      storage: createInMemoryStorage(),
      renderer: new NullRenderer(),
      ai: proposing(tool, DELEGATE_ARGS),
    },
  );
  runtime.setProviderMode("on-device");
  return runtime;
}

function bind(runtime: MotebitRuntime, url: string, tools = true): void {
  runtime.bindRelay({
    syncUrl: url,
    authToken: async (aud?: string) => `${url}:${aud ?? "none"}`,
    tools,
    invokeCapability: tools,
  });
}

/** Replace a registered tool's handler with a counting spy (the registry keeps its relay flag). */
function spyOn(runtime: MotebitRuntime, name: string): { calls: () => number } {
  const registry = runtime.getToolRegistry();
  const def = registry.get(name) as ToolDefinition;
  let calls = 0;
  registry.replace(def, async () => {
    calls++;
    return { ok: true, data: "ran" };
  });
  return { calls: () => calls };
}

/** Count calls into `invokeLocalTool`: a refusal by the drain itself never makes one. */
function countInvokes(runtime: MotebitRuntime): { calls: () => number } {
  const invoke = runtime.invokeLocalTool.bind(runtime);
  let calls = 0;
  runtime.invokeLocalTool = (...a: Parameters<typeof invoke>) => {
    calls++;
    return invoke(...a);
  };
  return { calls: () => calls };
}

function goal(over: Partial<StampedGoal> = {}): StampedGoal {
  return {
    sensitivity: SensitivityLevel.None,
    goal_id: "goal-001",
    motebit_id: ME,
    prompt: "tidy the inbox",
    interval_ms: 3_600_000,
    last_run_at: null,
    enabled: true,
    created_at: Date.now(),
    mode: "recurring",
    status: "active",
    parent_goal_id: null,
    max_retries: 3,
    consecutive_failures: 0,
    wall_clock_ms: null,
    project_id: null,
    ...over,
  };
}

function scheduler(db: MotebitDatabase, runtime: MotebitRuntime): GoalScheduler {
  return new GoalScheduler(
    runtime,
    db.goalStore,
    db.approvalStore,
    db.goalOutcomeStore,
    db.goalRunStore,
    db.toolAuditSink,
    ME,
    CAUTIOUS.denyAbove,
  );
}

/** Seed a run awaiting an APPROVED approval, as a restart finds it. */
function seedApproved(
  db: MotebitDatabase,
  row: {
    tool: string;
    args?: Record<string, unknown>;
    relay_pin_key: string | null;
    relay_public_key?: string | null;
    relay_bound: boolean | null;
  },
): string {
  const now = Date.now();
  db.goalStore.add(goal({ last_run_at: now }));
  db.goalRunStore.start({ run_id: "run-1", goal_id: "goal-001", motebit_id: ME });
  db.goalRunStore.setStatus("run-1", "awaiting_approval", { approval_id: "ap-1" });
  const argsJson = JSON.stringify(row.args ?? DELEGATE_ARGS);
  db.approvalStore.add({
    approval_id: "ap-1",
    motebit_id: ME,
    goal_id: "goal-001",
    tool_name: row.tool,
    args_preview: argsJson,
    args_hash: createHash("sha256").update(argsJson).digest("hex"),
    risk_level: 2,
    status: "approved",
    created_at: now,
    expires_at: now + 600_000,
    resolved_at: now,
    denied_reason: null,
    args_json: argsJson,
    relay_pin_key: row.relay_pin_key,
    relay_public_key: row.relay_public_key ?? null,
    relay_bound: row.relay_bound,
  });
  return "run-1";
}

async function restart(db: MotebitDatabase, runtime: MotebitRuntime): Promise<string> {
  const s = scheduler(db, runtime);
  s.recoverInterruptedRuns();
  await s.tickOnce();
  s.stop();
  return db.goalRunStore.get("run-1")!.note ?? "";
}

let db: MotebitDatabase;
const originalFetch = globalThis.fetch;
beforeEach(() => {
  db = createMotebitDatabase(":memory:");
  globalThis.fetch = (async () => {
    throw new Error("no network in this test");
  }) as typeof fetch;
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("approval rows are stamped from the chunk", () => {
  it("turn writer: a rebind between the pause and the write leaves the row naming A", async () => {
    const runtime = makeRuntime();
    bind(runtime, RELAY_A);
    const stream = runtime.sendMessageStreaming.bind(runtime);
    runtime.sendMessageStreaming = async function* (...a: Parameters<typeof stream>) {
      for await (const c of stream(...a)) {
        // The pause already happened; rebind before the scheduler writes.
        if ((c as StreamChunk).type === "approval_request") bind(runtime, RELAY_B);
        yield c;
      }
    } as typeof runtime.sendMessageStreaming;
    db.goalStore.add(goal({ interval_ms: 0 }));
    const s = scheduler(db, runtime);
    s.registerGoalTools();
    await s.tickOnce();
    s.stop();

    const [row] = db.approvalStore.listAll(ME);
    expect(row?.tool_name).toBe("delegate_to_agent");
    expect(row?.relay_pin_key).toBe(RELAY_A);
    expect(row?.relay_public_key).toBeNull();
    expect(row?.relay_bound).toBe(true);
    // The binding moved to B before the write; the row still names A.
    expect(runtime.getDelegationRelay()?.url).toBe(RELAY_B);
  });

  it("plan-step writer: a rebind between the pause and the write leaves the row naming A", async () => {
    const runtime = makeRuntime();
    bind(runtime, RELAY_A);
    const planStore = new InMemoryPlanStore();
    const engine = new PlanEngine(planStore);
    const execute = engine.executePlan.bind(engine);
    engine.executePlan = async function* (...a: Parameters<typeof execute>) {
      for await (const c of execute(...a)) {
        if ((c as PlanChunk).type === "approval_request") bind(runtime, RELAY_B);
        yield c;
      }
    } as typeof engine.executePlan;
    db.goalStore.add(goal({ interval_ms: 0 }));
    const s = scheduler(db, runtime);
    s.setPlanEngine(engine, planStore);
    s.registerGoalTools();
    await s.tickOnce();
    s.stop();

    const [row] = db.approvalStore.listAll(ME);
    expect(row?.tool_name).toBe("delegate_to_agent");
    expect(row?.relay_pin_key).toBe(RELAY_A);
    expect(row?.relay_bound).toBe(true);
    expect(runtime.getDelegationRelay()?.url).toBe(RELAY_B);
  });

  it("an unpinnable relay stamps null, and the restarted drain refuses the call", async () => {
    const runtime = makeRuntime();
    bind(runtime, UNPINNABLE);
    db.goalStore.add(goal({ interval_ms: 0 }));
    const s = scheduler(db, runtime);
    s.registerGoalTools();
    await s.tickOnce();
    s.stop();
    const [row] = db.approvalStore.listAll(ME);
    expect(row?.relay_pin_key).toBeNull();
    expect(row?.relay_bound).toBe(true);
    db.approvalStore.resolve(row!.approval_id, "approved");

    // Restart on the same unpinnable URL: no identity can compare equal.
    const second = makeRuntime();
    bind(second, UNPINNABLE);
    const spy = spyOn(second, "delegate_to_agent");
    const s2 = scheduler(db, second);
    s2.recoverInterruptedRuns();
    await s2.tickOnce();
    s2.stop();
    const run = db.goalRunStore.getByApproval(row!.approval_id)!;
    expect(run.note).toContain("relay_changed");
    expect(run.note).toContain(
      "was approved with no relay recorded, so it cannot be checked against the bound relay — not executed",
    );
    expect(spy.calls()).toBe(0);
  });
});

describe("the drain runs a relay-bound approval only under its relay", () => {
  it("recorded under A, restarted bound to B: denied relay_changed, handler not invoked", async () => {
    seedApproved(db, { tool: "delegate_to_agent", relay_pin_key: RELAY_A, relay_bound: true });
    const runtime = makeRuntime();
    bind(runtime, RELAY_B);
    const spy = spyOn(runtime, "delegate_to_agent");
    const invokes = countInvokes(runtime);
    const note = await restart(db, runtime);
    expect(note).toContain("approved under another relay");
    expect(note).toContain("relay_changed");
    expect(spy.calls()).toBe(0);
    // Refused by the drain itself, before the runtime is asked.
    expect(invokes.calls()).toBe(0);
    expect(db.goalRunStore.get("run-1")!.status).toBe("failed");
  });

  it("recorded under A, restarted bound to A: runs", async () => {
    seedApproved(db, { tool: "delegate_to_agent", relay_pin_key: RELAY_A, relay_bound: true });
    const runtime = makeRuntime();
    bind(runtime, RELAY_A);
    const spy = spyOn(runtime, "delegate_to_agent");
    const note = await restart(db, runtime);
    expect(spy.calls()).toBe(1);
    expect(note).toContain("executed after approval");
  });

  it("recorded under A with no pinned key, restarted bound to A with a key: denied", async () => {
    seedApproved(db, { tool: "delegate_to_agent", relay_pin_key: RELAY_A, relay_bound: true });
    const runtime = makeRuntime();
    runtime.bindRelay({
      syncUrl: RELAY_A,
      authToken: async () => "t",
      relayPublicKey: "ab".repeat(32),
      tools: true,
      invokeCapability: true,
    });
    const spy = spyOn(runtime, "delegate_to_agent");
    const note = await restart(db, runtime);
    expect(note).toContain("relay_changed");
    expect(note).toContain(
      "delegate_to_agent was approved under this relay, but the relay's pinned key has changed since the approval — not executed (relay_changed)",
    );
    expect(note).not.toContain("another relay");
    expect(spy.calls()).toBe(0);
  });

  it("a null-relay row for a relay-bound tool: denied", async () => {
    seedApproved(db, { tool: "delegate_to_agent", relay_pin_key: null, relay_bound: true });
    const runtime = makeRuntime();
    bind(runtime, RELAY_A);
    const spy = spyOn(runtime, "delegate_to_agent");
    const note = await restart(db, runtime);
    expect(note).toContain("relay_changed");
    expect(note).toContain(
      "was approved with no relay recorded, so it cannot be checked against the bound relay — not executed",
    );
    expect(spy.calls()).toBe(0);
  });

  it("a relay-bound row whose tool is unregistered: the drain's own relay_changed verdict", async () => {
    seedApproved(db, { tool: "delegate_to_agent", relay_pin_key: RELAY_A, relay_bound: true });
    const runtime = makeRuntime();
    // Bound, but without the delegation tools: delegate_to_agent is unregistered.
    bind(runtime, RELAY_A, false);
    expect(runtime.getToolRegistry().has("delegate_to_agent")).toBe(false);
    const note = await restart(db, runtime);
    expect(note).toContain(
      "was approved as a relay tool, but its tool is not registered under the current binding — not executed",
    );
    expect(note).not.toContain("approved under another relay");
    expect(note).toContain("relay_changed");
    expect(note).not.toContain("is not available");
  });

  it("an old row (relay_bound unknown) for a tool relay-bound now: denied", async () => {
    seedApproved(db, { tool: "delegate_to_agent", relay_pin_key: null, relay_bound: null });
    const runtime = makeRuntime();
    bind(runtime, RELAY_A);
    const spy = spyOn(runtime, "delegate_to_agent");
    const invokes = countInvokes(runtime);
    const note = await restart(db, runtime);
    expect(note).toContain("relay_changed");
    expect(note).toContain(
      "was approved with no relay recorded, so it cannot be checked against the bound relay — not executed",
    );
    expect(spy.calls()).toBe(0);
    expect(invokes.calls()).toBe(0);
  });

  it("an old row (relay_bound unknown) whose tool is unregistered: denied relay_changed", async () => {
    seedApproved(db, { tool: "delegate_to_agent", relay_pin_key: null, relay_bound: null });
    const runtime = makeRuntime();
    const note = await restart(db, runtime);
    expect(note).toContain("relay_changed");
    // The drain cannot know whether the tool was relay-bound, and says so.
    expect(note).toContain(
      "delegate_to_agent was approved before relay recording and its tool is not registered now, so it cannot be checked against the bound relay — not executed",
    );
    expect(note).not.toContain("approved under another relay");
    expect(db.goalStore.get("goal-001")!.consecutive_failures).toBe(0);
  });

  it("a row mislabelled not relay-bound for a relay-bound tool: the runtime refuses it", async () => {
    seedApproved(db, { tool: "delegate_to_agent", relay_pin_key: null, relay_bound: false });
    const runtime = makeRuntime();
    bind(runtime, RELAY_A);
    const spy = spyOn(runtime, "delegate_to_agent");
    const note = await restart(db, runtime);
    // The drain let it through (the row says local); the runtime refused it,
    // and the drain treats that refusal exactly like its own.
    expect(note).toContain(
      "was approved with no relay recorded, so it cannot be checked against the bound relay — not executed",
    );
    expect(note).toContain("relay_changed");
    expect(note).not.toContain("failed after approval");
    expect(spy.calls()).toBe(0);
    expect(db.goalStore.get("goal-001")!.consecutive_failures).toBe(0);
  });
});

describe("the runtime's relay_changed refusal counts like the drain's own", () => {
  it("a relay_bound=false row recorded under A, restarted bound to B: not a goal failure", async () => {
    seedApproved(db, { tool: "delegate_to_agent", relay_pin_key: RELAY_A, relay_bound: false });
    const runtime = makeRuntime();
    bind(runtime, RELAY_B);
    const spy = spyOn(runtime, "delegate_to_agent");
    const note = await restart(db, runtime);
    expect(spy.calls()).toBe(0);
    expect(note).toContain(
      "delegate_to_agent was approved under another relay than the one bound now — not executed (relay_changed)",
    );
    expect(note).not.toContain("failed after approval");
    expect(db.goalRunStore.get("run-1")!.status).toBe("failed");
    expect(db.goalStore.get("goal-001")!.consecutive_failures).toBe(0);
  });
});

describe("the drain says only what it knows", () => {
  it("a relay-bound row recorded under A, drained with nothing bound: no relay is bound now", async () => {
    seedApproved(db, { tool: "delegate_to_agent", relay_pin_key: RELAY_A, relay_bound: true });
    const runtime = makeRuntime();
    const invokes = countInvokes(runtime);
    const note = await restart(db, runtime);
    expect(note).toContain(
      "delegate_to_agent was approved under a relay, but no relay is bound now — not executed (relay_changed)",
    );
    expect(note).not.toContain("approved under another relay");
    expect(invokes.calls()).toBe(0);
    expect(db.goalStore.get("goal-001")!.consecutive_failures).toBe(0);
  });
});

const LOCAL: ToolDefinition = {
  name: "write_note",
  mode: "api",
  description: "Write a note on this device",
  inputSchema: { type: "object", properties: {} },
};

describe("a handler's own failure is never taken for the runtime's relay refusal", () => {
  it("a local tool whose handler runs and returns the relay_changed text: a counted failure", async () => {
    seedApproved(db, {
      tool: "write_note",
      args: {},
      relay_pin_key: RELAY_A,
      relay_bound: false,
    });
    const runtime = makeRuntime();
    bind(runtime, RELAY_A);
    let calls = 0;
    runtime.getToolRegistry().register(LOCAL, async () => {
      calls++; // the handler ran (a side effect happened), then echoed the text
      return { ok: false, error: RELAY_CHANGED_RESULT.error };
    });
    const note = await restart(db, runtime);
    expect(calls).toBe(1);
    expect(note).toContain("write_note failed after approval");
    expect(note).not.toContain("not executed");
    expect(db.goalStore.get("goal-001")!.consecutive_failures).toBe(1);
    expect(db.goalOutcomeStore.listForGoal("goal-001", 10)[0]!.tool_calls_made).toBe(1);
  });

  it("a relay-bound tool whose handler runs and returns the relay_changed text: a counted failure", async () => {
    seedApproved(db, { tool: "delegate_to_agent", relay_pin_key: RELAY_A, relay_bound: true });
    const runtime = makeRuntime();
    bind(runtime, RELAY_A);
    const registry = runtime.getToolRegistry();
    let calls = 0;
    // The flag is kept across `replace`: still relay-bound, same relay.
    registry.replace(registry.get("delegate_to_agent") as ToolDefinition, async () => {
      calls++;
      return { ok: false, error: RELAY_CHANGED_RESULT.error };
    });
    const note = await restart(db, runtime);
    expect(calls).toBe(1);
    expect(note).toContain("delegate_to_agent failed after approval");
    expect(db.goalStore.get("goal-001")!.consecutive_failures).toBe(1);
    expect(db.goalOutcomeStore.listForGoal("goal-001", 10)[0]!.tool_calls_made).toBe(1);
  });

  it("a local tool whose handler passes on the runtime's own refusal: still a counted failure", async () => {
    seedApproved(db, { tool: "proxy_note", args: {}, relay_pin_key: RELAY_A, relay_bound: false });
    const runtime = makeRuntime();
    bind(runtime, RELAY_A);
    let calls = 0;
    runtime.getToolRegistry().register({ ...LOCAL, name: "proxy_note" }, async () => {
      calls++;
      // The runtime's marked refusal, from a carried approval with no relay.
      return runtime.invokeLocalTool("delegate_to_agent", DELEGATE_ARGS, {
        invocationOrigin: "scheduled",
        humanApproved: true,
      });
    });
    const note = await restart(db, runtime);
    expect(calls).toBe(1);
    expect(note).toContain("proxy_note failed after approval");
    expect(db.goalStore.get("goal-001")!.consecutive_failures).toBe(1);
    expect(db.goalOutcomeStore.listForGoal("goal-001", 10)[0]!.tool_calls_made).toBe(1);
  });
});

describe("the runtime's refusal under the matching relay is not called another relay", () => {
  it("a relay-bound handler passing on a minted refusal under the approval's relay", async () => {
    seedApproved(db, { tool: "delegate_to_agent", relay_pin_key: RELAY_A, relay_bound: true });
    const runtime = makeRuntime();
    bind(runtime, RELAY_A);
    const registry = runtime.getToolRegistry();
    let calls = 0;
    // The reviewer's forge probe: a handler under a relay-bound name obtains
    // a genuine minted refusal (a carried approval with no relay) and
    // returns it. The drain cannot tell it from a real one; it must not
    // claim the relay changed.
    registry.replace(registry.get("delegate_to_agent") as ToolDefinition, async () => {
      calls++;
      return runtime.invokeLocalTool(
        "discover_agents",
        {},
        { invocationOrigin: "scheduled", humanApproved: true },
      );
    });
    const note = await restart(db, runtime);
    expect(calls).toBe(1);
    expect(note).toContain(
      "delegate_to_agent was refused by the runtime's relay check although the bound relay matches the approval — not executed (relay_changed)",
    );
    expect(note).not.toContain("another relay");
    expect(db.goalStore.get("goal-001")!.consecutive_failures).toBe(0);
  });
});

describe("a drain refusal leaves no goal tool registered", () => {
  it("create_sub_goal, complete_goal and report_progress are unregistered after the refusal", async () => {
    seedApproved(db, { tool: "delegate_to_agent", relay_pin_key: RELAY_A, relay_bound: true });
    const runtime = makeRuntime();
    bind(runtime, RELAY_B);
    await restart(db, runtime);
    const registry = runtime.getToolRegistry();
    expect(registry.has("create_sub_goal")).toBe(false);
    expect(registry.has("complete_goal")).toBe(false);
    expect(registry.has("report_progress")).toBe(false);
  });
});

describe("recovered goal-tool approvals run as on main (Cautious preset)", () => {
  it.each([
    ["recorded by the new writer", false],
    ["from before the relay columns", null],
  ] as const)("create_sub_goal %s: runs", async (_label, relayBound) => {
    seedApproved(db, {
      tool: "create_sub_goal",
      args: { prompt: "water the plants" },
      relay_pin_key: null,
      relay_bound: relayBound,
    });
    const runtime = makeRuntime("create_sub_goal");
    bind(runtime, RELAY_B);
    const note = await restart(db, runtime);
    expect(note).toContain("executed after approval");
    expect(note).not.toContain("relay_changed");
    expect(db.goalStore.listChildren("goal-001").map((g) => g.prompt)).toContain(
      "water the plants",
    );
  });
});
