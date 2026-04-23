/**
 * GoalsController unit tests. Covers:
 *
 *  - refresh() fetches through adapter and populates state
 *  - loading flag transitions; error surfaces preserve previous-good state
 *  - addGoal refreshes (authoritative read wins, no optimistic insert)
 *  - setEnabled mutates in place (optimistic for immediate feedback)
 *  - removeGoal filters the in-memory list
 *  - subscribe / dispose semantics
 */
import { describe, it, expect, vi } from "vitest";
import {
  createGoalsController,
  type GoalsFetchAdapter,
  type NewGoalInput,
  type ScheduledGoal,
} from "../controller.js";

function makeGoal(overrides: Partial<ScheduledGoal> & { goal_id: string }): ScheduledGoal {
  return {
    prompt: "test",
    interval_ms: 3_600_000,
    mode: "recurring",
    status: "active",
    enabled: true,
    ...overrides,
  };
}

function createAdapter(overrides?: {
  goals?: ScheduledGoal[];
  listThrows?: Error;
  addThrows?: Error;
  setEnabledThrows?: Error;
  removeThrows?: Error;
}): {
  adapter: GoalsFetchAdapter;
  calls: {
    list: number;
    add: NewGoalInput[];
    setEnabled: Array<{ goalId: string; enabled: boolean }>;
    remove: string[];
  };
} {
  const calls = {
    list: 0,
    add: [] as NewGoalInput[],
    setEnabled: [] as Array<{ goalId: string; enabled: boolean }>,
    remove: [] as string[],
  };
  let stored = overrides?.goals ?? [];

  const adapter: GoalsFetchAdapter = {
    async listGoals() {
      calls.list++;
      if (overrides?.listThrows) throw overrides.listThrows;
      return stored;
    },
    async addGoal(input) {
      calls.add.push(input);
      if (overrides?.addThrows) throw overrides.addThrows;
      stored = [
        ...stored,
        makeGoal({
          goal_id: `goal-${stored.length + 1}`,
          prompt: input.prompt,
          interval_ms: input.interval_ms,
          mode: input.mode,
        }),
      ];
    },
    async setEnabled(goalId, enabled) {
      calls.setEnabled.push({ goalId, enabled });
      if (overrides?.setEnabledThrows) throw overrides.setEnabledThrows;
    },
    async removeGoal(goalId) {
      calls.remove.push(goalId);
      if (overrides?.removeThrows) throw overrides.removeThrows;
      stored = stored.filter((g) => g.goal_id !== goalId);
    },
  };

  return { adapter, calls };
}

describe("GoalsController — initial state", () => {
  it("starts empty, not loading, no error", () => {
    const { adapter } = createAdapter();
    const ctrl = createGoalsController(adapter);
    const s = ctrl.getState();
    expect(s.goals).toEqual([]);
    expect(s.loading).toBe(false);
    expect(s.error).toBeNull();
  });
});

describe("GoalsController — refresh()", () => {
  it("populates state from adapter", async () => {
    const goals = [makeGoal({ goal_id: "a" }), makeGoal({ goal_id: "b" })];
    const { adapter, calls } = createAdapter({ goals });
    const ctrl = createGoalsController(adapter);
    await ctrl.refresh();
    expect(calls.list).toBe(1);
    expect(ctrl.getState().goals).toHaveLength(2);
    expect(ctrl.getState().loading).toBe(false);
    expect(ctrl.getState().error).toBeNull();
  });

  it("flips loading true then false", async () => {
    const { adapter } = createAdapter({ goals: [] });
    const ctrl = createGoalsController(adapter);
    const seen: boolean[] = [];
    ctrl.subscribe((s) => seen.push(s.loading));
    await ctrl.refresh();
    expect(seen[0]).toBe(true);
    expect(seen[seen.length - 1]).toBe(false);
  });

  it("preserves previous-good state when the adapter throws", async () => {
    let callCount = 0;
    const adapter: GoalsFetchAdapter = {
      async listGoals() {
        callCount++;
        if (callCount === 1) return [makeGoal({ goal_id: "alive" })];
        throw new Error("daemon offline");
      },
      async addGoal() {},
      async setEnabled() {},
      async removeGoal() {},
    };
    const ctrl = createGoalsController(adapter);
    await ctrl.refresh();
    expect(ctrl.getState().goals).toHaveLength(1);
    await ctrl.refresh();
    expect(ctrl.getState().error).toBe("daemon offline");
    expect(ctrl.getState().goals).toHaveLength(1);
  });
});

describe("GoalsController — addGoal()", () => {
  it("calls adapter then refreshes (no optimistic insert)", async () => {
    const { adapter, calls } = createAdapter({ goals: [] });
    const ctrl = createGoalsController(adapter);
    await ctrl.addGoal({ prompt: "hi", interval_ms: 3_600_000, mode: "recurring" });
    expect(calls.add).toHaveLength(1);
    expect(calls.list).toBeGreaterThanOrEqual(1); // refreshed after add
    expect(ctrl.getState().goals).toHaveLength(1);
    expect(ctrl.getState().goals[0]?.prompt).toBe("hi");
  });

  it("surfaces addGoal errors", async () => {
    const { adapter } = createAdapter({ addThrows: new Error("daemon busy") });
    const ctrl = createGoalsController(adapter);
    await ctrl.addGoal({ prompt: "x", interval_ms: 3_600_000, mode: "recurring" });
    expect(ctrl.getState().error).toBe("daemon busy");
  });
});

