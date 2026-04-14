import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// @motebit/sdk — keep real PlanStatus enum
// ---------------------------------------------------------------------------

import { MobileGoalScheduler } from "../goal-scheduler";
import type { GoalSchedulerDeps } from "../goal-scheduler";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function makeGoalStore() {
  const outcomes: unknown[] = [];
  const lastRun = new Map<string, number>();
  const failures = new Map<string, number>();
  const statuses = new Map<string, string>();
  let active: Array<{
    goal_id: string;
    prompt: string;
    mode: string;
    interval_ms: number;
    last_run_at: number | null;
  }> = [];

  return {
    outcomes,
    lastRun,
    failures,
    statuses,
    setActive(list: typeof active) {
      active = list;
    },
    listActiveGoals: vi.fn(() => active),
    getRecentOutcomes: vi.fn(() => []),
    updateLastRun: vi.fn((id: string, t: number) => lastRun.set(id, t)),
    resetFailures: vi.fn((id: string) => failures.set(id, 0)),
    incrementFailures: vi.fn((id: string) => failures.set(id, (failures.get(id) ?? 0) + 1)),
    setStatus: vi.fn((id: string, status: string) => statuses.set(id, status)),
    insertOutcome: vi.fn((o: unknown) => outcomes.push(o)),
  };
}

function makeRuntime(overrides?: Record<string, unknown>) {
  return {
    isProcessing: false,
    housekeeping: vi.fn(() => Promise.resolve()),
    resetConversation: vi.fn(),
    getLoopDeps: vi.fn(() => null),
    getToolRegistry: vi.fn(() => ({ list: () => [] })),
    sendMessageStreaming: vi.fn(async function* () {
      yield { type: "text", text: "hello" };
    }),
    resumeAfterApproval: vi.fn(async function* () {
      yield { type: "text", text: "resumed " };
    }),
    ...overrides,
  };
}

