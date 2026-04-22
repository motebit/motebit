/**
 * GoalsRunner unit tests. Covers the daemon-role primitive used by web.
 */
import { describe, it, expect, vi } from "vitest";

import { createGoalsRunner } from "../runner.js";
import type { GoalFireResult, GoalRunRecord, ScheduledGoal } from "../types.js";

interface Stores {
  goals: ScheduledGoal[];
  runs: GoalRunRecord[];
}

function makeAdapter(
  fire: (goal: ScheduledGoal) => Promise<GoalFireResult>,
  initial: Partial<Stores> = {},
): {
  adapter: Parameters<typeof createGoalsRunner>[0];
  stores: Stores;
  fireCalls: ScheduledGoal[];
} {
  const stores: Stores = {
    goals: initial.goals ?? [],
    runs: initial.runs ?? [],
  };
  const fireCalls: ScheduledGoal[] = [];
  return {
    stores,
    fireCalls,
    adapter: {
      loadGoals: () => stores.goals,
      saveGoals: (g) => {
        stores.goals = g;
      },
      loadRuns: () => stores.runs,
      saveRuns: (r) => {
        stores.runs = r;
      },
      async fire(goal) {
        fireCalls.push(goal);
        return fire(goal);
      },
    },
  };
}

describe("createGoalsRunner — addGoal", () => {
  it("creates a recurring goal with next_run_at = created_at + interval", () => {
    const { adapter, stores } = makeAdapter(async () => ({ outcome: "fired" }));
    const runner = createGoalsRunner(adapter, {
      now: () => 1_000,
      generateId: () => "g1",
    });
    const goal = runner.addGoal({
      prompt: "hi",
      mode: "recurring",
      cadence: "hourly",
    });
    expect(goal.mode).toBe("recurring");
    expect(goal.interval_ms).toBe(3_600_000);
    expect(goal.next_run_at).toBe(1_000 + 3_600_000);
    expect(stores.goals).toHaveLength(1);
  });

  it("creates a once goal without next_run_at (requires explicit runNow)", () => {
    const { adapter } = makeAdapter(async () => ({ outcome: "fired" }));
    const runner = createGoalsRunner(adapter, {
      now: () => 5_000,
      generateId: () => "g2",
    });
    const goal = runner.addGoal({ prompt: "summarize", mode: "once" });
    expect(goal.mode).toBe("once");
    expect(goal.interval_ms).toBe(0);
    expect(goal.next_run_at).toBeUndefined();
    expect(goal.status).toBe("active");
  });

  it("accepts custom interval for recurring", () => {
    const { adapter } = makeAdapter(async () => ({ outcome: "fired" }));
    const runner = createGoalsRunner(adapter, { now: () => 0, generateId: () => "g3" });
    const goal = runner.addGoal({
      prompt: "x",
      mode: "recurring",
      cadence: "custom",
      interval_ms: 42_000,
    });
    expect(goal.interval_ms).toBe(42_000);
  });
});

describe("createGoalsRunner — setPaused", () => {
  it("toggles status and enabled together", () => {
    const { adapter } = makeAdapter(async () => ({ outcome: "fired" }));
    const runner = createGoalsRunner(adapter, { now: () => 0, generateId: () => "g1" });
    const goal = runner.addGoal({
      prompt: "x",
      mode: "recurring",
      cadence: "daily",
    });
    runner.setPaused(goal.goal_id, true);
    expect(runner.getState().goals[0]?.status).toBe("paused");
    expect(runner.getState().goals[0]?.enabled).toBe(false);
    runner.setPaused(goal.goal_id, false);
    expect(runner.getState().goals[0]?.status).toBe("active");
    expect(runner.getState().goals[0]?.enabled).toBe(true);
  });

  it("is a no-op on terminal states", () => {
    const initial: Partial<Stores> = {
      goals: [
        {
          goal_id: "done",
          prompt: "x",
          interval_ms: 0,
          mode: "once",
          status: "completed",
        },
      ],
    };
    const { adapter } = makeAdapter(async () => ({ outcome: "fired" }), initial);
    const runner = createGoalsRunner(adapter);
    runner.setPaused("done", true);
    expect(runner.getState().goals[0]?.status).toBe("completed");
  });
});

