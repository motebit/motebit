import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock @motebit/tools/web-safe: we only need the goal-management defs
// ---------------------------------------------------------------------------

vi.mock("@motebit/tools/web-safe", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@motebit/tools/web-safe");
  return actual;
});

import { GoalScheduler } from "../goal-scheduler";
import type { GoalSchedulerDeps } from "../goal-scheduler";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRegistry() {
  const tools: Array<{
    def: { name: string };
    handler: (args: Record<string, unknown>) => Promise<unknown>;
  }> = [];
  return {
    register: vi.fn(
      (def: { name: string }, handler: (args: Record<string, unknown>) => Promise<unknown>) => {
        tools.push({ def, handler });
      },
    ),
    list: vi.fn(() => tools.map((t) => t.def)),
    tools,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeRuntime(overrides: Record<string, unknown> = {}): any {
  const registry = makeRegistry();
  return {
    getToolRegistry: vi.fn(() => registry),
    isProcessing: false,
    getLoopDeps: vi.fn(() => ({ someDep: true })),
    sendMessageStreaming: vi.fn(async function* () {
      yield { type: "text", text: "response" };
    }),
    resumeAfterApproval: vi.fn(async function* () {
      yield { type: "text", text: "resumed" };
    }),
    resetConversation: vi.fn(),
    events: {
      append: vi.fn(async () => {}),
      getLatestClock: vi.fn(async () => 0),
    },
    ...overrides,
  };
}

function makeInvoke(
  dbState: {
    goals?: Array<Record<string, unknown>>;
    outcomes?: Array<Record<string, unknown>>;
  } = {},
) {
  const goals = dbState.goals ?? [];
  const outcomes = dbState.outcomes ?? [];
  return vi.fn(async (cmd: string, args?: Record<string, unknown>): Promise<unknown> => {
    if (cmd === "db_query") {
      const sql = (args as { sql: string }).sql;
      if (sql.includes("FROM goals")) return goals;
      if (sql.includes("FROM goal_outcomes")) return outcomes;
      return [];
    }
    if (cmd === "db_execute") return 1;
    if (cmd === "goals_create") return undefined;
    return undefined;
  });
}

function makeDeps(overrides: Partial<GoalSchedulerDeps> = {}): GoalSchedulerDeps {
  return {
    getRuntime: () => makeRuntime(),
    getMotebitId: () => "motebit-1",
    getPlanEngine: () => null,
    getPlanStore: () => null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Basic lifecycle
// ---------------------------------------------------------------------------

describe("GoalScheduler lifecycle", () => {
  it("isGoalExecuting is false initially", () => {
    const s = new GoalScheduler(makeDeps());
    expect(s.isGoalExecuting).toBe(false);
  });

  it("start() + stop() are safe and idempotent", () => {
    const s = new GoalScheduler(makeDeps());
    const invoke = makeInvoke();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    s.start(invoke as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    s.start(invoke as any);
    s.stop();
    s.stop();
    expect(s.isGoalExecuting).toBe(false);
  });

  it("start is no-op when timer already set (idempotent)", () => {
    const s = new GoalScheduler(makeDeps());
    const invoke = makeInvoke();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    s.start(invoke as any);
    // Second start should early-return
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    s.start(invoke as any);
    s.stop();
  });
});

// ---------------------------------------------------------------------------
// Callback wiring
// ---------------------------------------------------------------------------

describe("GoalScheduler callbacks", () => {
  it("onGoalStatus stores callback (no emit here)", () => {
    const s = new GoalScheduler(makeDeps());
    const cb = vi.fn();
    s.onGoalStatus(cb);
    expect(cb).not.toHaveBeenCalled();
  });

  it("onGoalComplete stores callback", () => {
    const s = new GoalScheduler(makeDeps());
    s.onGoalComplete(vi.fn());
  });

  it("onGoalApproval stores callback", () => {
    const s = new GoalScheduler(makeDeps());
    s.onGoalApproval(vi.fn());
  });

  it("onGoalPlanProgress stores callback", () => {
    const s = new GoalScheduler(makeDeps());
    s.onGoalPlanProgress(vi.fn());
  });
});

// ---------------------------------------------------------------------------
// registerGoalTools
// ---------------------------------------------------------------------------

describe("GoalScheduler.registerGoalTools", () => {
  it("no-op when runtime is null", () => {
    const s = new GoalScheduler(makeDeps({ getRuntime: () => null }));
    const invoke = makeInvoke();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => s.registerGoalTools(invoke as any)).not.toThrow();
  });

  it("registers createSubGoal, completeGoal, reportProgress", () => {
    const runtime = makeRuntime();
    const s = new GoalScheduler(makeDeps({ getRuntime: () => runtime }));
    const invoke = makeInvoke();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    s.registerGoalTools(invoke as any);
    const reg = runtime.getToolRegistry();
    expect(reg.register).toHaveBeenCalledTimes(3);
  });

  it("createSubGoal returns error when no active goal context", async () => {
    const runtime = makeRuntime();
    const s = new GoalScheduler(makeDeps({ getRuntime: () => runtime }));
    const invoke = makeInvoke();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    s.registerGoalTools(invoke as any);
    const reg = runtime.getToolRegistry();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handler = (reg as any).tools[0].handler;
    const result = await handler({ prompt: "new goal" });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/No active goal context/);
  });

  it("completeGoal returns error when no active goal context", async () => {
    const runtime = makeRuntime();
    const s = new GoalScheduler(makeDeps({ getRuntime: () => runtime }));
    const invoke = makeInvoke();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    s.registerGoalTools(invoke as any);
    const reg = runtime.getToolRegistry();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handler = (reg as any).tools[1].handler;
    const result = await handler({ reason: "done" });
    expect(result.ok).toBe(false);
  });

  it("reportProgress returns error when no active goal context", async () => {
    const runtime = makeRuntime();
    const s = new GoalScheduler(makeDeps({ getRuntime: () => runtime }));
    const invoke = makeInvoke();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    s.registerGoalTools(invoke as any);
    const reg = runtime.getToolRegistry();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handler = (reg as any).tools[2].handler;
    const result = await handler({ note: "progress" });
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// goalTick via timer + start (single-turn path)
// ---------------------------------------------------------------------------

// We invoke private goalTick directly to sidestep fake-timer / setInterval
// interaction with the wall-clock deadline timer inside the tick.
describe("GoalScheduler goalTick (single-turn)", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("no-op when no active goals", async () => {
    const runtime = makeRuntime();
    const s = new GoalScheduler(makeDeps({ getRuntime: () => runtime }));
    const invoke = makeInvoke({ goals: [] });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (s as any).goalTick(invoke);
    expect(runtime.sendMessageStreaming).not.toHaveBeenCalled();
  });

  it("runs a one-time goal through single-turn executor + records outcome", async () => {
    const runtime = makeRuntime();
    const completed = vi.fn();
    const s = new GoalScheduler(makeDeps({ getRuntime: () => runtime }));
    s.onGoalComplete(completed);
    const invoke = makeInvoke({
      goals: [
        {
          goal_id: "g1",
          motebit_id: "motebit-1",
          prompt: "test goal",
          interval_ms: 1000,
          last_run_at: 0,
          enabled: 1,
          status: "active",
          mode: "once",
          parent_goal_id: null,
          max_retries: 3,
          consecutive_failures: 0,
        },
      ],
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (s as any).goalTick(invoke);
    expect(runtime.sendMessageStreaming).toHaveBeenCalled();
    expect(completed).toHaveBeenCalled();
    expect(completed.mock.calls[0]?.[0]?.status).toBe("completed");
  });

  it("skips a goal whose interval hasn't elapsed", async () => {
    const runtime = makeRuntime();
    const s = new GoalScheduler(makeDeps({ getRuntime: () => runtime }));
    const invoke = makeInvoke({
      goals: [
        {
          goal_id: "g1",
          motebit_id: "motebit-1",
          prompt: "test",
          interval_ms: 3600000, // 1h
          last_run_at: Date.now(),
          enabled: 1,
          status: "active",
          mode: "recurring",
          parent_goal_id: null,
          max_retries: 3,
          consecutive_failures: 0,
        },
      ],
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (s as any).goalTick(invoke);
    expect(runtime.sendMessageStreaming).not.toHaveBeenCalled();
    s.stop();
  });

  it("records failure when runtime streaming throws", async () => {
    const runtime = makeRuntime({
      // eslint-disable-next-line require-yield
      sendMessageStreaming: vi.fn(async function* () {
        throw new Error("runtime error");
      }),
    });
    const completed = vi.fn();
    const s = new GoalScheduler(makeDeps({ getRuntime: () => runtime }));
    s.onGoalComplete(completed);
    const invoke = makeInvoke({
      goals: [
        {
          goal_id: "g1",
          motebit_id: "motebit-1",
          prompt: "fail me",
          interval_ms: 1000,
          last_run_at: 0,
          enabled: 1,
          status: "active",
          mode: "once",
          parent_goal_id: null,
          max_retries: 3,
          consecutive_failures: 0,
        },
      ],
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (s as any).goalTick(invoke);
    expect(completed).toHaveBeenCalled();
    expect(completed.mock.calls[0]?.[0]?.status).toBe("failed");
    s.stop();
  });

  it("skips ticks when runtime.isProcessing is true", async () => {
    const runtime = makeRuntime({ isProcessing: true });
    const s = new GoalScheduler(makeDeps({ getRuntime: () => runtime }));
    const invoke = makeInvoke({
      goals: [
        {
          goal_id: "g1",
          motebit_id: "motebit-1",
          prompt: "test",
          interval_ms: 1000,
          last_run_at: 0,
          enabled: 1,
          status: "active",
          mode: "once",
          parent_goal_id: null,
          max_retries: 3,
          consecutive_failures: 0,
        },
      ],
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (s as any).goalTick(invoke);
    expect(runtime.sendMessageStreaming).not.toHaveBeenCalled();
    s.stop();
  });
});

// ---------------------------------------------------------------------------
// resumeGoalAfterApproval
// ---------------------------------------------------------------------------

describe("GoalScheduler.resumeGoalAfterApproval", () => {
  it("throws when no pending approval", async () => {
    const s = new GoalScheduler(makeDeps());
    const gen = s.resumeGoalAfterApproval(true);
    await expect(gen.next()).rejects.toThrow(/No pending goal approval/);
  });

  it("throws when runtime is null", async () => {
    const s = new GoalScheduler(makeDeps({ getRuntime: () => null }));
    const gen = s.resumeGoalAfterApproval(true);
    await expect(gen.next()).rejects.toThrow(/AI not initialized/);
  });
});

// ---------------------------------------------------------------------------
// createSubGoal with active goal context (via _currentGoalId setter trick)
// ---------------------------------------------------------------------------

describe("GoalScheduler goal-management tools (active context)", () => {
  it("createSubGoal calls goals_create when in-context", async () => {
    const runtime = makeRuntime();
    const s = new GoalScheduler(makeDeps({ getRuntime: () => runtime }));
    const invoke = makeInvoke();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    s.registerGoalTools(invoke as any);
    // Force active context
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (s as any)._currentGoalId = "parent-goal";
    const reg = runtime.getToolRegistry();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handler = (reg as any).tools[0].handler;
    const result = await handler({ prompt: "child goal", interval: "1h", once: false });
    expect(result.ok).toBe(true);
    expect(invoke).toHaveBeenCalledWith(
      "goals_create",
      expect.objectContaining({ prompt: "child goal" }),
    );
  });

  it("createSubGoal propagates db errors", async () => {
    const runtime = makeRuntime();
    const s = new GoalScheduler(makeDeps({ getRuntime: () => runtime }));
    const invoke = vi.fn(async (cmd: string) => {
      if (cmd === "goals_create") throw new Error("db error");
      return 1;
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    s.registerGoalTools(invoke as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (s as any)._currentGoalId = "parent-goal";
    const reg = runtime.getToolRegistry();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handler = (reg as any).tools[0].handler;
    const result = await handler({ prompt: "p" });
    expect(result.ok).toBe(false);
  });

  it("completeGoal happy path calls db_execute + events.append", async () => {
    const runtime = makeRuntime();
    const s = new GoalScheduler(makeDeps({ getRuntime: () => runtime }));
    const invoke = makeInvoke();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    s.registerGoalTools(invoke as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (s as any)._currentGoalId = "g1";
    const reg = runtime.getToolRegistry();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handler = (reg as any).tools[1].handler;
    const result = await handler({ reason: "done" });
    expect(result.ok).toBe(true);
    expect(runtime.events.append).toHaveBeenCalled();
  });

  it("reportProgress returns error if runtime goes null after registration", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let rt: any = makeRuntime();
    const s = new GoalScheduler(makeDeps({ getRuntime: () => rt }));
    const invoke = makeInvoke();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    s.registerGoalTools(invoke as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (s as any)._currentGoalId = "g1";
    const reg = rt!.getToolRegistry();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handler = (reg as any).tools[2].handler;
    rt = null;
    const result = await handler({ note: "n" });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Runtime not initialized/);
  });
});
