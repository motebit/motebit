import { describe, it, expect, beforeEach } from "vitest";
import { createMotebitDatabase, type MotebitDatabase, type Goal } from "../index.js";

describe("SqliteGoalStore", () => {
  let moteDb: MotebitDatabase;

  beforeEach(() => {
    moteDb = createMotebitDatabase(":memory:");
  });

  function makeGoal(overrides: Partial<Goal> = {}): Goal {
    return {
      goal_id: "goal-001",
      motebit_id: "mote-abc",
      prompt: "check system health",
      interval_ms: 1_800_000,
      last_run_at: null,
      enabled: true,
      created_at: Date.now(),
      ...overrides,
    };
  }

  it("adds and lists goals", () => {
    const goal = makeGoal();
    moteDb.goalStore.add(goal);

    const goals = moteDb.goalStore.list("mote-abc");
    expect(goals).toHaveLength(1);
    expect(goals[0]!.goal_id).toBe("goal-001");
    expect(goals[0]!.prompt).toBe("check system health");
    expect(goals[0]!.interval_ms).toBe(1_800_000);
    expect(goals[0]!.last_run_at).toBeNull();
    expect(goals[0]!.enabled).toBe(true);
  });

  it("returns empty list for unknown motebit_id", () => {
    moteDb.goalStore.add(makeGoal());
    const goals = moteDb.goalStore.list("unknown");
    expect(goals).toHaveLength(0);
  });

  it("removes a goal", () => {
    moteDb.goalStore.add(makeGoal());
    expect(moteDb.goalStore.list("mote-abc")).toHaveLength(1);

    moteDb.goalStore.remove("goal-001");
    expect(moteDb.goalStore.list("mote-abc")).toHaveLength(0);
  });

  it("updates last_run_at", () => {
    moteDb.goalStore.add(makeGoal());
    const ts = Date.now();
    moteDb.goalStore.updateLastRun("goal-001", ts);

    const goals = moteDb.goalStore.list("mote-abc");
    expect(goals[0]!.last_run_at).toBe(ts);
  });

  it("handles multiple goals ordered by created_at", () => {
    const now = Date.now();
    moteDb.goalStore.add(makeGoal({ goal_id: "g1", created_at: now }));
    moteDb.goalStore.add(makeGoal({ goal_id: "g2", created_at: now + 100 }));
    moteDb.goalStore.add(makeGoal({ goal_id: "g3", created_at: now + 200 }));

    const goals = moteDb.goalStore.list("mote-abc");
    expect(goals).toHaveLength(3);
    expect(goals[0]!.goal_id).toBe("g1");
    expect(goals[1]!.goal_id).toBe("g2");
    expect(goals[2]!.goal_id).toBe("g3");
  });

  it("stores enabled=false correctly", () => {
    moteDb.goalStore.add(makeGoal({ enabled: false }));
    const goals = moteDb.goalStore.list("mote-abc");
    expect(goals[0]!.enabled).toBe(false);
  });

  it("setEnabled toggles enabled flag", () => {
    moteDb.goalStore.add(makeGoal());
    expect(moteDb.goalStore.list("mote-abc")[0]!.enabled).toBe(true);

    moteDb.goalStore.setEnabled("goal-001", false);
    expect(moteDb.goalStore.list("mote-abc")[0]!.enabled).toBe(false);

    moteDb.goalStore.setEnabled("goal-001", true);
    expect(moteDb.goalStore.list("mote-abc")[0]!.enabled).toBe(true);
  });
});