describe("createGoalsRunner — runNow + fire reconciliation", () => {
  it("recurring fired: advances next_run_at, writes last_response_preview", async () => {
    const { adapter, fireCalls } = makeAdapter(async () => ({
      outcome: "fired",
      responsePreview: "ok",
    }));
    let n = 100;
    const ids = ["g1", "run1"];
    let i = 0;
    const runner = createGoalsRunner(adapter, {
      now: () => n,
      generateId: () => ids[i++] ?? "x",
    });
    runner.addGoal({ prompt: "hi", mode: "recurring", cadence: "hourly" });
    n = 4_000_000;
    const result = await runner.runNow("g1");
    expect(result.outcome).toBe("fired");
    expect(fireCalls).toHaveLength(1);
    const state = runner.getState();
    expect(state.goals[0]?.last_response_preview).toBe("ok");
    expect(state.goals[0]?.last_run_at).toBe(4_000_000);
    expect(state.goals[0]?.next_run_at).toBe(4_000_000 + 3_600_000);
    expect(state.runs).toHaveLength(1);
    expect(state.runs[0]?.status).toBe("fired");
  });

  it("once goal fired: status reaches completed", async () => {
    const { adapter } = makeAdapter(async () => ({
      outcome: "fired",
      responsePreview: "done",
    }));
    const runner = createGoalsRunner(adapter, { now: () => 0, generateId: () => "g1" });
    runner.addGoal({ prompt: "p", mode: "once" });
    await runner.runNow("g1");
    expect(runner.getState().goals[0]?.status).toBe("completed");
  });

  it("once goal error: status reaches failed and last_error populated", async () => {
    const { adapter } = makeAdapter(async () => ({ outcome: "error", error: "oops" }));
    const runner = createGoalsRunner(adapter, { now: () => 0, generateId: () => "g1" });
    runner.addGoal({ prompt: "p", mode: "once" });
    await runner.runNow("g1");
    const goal = runner.getState().goals[0];
    expect(goal?.status).toBe("failed");
    expect(goal?.last_error).toBe("oops");
  });

  it("skipped: next_run_at unchanged (retried on next tick)", async () => {
    const { adapter } = makeAdapter(async () => ({ outcome: "skipped" }));
    let n = 100;
    const runner = createGoalsRunner(adapter, { now: () => n, generateId: () => "g1" });
    const goal = runner.addGoal({ prompt: "p", mode: "recurring", cadence: "hourly" });
    const originalNext = goal.next_run_at;
    n = 5_000_000;
    await runner.runNow("g1");
    expect(runner.getState().goals[0]?.next_run_at).toBe(originalNext);
    expect(runner.getState().runs[0]?.status).toBe("skipped");
  });

  it("wraps adapter.fire() throws as error outcome", async () => {
    const { adapter } = makeAdapter(async () => {
      throw new Error("boom");
    });
    const runner = createGoalsRunner(adapter, { now: () => 0, generateId: () => "g1" });
    runner.addGoal({ prompt: "p", mode: "once" });
    const result = await runner.runNow("g1");
    expect(result.outcome).toBe("error");
    if (result.outcome === "error") expect(result.error).toBe("boom");
  });

  it("runNow for missing goal returns error without side effects", async () => {
    const { adapter, fireCalls } = makeAdapter(async () => ({ outcome: "fired" }));
    const runner = createGoalsRunner(adapter);
    const result = await runner.runNow("nope");
    expect(result.outcome).toBe("error");
    expect(fireCalls).toHaveLength(0);
  });

  it("runNow forwards the onChunk callback to fire", async () => {
    const seenChunks: unknown[] = [];
    const { stores } = makeAdapter(async () => ({ outcome: "fired" }));
    const adapter = {
      loadGoals: () => stores.goals,
      saveGoals: (g: ScheduledGoal[]) => {
        stores.goals = g;
      },
      loadRuns: () => stores.runs,
      saveRuns: (r: GoalRunRecord[]) => {
        stores.runs = r;
      },
      async fire(_goal: ScheduledGoal, onChunk?: (c: unknown) => void): Promise<GoalFireResult> {
        onChunk?.({ type: "plan_created" });
        return { outcome: "fired", responsePreview: "done" };
      },
    };
    const runner = createGoalsRunner(adapter, { now: () => 0, generateId: () => "g1" });
    runner.addGoal({ prompt: "p", mode: "once" });
    await runner.runNow("g1", (c) => seenChunks.push(c));
    expect(seenChunks).toHaveLength(1);
  });
});

describe("createGoalsRunner — tick", () => {
  it("tick skips once goals — they only fire via runNow", async () => {
    const fired: string[] = [];
    const { adapter } = makeAdapter(async (g) => {
      fired.push(g.goal_id);
      return { outcome: "fired" };
    });
    const tickHolder: { fn: (() => void) | null } = { fn: null };
    const runner = createGoalsRunner(adapter, {
      now: () => 10_000_000,
      generateId: () => "once-1",
      setInterval: (h) => {
        tickHolder.fn = h;
        return 1 as unknown as ReturnType<typeof setInterval>;
      },
      clearInterval: () => {},
    });
    runner.addGoal({ prompt: "x", mode: "once" });
    runner.start();
    tickHolder.fn?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(fired).toHaveLength(0);
  });
});

describe("createGoalsRunner — dispose + start/stop", () => {
  it("dispose stops the tick and blocks emissions", () => {
    const clearCalls: unknown[] = [];
    const { adapter } = makeAdapter(async () => ({ outcome: "fired" }));
    const runner = createGoalsRunner(adapter, {
      setInterval: () => 42 as unknown as ReturnType<typeof setInterval>,
      clearInterval: (h) => {
        clearCalls.push(h);
      },
    });
    runner.start();
    runner.dispose();
    expect(clearCalls).toEqual([42]);
    const listener = vi.fn();
    runner.subscribe(listener);
    runner.addGoal({ prompt: "x", mode: "once" });
    expect(listener).toHaveBeenCalled();
  });

  it("start is idempotent", () => {
    const calls: number[] = [];
    const { adapter } = makeAdapter(async () => ({ outcome: "fired" }));
    const runner = createGoalsRunner(adapter, {
      setInterval: () => {
        const handle = calls.length;
        calls.push(handle);
        return handle as unknown as ReturnType<typeof setInterval>;
      },
      clearInterval: () => {},
    });
    runner.start();
    runner.start();
    expect(calls).toHaveLength(1);
  });
});
