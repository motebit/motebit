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
    getSpentTokens: vi.fn((_id: string) => 0),
  };
}

function makeRuntime(overrides?: Record<string, unknown>) {
  return {
    isProcessing: false,
    consolidationCycle: vi.fn(() => Promise.resolve()),
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

  it("stop calls consolidationCycle on runtime", () => {
    const deps = makeDeps();
    const sched = new MobileGoalScheduler(deps);
    sched.start();
    sched.stop();
    expect(deps._runtime.consolidationCycle).toHaveBeenCalled();
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

describe("MobileGoalScheduler budget envelope", () => {
  it("skips fire and flips status to budget_exhausted when spent >= cap (pre-fire gate)", async () => {
    const deps = makeDeps();
    deps._goalStore.setActive([
      {
        goal_id: "g-cap",
        prompt: "x",
        mode: "recurring",
        interval_ms: 1000,
        last_run_at: null,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        budget_tokens: 1000,
      } as any,
    ]);
    deps._goalStore.getSpentTokens = vi.fn(() => 1500);
    const sched = new MobileGoalScheduler(deps);
    sched.start();
    await vi.advanceTimersByTimeAsync(6000);
    sched.stop();
    await vi.runAllTimersAsync().catch(() => {});
    expect(deps._goalStore.setStatus).toHaveBeenCalledWith("g-cap", "budget_exhausted");
    expect(deps._goalStore.insertOutcome).not.toHaveBeenCalled();
  });

  it("flips status to budget_exhausted post-fire when this run crosses the cap", async () => {
    const deps = makeDeps();
    deps._goalStore.setActive([
      {
        goal_id: "g-cross",
        prompt: "x",
        mode: "recurring",
        interval_ms: 1000,
        last_run_at: null,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        budget_tokens: 1000,
      } as any,
    ]);
    deps._goalStore.getSpentTokens = vi
      .fn()
      .mockReturnValueOnce(500) // pre-fire: under cap → proceed
      .mockReturnValueOnce(1200); // post-fire: crossed → flip
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (deps._runtime as any).sendMessageStreaming = vi.fn(async function* () {
      yield { type: "text", text: "done" };
      yield { type: "result", result: { totalTokens: 700 } };
    });
    const sched = new MobileGoalScheduler(deps);
    sched.start();
    await vi.advanceTimersByTimeAsync(6000);
    sched.stop();
    await vi.runAllTimersAsync().catch(() => {});
    expect(deps._goalStore.insertOutcome).toHaveBeenCalled();
    expect(deps._goalStore.setStatus).toHaveBeenCalledWith("g-cross", "budget_exhausted");
    // Outcome row carries the per-fire token count from the runtime result chunk
    const inserted = deps._goalStore.outcomes[0] as { tokens_used: number | null };
    expect(inserted.tokens_used).toBe(700);
  });
});

describe("MobileGoalScheduler executeSingleTurnGoal context", () => {
  it("renders all three outcome-history branches (failure-with-error / summary-present / summary-absent)", async () => {
    const deps = makeDeps();
    const now = Date.now();
    deps._goalStore.getRecentOutcomes = vi.fn(() => [
      {
        ran_at: now - 60_000,
        status: "completed",
        summary: "found 3 results",
        error_message: null,
      },
      { ran_at: now - 3_600_000, status: "failed", summary: null, error_message: "timeout" },
      { ran_at: now - 86_400_000, status: "completed", summary: "", error_message: null },
    ]);
    deps._goalStore.setActive([
      {
        goal_id: "g-ctx",
        prompt: "research X",
        mode: "recurring",
        interval_ms: 1000,
        last_run_at: null,
      },
    ]);
    let capturedContext = "";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (deps._runtime as any).sendMessageStreaming = vi.fn(async function* (ctx: string) {
      capturedContext = ctx;
      yield { type: "text", text: "ok" };
    });
    const sched = new MobileGoalScheduler(deps);
    sched.start();
    await vi.advanceTimersByTimeAsync(6000);
    sched.stop();
    await vi.runAllTimersAsync().catch(() => {});
    expect(capturedContext).toContain("Previous executions");
    // Branch 1: failed + error_message non-empty
    expect(capturedContext).toMatch(/failed — \[error: timeout\]/);
    // Branch 2: summary non-empty
    expect(capturedContext).toContain('completed — "found 3 results"');
    // Branch 3: else (summary empty/null, not failed) — no quoted summary, no error tag
    expect(capturedContext).toMatch(/d ago: completed(?!\s+—)/);
  });
});

describe("MobileGoalScheduler signed artifact manifest", () => {
  it("records signer-returned manifest as JSON in signed_manifest", async () => {
    const deps = makeDeps();
    const manifest = { producer: "did:key:motebit:test", type: "goal-result" };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (deps._runtime as any).signGoalArtifact = vi.fn(async () => manifest);
    deps._goalStore.setActive([
      {
        goal_id: "g-sign",
        prompt: "x",
        mode: "recurring",
        interval_ms: 1000,
        last_run_at: null,
      },
    ]);
    const sched = new MobileGoalScheduler(deps);
    sched.start();
    await vi.advanceTimersByTimeAsync(6000);
    sched.stop();
    await vi.runAllTimersAsync().catch(() => {});
    const inserted = deps._goalStore.outcomes[0] as { signed_manifest: string | null };
    expect(inserted.signed_manifest).toBe(JSON.stringify(manifest));
  });

  it("records null signed_manifest when signer returns null (calm-software degradation)", async () => {
    const deps = makeDeps();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (deps._runtime as any).signGoalArtifact = vi.fn(async () => null);
    deps._goalStore.setActive([
      {
        goal_id: "g-nosign",
        prompt: "x",
        mode: "recurring",
        interval_ms: 1000,
        last_run_at: null,
      },
    ]);
    const sched = new MobileGoalScheduler(deps);
    sched.start();
    await vi.advanceTimersByTimeAsync(6000);
    sched.stop();
    await vi.runAllTimersAsync().catch(() => {});
    const inserted = deps._goalStore.outcomes[0] as { signed_manifest: string | null };
    expect(inserted.signed_manifest).toBeNull();
  });
});

describe("MobileGoalScheduler finishGoalFailure error swallowing", () => {
  it("swallows insertOutcome + incrementFailures throws (non-fatal) and still fires completion event", async () => {
    const deps = makeDeps();
    deps._goalStore.insertOutcome = vi.fn(() => {
      throw new Error("db locked");
    });
    deps._goalStore.incrementFailures = vi.fn(() => {
      throw new Error("db locked");
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (deps._runtime as any).sendMessageStreaming = vi.fn(async function* () {
      throw new Error("upstream provider down");
      // eslint-disable-next-line no-unreachable
      yield { type: "text", text: "never" };
    });
    deps._goalStore.setActive([
      {
        goal_id: "g-fail",
        prompt: "x",
        mode: "recurring",
        interval_ms: 1000,
        last_run_at: null,
      },
    ]);
    const completeEvents: Array<{ status: string }> = [];
    const sched = new MobileGoalScheduler(deps);
    sched.onGoalComplete((e) => completeEvents.push(e));
    sched.start();
    await vi.advanceTimersByTimeAsync(6000);
    sched.stop();
    await vi.runAllTimersAsync().catch(() => {});
    expect(completeEvents.length).toBe(1);
    expect(completeEvents[0]?.status).toBe("failed");
  });
});