describe("GoalsController — setEnabled()", () => {
  it("optimistically flips enabled + status", async () => {
    const goal = makeGoal({ goal_id: "a", enabled: true, status: "active" });
    const { adapter } = createAdapter({ goals: [goal] });
    const ctrl = createGoalsController(adapter);
    await ctrl.refresh();
    await ctrl.setEnabled("a", false);
    expect(ctrl.getState().goals[0]?.enabled).toBe(false);
    expect(ctrl.getState().goals[0]?.status).toBe("paused");
  });

  it("surfaces setEnabled errors", async () => {
    const { adapter } = createAdapter({
      goals: [makeGoal({ goal_id: "a" })],
      setEnabledThrows: new Error("permission denied"),
    });
    const ctrl = createGoalsController(adapter);
    await ctrl.refresh();
    await ctrl.setEnabled("a", false);
    expect(ctrl.getState().error).toBe("permission denied");
  });
});

describe("GoalsController — removeGoal()", () => {
  it("filters from state after adapter confirms", async () => {
    const goals = [makeGoal({ goal_id: "a" }), makeGoal({ goal_id: "b" })];
    const { adapter, calls } = createAdapter({ goals });
    const ctrl = createGoalsController(adapter);
    await ctrl.refresh();
    await ctrl.removeGoal("a");
    expect(calls.remove).toEqual(["a"]);
    expect(ctrl.getState().goals.map((g) => g.goal_id)).toEqual(["b"]);
  });

  it("surfaces removeGoal errors", async () => {
    const { adapter } = createAdapter({
      goals: [makeGoal({ goal_id: "a" })],
      removeThrows: new Error("foreign key constraint"),
    });
    const ctrl = createGoalsController(adapter);
    await ctrl.refresh();
    await ctrl.removeGoal("a");
    expect(ctrl.getState().error).toBe("foreign key constraint");
  });
});

describe("GoalsController — runNow (optional adapter method)", () => {
  it("surfaces ctrl.runNow only when the adapter implements runNow", () => {
    // Adapter with no runNow
    const { adapter: bareAdapter } = createAdapter({ goals: [] });
    const bareCtrl = createGoalsController(bareAdapter);
    expect(bareCtrl.runNow).toBeUndefined();

    // Adapter with runNow
    const withRunNow: GoalsFetchAdapter = {
      listGoals: async () => [],
      addGoal: async () => {},
      setEnabled: async () => {},
      removeGoal: async () => {},
      runNow: async () => {},
    };
    const liveCtrl = createGoalsController(withRunNow);
    expect(typeof liveCtrl.runNow).toBe("function");
  });

  it("invokes adapter.runNow then refreshes so last_run_at propagates", async () => {
    const runNowCalls: string[] = [];
    let listCalls = 0;
    const adapter: GoalsFetchAdapter = {
      listGoals: async () => {
        listCalls++;
        return [];
      },
      addGoal: async () => {},
      setEnabled: async () => {},
      removeGoal: async () => {},
      runNow: async (goalId) => {
        runNowCalls.push(goalId);
      },
    };
    const ctrl = createGoalsController(adapter);
    await ctrl.runNow!("abc");
    expect(runNowCalls).toEqual(["abc"]);
    // Refresh happens after adapter.runNow resolves.
    expect(listCalls).toBe(1);
  });

  it("surfaces runNow errors as state.error without throwing", async () => {
    const adapter: GoalsFetchAdapter = {
      listGoals: async () => [],
      addGoal: async () => {},
      setEnabled: async () => {},
      removeGoal: async () => {},
      runNow: async () => {
        throw new Error("another goal is running");
      },
    };
    const ctrl = createGoalsController(adapter);
    await ctrl.runNow!("abc");
    expect(ctrl.getState().error).toBe("another goal is running");
  });
});

describe("GoalsController — subscribe / dispose", () => {
  it("notifies subscribers on state change", async () => {
    const { adapter } = createAdapter({ goals: [makeGoal({ goal_id: "a" })] });
    const ctrl = createGoalsController(adapter);
    const listener = vi.fn();
    ctrl.subscribe(listener);
    await ctrl.refresh();
    expect(listener).toHaveBeenCalled();
  });

  it("dispose blocks further emissions", async () => {
    const { adapter } = createAdapter({ goals: [makeGoal({ goal_id: "a" })] });
    const ctrl = createGoalsController(adapter);
    const listener = vi.fn();
    ctrl.subscribe(listener);
    ctrl.dispose();
    await ctrl.refresh();
    expect(listener).not.toHaveBeenCalled();
  });
});