function makeDeps(overrides?: Partial<GoalSchedulerDeps>): GoalSchedulerDeps & {
  _goalStore: ReturnType<typeof makeGoalStore>;
  _runtime: ReturnType<typeof makeRuntime>;
} {
  const goalStore = makeGoalStore();
  const runtime = makeRuntime();
  const storage = {
    goalStore,
    planStore: {
      getPlanForGoal: vi.fn(() => null),
    },
  };
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getRuntime: () => runtime as any,
    getMotebitId: () => "mote-1",
    getPlanEngine: () => null,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getStorage: () => storage as any,
    _goalStore: goalStore,
    _runtime: runtime,
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("MobileGoalScheduler basics", () => {
  it("constructs with idle state", () => {
    const sched = new MobileGoalScheduler(makeDeps());
    expect(sched.isGoalExecuting).toBe(false);
    expect(sched.currentGoalId).toBeNull();
  });

  it("getGoalStore returns store when storage available", () => {
    const deps = makeDeps();
    const sched = new MobileGoalScheduler(deps);
    expect(sched.getGoalStore()).toBe(deps._goalStore);
  });

  it("getGoalStore returns null when storage null", () => {
    const sched = new MobileGoalScheduler(makeDeps({ getStorage: () => null }));
    expect(sched.getGoalStore()).toBeNull();
  });

  it("subscribes callbacks", () => {
    const sched = new MobileGoalScheduler(makeDeps());
    sched.onGoalStatus(() => {});
    sched.onGoalComplete(() => {});
    sched.onGoalApproval(() => {});
  });
});

describe("MobileGoalScheduler start/stop", () => {
  it("start is idempotent", () => {
    const sched = new MobileGoalScheduler(makeDeps());
    sched.start();
    sched.start();
    sched.stop();
  });

  it("stop without start does not throw", () => {
    const sched = new MobileGoalScheduler(makeDeps());
    sched.stop();
  });

  it("stop calls housekeeping on runtime", () => {
    const deps = makeDeps();
    const sched = new MobileGoalScheduler(deps);
    sched.start();
    sched.stop();
    expect(deps._runtime.housekeeping).toHaveBeenCalled();
  });
});

describe("MobileGoalScheduler.goalTick (via start)", () => {
  it("runs a single-turn goal and records success", async () => {
    const deps = makeDeps();
    deps._goalStore.setActive([
      {
        goal_id: "g1",
        prompt: "do the thing",
        mode: "recurring",
        interval_ms: 1000,
        last_run_at: null,
      },
    ]);

    const statusChanges: boolean[] = [];
    const sched = new MobileGoalScheduler(deps);
    sched.onGoalStatus((b) => statusChanges.push(b));
    const completeEvents: unknown[] = [];
    sched.onGoalComplete((e) => completeEvents.push(e));

    sched.start();
    // Advance past the 5s initial delay
    await vi.advanceTimersByTimeAsync(6000);
    // Stop before draining — under heavy concurrent load (full-monorepo
    // turbo run) the scheduler's own rescheduled tick re-triggers
    // runAllTimersAsync indefinitely and exhausts the 5s test timeout.
    // In isolation the machine is fast enough that it drains before the
    // next tick fires; in CI/pre-push it doesn't.
    sched.stop();
    await vi.runAllTimersAsync().catch(() => {});

    expect(deps._goalStore.updateLastRun).toHaveBeenCalled();
    expect(deps._goalStore.insertOutcome).toHaveBeenCalled();
    expect(completeEvents.length).toBeGreaterThan(0);
  });

  it("skips goals before interval elapsed", async () => {
    const deps = makeDeps();
    deps._goalStore.setActive([
      {
        goal_id: "g1",
        prompt: "x",
        mode: "recurring",
        interval_ms: 1_000_000,
        last_run_at: Date.now(),
      },
    ]);
    const sched = new MobileGoalScheduler(deps);
    sched.start();
    await vi.advanceTimersByTimeAsync(6000);
    expect(deps._goalStore.updateLastRun).not.toHaveBeenCalled();
    sched.stop();
  });

  it("records failure and increments failure count on error", async () => {
    const deps = makeDeps();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (deps._runtime as any).sendMessageStreaming = vi.fn(async function* () {
      throw new Error("provider down");
      // eslint-disable-next-line no-unreachable
      yield { type: "text", text: "never" };
    });
    deps._goalStore.setActive([
      {
        goal_id: "g1",
        prompt: "x",
        mode: "recurring",
        interval_ms: 1000,
        last_run_at: null,
      },
    ]);
    const sched = new MobileGoalScheduler(deps);
    sched.start();
    await vi.advanceTimersByTimeAsync(6000);
    // Stop before draining — see note on sibling test.
    sched.stop();
    await vi.runAllTimersAsync().catch(() => {});
    expect(deps._goalStore.incrementFailures).toHaveBeenCalled();
  });

  it("marks once-mode goals as completed", async () => {
    const deps = makeDeps();
    deps._goalStore.setActive([
      {
        goal_id: "once-1",
        prompt: "one shot",
        mode: "once",
        interval_ms: 0,
        last_run_at: null,
      },
    ]);
    const sched = new MobileGoalScheduler(deps);
    sched.start();
    await vi.advanceTimersByTimeAsync(6000);
    // Stop before draining — see note on earlier sibling tests.
    sched.stop();
    await vi.runAllTimersAsync().catch(() => {});
    expect(deps._goalStore.setStatus).toHaveBeenCalledWith("once-1", "completed");
  });

  it("suspends on approval_request and records approval event", async () => {
    const deps = makeDeps();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (deps._runtime as any).sendMessageStreaming = vi.fn(async function* () {
      yield {
        type: "approval_request",
        name: "web_search",
        args: { query: "x" },
        risk_level: 3,
      };
    });
    deps._goalStore.setActive([
      {
        goal_id: "g-sus",
        prompt: "search",
        mode: "recurring",
        interval_ms: 1000,
        last_run_at: null,
      },
    ]);
    const approvalEvents: unknown[] = [];
    const sched = new MobileGoalScheduler(deps);
    sched.onGoalApproval((e) => approvalEvents.push(e));
    sched.start();
    await vi.advanceTimersByTimeAsync(6000);
    // Stop before draining — see note on earlier sibling tests.
    sched.stop();
    await vi.runAllTimersAsync().catch(() => {});
    expect(approvalEvents.length).toBe(1);
    expect(sched.isGoalExecuting).toBe(true);
  });

  it("skips tick when runtime is already processing", async () => {
    const deps = makeDeps();
    deps._runtime.isProcessing = true;
    deps._goalStore.setActive([
      {
        goal_id: "g-busy",
        prompt: "x",
        mode: "recurring",
        interval_ms: 1000,
        last_run_at: null,
      },
    ]);
    const sched = new MobileGoalScheduler(deps);
    sched.start();
    await vi.advanceTimersByTimeAsync(6000);
    expect(deps._goalStore.listActiveGoals).not.toHaveBeenCalled();
    sched.stop();
  });

  it("no-op tick when runtime is null", async () => {
    const sched = new MobileGoalScheduler(makeDeps({ getRuntime: () => null }));
    sched.start();
    await vi.advanceTimersByTimeAsync(6000);
    sched.stop();
  });
});

describe("MobileGoalScheduler.resumeGoalAfterApproval", () => {
  it("throws when runtime is missing", async () => {
    const sched = new MobileGoalScheduler(makeDeps({ getRuntime: () => null }));
    const gen = sched.resumeGoalAfterApproval(true);
    await expect(gen.next()).rejects.toThrow(/AI not initialized/);
  });

  it("throws when there is no pending approval", async () => {
    const sched = new MobileGoalScheduler(makeDeps());
    const gen = sched.resumeGoalAfterApproval(true);
    await expect(gen.next()).rejects.toThrow(/No pending/);
  });
});
