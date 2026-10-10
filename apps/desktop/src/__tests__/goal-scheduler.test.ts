import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock @motebit/tools/web-safe: we only need the goal-management defs
// ---------------------------------------------------------------------------

vi.mock("@motebit/tools/web-safe", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@motebit/tools/web-safe");
  return actual;
});

import { GoalScheduler } from "../goal-scheduler";
import { createGoalRun } from "@motebit/runtime";
import type { GoalRunGoal } from "@motebit/runtime";
import { SensitivityLevel } from "@motebit/sdk";

/** A goal run on a runtime at the default tier with no gate (the mock runtime). */
function passthroughRun(goal: GoalRunGoal) {
  return createGoalRun({
    goal,
    effective: () => SensitivityLevel.None,
    raise: () => () => {},
    assert: () => {},
  });
}
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
    beginGoalRun: vi.fn((goal: GoalRunGoal) => passthroughRun(goal)),
    goalCreationSensitivity: vi.fn(() => SensitivityLevel.Personal),
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
    goals: {
      created: vi.fn(async () => {}),
      executed: vi.fn(async () => {}),
      progress: vi.fn(async () => {}),
      completed: vi.fn(async () => {}),
      removed: vi.fn(async () => {}),
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
// runNow — user-driven bypass-cadence fire (shares executeGoalOnce with
// goalTick, so the important coverage is the precondition / dispatch
// semantics that only this entry point has).
// ---------------------------------------------------------------------------

describe("GoalScheduler.runNow", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("fires the goal through the same execute path regardless of interval", async () => {
    const runtime = makeRuntime();
    const completed = vi.fn();
    const s = new GoalScheduler(makeDeps({ getRuntime: () => runtime }));
    s.onGoalComplete(completed);
    // interval is 1h, last_run_at is now — goalTick would skip, runNow must not.
    const invoke = makeInvoke({
      goals: [
        {
          goal_id: "g1",
          motebit_id: "motebit-1",
          prompt: "run me",
          interval_ms: 3_600_000,
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
    await s.runNow(invoke as any, "g1");
    expect(runtime.sendMessageStreaming).toHaveBeenCalled();
    expect(completed).toHaveBeenCalled();
    expect(completed.mock.calls[0]?.[0]?.status).toBe("completed");
  });

  it("#885: a payment_notice from the run leads the outcome summary and the completion event", async () => {
    const runtime = makeRuntime({
      sendMessageStreaming: vi.fn(async function* () {
        yield {
          type: "payment_notice",
          notice: "This hire's wallet ALSO sent another payment (tx sigAAAAAAAAAAAA, landed)",
          extra_payments: [{ tx_hash: "sigAAAAAAAAAAAA", status: "landed" }],
        };
        yield { type: "text", text: "the goal's answer" };
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
          prompt: "hire",
          interval_ms: 3_600_000,
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
    await s.runNow(invoke as any, "g1");
    const insert = invoke.mock.calls.find(
      ([cmd, a]) =>
        cmd === "db_execute" &&
        String((a as { sql: string }).sql).includes("INTO goal_outcomes") &&
        String((a as { sql: string }).sql).includes("'completed'"),
    );
    const params = (insert?.[1] as { params: unknown[] }).params;
    expect(String(params[4])).toMatch(/^Your wallet also sent another payment/); // summary
    expect(String(params[7])).toBe("the goal's answer"); // response_full: the model's text alone
    expect(completed.mock.calls[0]?.[0]?.summary).toMatch(/^Your wallet also sent another payment/);
  });

  it("silently no-ops when another goal is executing", async () => {
    const runtime = makeRuntime();
    const s = new GoalScheduler(makeDeps({ getRuntime: () => runtime }));
    // Force _goalExecuting = true
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (s as any)._goalExecuting = true;
    const invoke = makeInvoke({
      goals: [
        {
          goal_id: "g1",
          motebit_id: "motebit-1",
          prompt: "blocked",
          interval_ms: 1000,
          last_run_at: 0,
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
    await s.runNow(invoke as any, "g1");
    expect(runtime.sendMessageStreaming).not.toHaveBeenCalled();
  });

  it("silently no-ops when runtime.isProcessing is true", async () => {
    const runtime = makeRuntime({ isProcessing: true });
    const s = new GoalScheduler(makeDeps({ getRuntime: () => runtime }));
    const invoke = makeInvoke({
      goals: [
        {
          goal_id: "g1",
          motebit_id: "motebit-1",
          prompt: "blocked",
          interval_ms: 1000,
          last_run_at: 0,
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
    await s.runNow(invoke as any, "g1");
    expect(runtime.sendMessageStreaming).not.toHaveBeenCalled();
  });

  it("throws when goal is not found", async () => {
    const runtime = makeRuntime();
    const s = new GoalScheduler(makeDeps({ getRuntime: () => runtime }));
    const invoke = makeInvoke({ goals: [] });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(s.runNow(invoke as any, "missing")).rejects.toThrow(/not found/);
  });

  it("does not run paused / completed / failed goals (lifecycle guard)", async () => {
    const runtime = makeRuntime();
    const s = new GoalScheduler(makeDeps({ getRuntime: () => runtime }));
    const invoke = makeInvoke({
      goals: [
        {
          goal_id: "g1",
          motebit_id: "motebit-1",
          prompt: "paused",
          interval_ms: 1000,
          last_run_at: 0,
          enabled: 0,
          status: "paused",
          mode: "recurring",
          parent_goal_id: null,
          max_retries: 3,
          consecutive_failures: 0,
        },
      ],
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await s.runNow(invoke as any, "g1");
    expect(runtime.sendMessageStreaming).not.toHaveBeenCalled();
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

  it("completeGoal happy path emits via runtime.goals.completed + db_execute", async () => {
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
    expect(runtime.goals.completed).toHaveBeenCalledWith({ goal_id: "g1", reason: "done" });
    expect(invoke).toHaveBeenCalledWith(
      "db_execute",
      expect.objectContaining({
        sql: expect.stringContaining("UPDATE goals SET status = 'completed'"),
      }),
    );
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

// ---------------------------------------------------------------------------
// #890 — an unknown paid outcome never re-fires into a second payment
// ---------------------------------------------------------------------------

describe("#890: a goal whose last run left a paid outcome unknown", () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  const due = {
    goal_id: "g890",
    motebit_id: "motebit-1",
    prompt: "buy the report",
    interval_ms: 1000,
    last_run_at: 0,
    enabled: 1,
    status: "active",
    mode: "recurring",
    parent_goal_id: null,
    max_retries: 1,
    consecutive_failures: 0,
  };
  const owedEntry = (recordedAt: number) => ({
    workerMotebitId: "worker-a",
    capability: "research",
    taskId: "task-owed",
    txHash: "tx",
    paidMicro: 1000,
    feeMicro: 50,
    recordedAt,
  });

  it("PROBE: a run that paid and then died (no final outcome) holds the goal in the next process", async () => {
    // A stateful goal_outcomes table shared by both "processes".
    const rows = new Map<string, { ran_at: number; status: string }>();
    const invoke = vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
      const { sql, params } = (args ?? {}) as { sql: string; params: unknown[] };
      if (cmd === "db_query") {
        if (sql.includes("FROM goals")) return [due];
        if (sql.includes("FROM goal_outcomes")) {
          return [...rows.values()].sort((a, b) => b.ran_at - a.ran_at);
        }
        return [];
      }
      if (cmd === "db_execute" && sql.includes("INTO goal_outcomes")) {
        rows.set(String(params[0]), { ran_at: Number(params[3]), status: "row" });
      }
      return 1;
    });
    const owed: unknown[] = [];
    let turns = 0;
    const dying = makeRuntime({
      outstandingPaidResults: () => owed,
      // eslint-disable-next-line require-yield
      sendMessageStreaming: vi.fn(async function* () {
        turns++;
        owed.push(owedEntry(Date.now())); // the hire paid…
        await new Promise<void>(() => {}); // …and the process died
      }),
    });
    const first = new GoalScheduler(makeDeps({ getRuntime: () => dying }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    void (first as any).goalTick(invoke);
    await vi.waitFor(() => expect(turns).toBe(1));

    const next = makeRuntime({ outstandingPaidResults: () => owed });
    const second = new GoalScheduler(makeDeps({ getRuntime: () => next }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (second as any).goalTick(invoke);
    expect(next.sendMessageStreaming).not.toHaveBeenCalled();
  });

  it("is held while a payment made during that run is still owed its result", async () => {
    const runtime = makeRuntime({ outstandingPaidResults: () => [owedEntry(1_500)] });
    const s = new GoalScheduler(makeDeps({ getRuntime: () => runtime }));
    const invoke = makeInvoke({ goals: [due], outcomes: [{ ran_at: 1_000 }] });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (s as any).goalTick(invoke);
    expect(runtime.sendMessageStreaming).not.toHaveBeenCalled();
  });

  it("fires when the owed payment was recorded before the goal's runs", async () => {
    const runtime = makeRuntime({ outstandingPaidResults: () => [owedEntry(500)] });
    const s = new GoalScheduler(makeDeps({ getRuntime: () => runtime }));
    const invoke = makeInvoke({ goals: [due], outcomes: [{ ran_at: 1_000 }] });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (s as any).goalTick(invoke);
    expect(runtime.sendMessageStreaming).toHaveBeenCalled();
  });

  it("r3 finding 3: a run that paid AFTER overrunning its wall clock still holds the goal", async () => {
    // The abort is cooperative: a hire in flight at the deadline completes,
    // and the ledger stamps it after the 10-minute mark.
    const runtime = makeRuntime({
      outstandingPaidResults: () => [owedEntry(1_000 + 11 * 60 * 1000)],
    });
    const s = new GoalScheduler(makeDeps({ getRuntime: () => runtime }));
    const invoke = makeInvoke({ goals: [due], outcomes: [{ ran_at: 1_000 }] });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (s as any).goalTick(invoke);
    expect(runtime.sendMessageStreaming).not.toHaveBeenCalled();
  });

  it('r3 finding 2: "Run now" honours the owed-payment hold too', async () => {
    const runtime = makeRuntime({ outstandingPaidResults: () => [owedEntry(1_500)] });
    const s = new GoalScheduler(makeDeps({ getRuntime: () => runtime }));
    const invoke = makeInvoke({ goals: [due], outcomes: [{ ran_at: 1_000 }] });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (s as any).goalTick(invoke);
    expect(runtime.sendMessageStreaming).not.toHaveBeenCalled();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await s.runNow(invoke as any, "g890");
    expect(runtime.sendMessageStreaming).not.toHaveBeenCalled();
  });

  it("r3: a run whose start cannot be recorded does not run (fail-closed)", async () => {
    const runtime = makeRuntime({ outstandingPaidResults: () => [] });
    const s = new GoalScheduler(makeDeps({ getRuntime: () => runtime }));
    const base = makeInvoke({ goals: [due] });
    const invoke = vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "db_execute" && String((args as { sql: string }).sql).includes("'running'")) {
        throw new Error("database is locked");
      }
      return base(cmd, args);
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (s as any).goalTick(invoke);
    expect(runtime.sendMessageStreaming).not.toHaveBeenCalled();
  });

  function planDeps(stream: () => AsyncGenerator<unknown>, createThrows?: Error) {
    const runtime = makeRuntime();
    const engine = {
      createPlan: vi.fn(async () => {
        if (createThrows) throw createThrows;
        return { plan: { plan_id: "p1", title: "Hire", total_steps: 1 } };
      }),
      executePlan: vi.fn(stream),
      resumePlan: vi.fn(stream),
    };
    const store = { getPlanForGoal: vi.fn(() => null), updatePlan: vi.fn() };
    return {
      runtime,
      engine,
      deps: makeDeps({
        getRuntime: () => runtime,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        getPlanEngine: () => engine as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        getPlanStore: () => store as any,
      }),
    };
  }

  function sqlOf(invoke: ReturnType<typeof makeInvoke>): string[] {
    return invoke.mock.calls
      .filter((c) => c[0] === "db_execute")
      .map((c) => (c[1] as { sql: string }).sql);
  }

  it("a plan_undetermined run is recorded `partial`, never counted as a failure or auto-paused", async () => {
    const { deps } = planDeps(async function* () {
      yield {
        type: "plan_undetermined",
        plan: { plan_id: "p1" },
        step: { step_id: "s1", description: "remote work" },
        reason: "Submission unconfirmed — the task may still complete; check /result",
      };
    });
    const completed = vi.fn();
    const s = new GoalScheduler(deps);
    s.onGoalComplete(completed);
    const invoke = makeInvoke({ goals: [due] });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (s as any).goalTick(invoke);

    const sql = sqlOf(invoke);
    expect(sql.some((q) => q.includes("'partial'"))).toBe(true);
    expect(sql.some((q) => q.includes("consecutive_failures + 1"))).toBe(false);
    expect(sql.some((q) => q.includes("status = 'paused'"))).toBe(false);
    expect(completed.mock.calls[0]?.[0]?.status).toBe("awaiting_result");
  });

  it("r3: a plan_busy run (another driver holds the plan) is not a failure", async () => {
    const { deps } = planDeps(async function* () {
      yield { type: "plan_busy", plan: { plan_id: "p1" } };
    });
    const completed = vi.fn();
    const s = new GoalScheduler(deps);
    s.onGoalComplete(completed);
    const invoke = makeInvoke({ goals: [due] });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (s as any).goalTick(invoke);
    expect(sqlOf(invoke).some((q) => q.includes("consecutive_failures + 1"))).toBe(false);
    expect(completed.mock.calls[0]?.[0]?.status).toBe("awaiting_result");
  });

  it("a plan refused because the goal holds an undetermined step is not a failure either", async () => {
    const refused = Object.assign(new Error("Submission unconfirmed"), { undetermined: true });
    // eslint-disable-next-line require-yield
    const { deps } = planDeps(async function* () {
      throw new Error("unreachable");
    }, refused);
    const completed = vi.fn();
    const s = new GoalScheduler(deps);
    s.onGoalComplete(completed);
    const invoke = makeInvoke({ goals: [due] });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (s as any).goalTick(invoke);

    expect(sqlOf(invoke).some((q) => q.includes("consecutive_failures + 1"))).toBe(false);
    expect(completed.mock.calls[0]?.[0]?.status).toBe("awaiting_result");
  });
});
