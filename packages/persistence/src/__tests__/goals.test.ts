import { describe, it, expect, beforeEach } from "vitest";
import {
  createMotebitDatabase,
  type MotebitDatabase,
  type Goal,
  type GoalOutcome,
} from "../index.js";

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
      mode: "recurring",
      status: "active",
      parent_goal_id: null,
      max_retries: 3,
      consecutive_failures: 0,
      wall_clock_ms: null,
      project_id: null,
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

  it("setEnabled toggles enabled flag and syncs status", () => {
    moteDb.goalStore.add(makeGoal());
    expect(moteDb.goalStore.list("mote-abc")[0]!.enabled).toBe(true);

    moteDb.goalStore.setEnabled("goal-001", false);
    const paused = moteDb.goalStore.list("mote-abc")[0]!;
    expect(paused.enabled).toBe(false);
    expect(paused.status).toBe("paused");

    moteDb.goalStore.setEnabled("goal-001", true);
    const resumed = moteDb.goalStore.list("mote-abc")[0]!;
    expect(resumed.enabled).toBe(true);
    expect(resumed.status).toBe("active");
  });

  it("get returns single goal or null", () => {
    moteDb.goalStore.add(makeGoal());
    const found = moteDb.goalStore.get("goal-001");
    expect(found).not.toBeNull();
    expect(found!.goal_id).toBe("goal-001");

    expect(moteDb.goalStore.get("nonexistent")).toBeNull();
  });

  it("setStatus updates goal status", () => {
    moteDb.goalStore.add(makeGoal());
    moteDb.goalStore.setStatus("goal-001", "completed");
    expect(moteDb.goalStore.get("goal-001")!.status).toBe("completed");
  });

  it("incrementFailures and resetFailures", () => {
    moteDb.goalStore.add(makeGoal());
    expect(moteDb.goalStore.get("goal-001")!.consecutive_failures).toBe(0);

    moteDb.goalStore.incrementFailures("goal-001");
    moteDb.goalStore.incrementFailures("goal-001");
    expect(moteDb.goalStore.get("goal-001")!.consecutive_failures).toBe(2);

    moteDb.goalStore.resetFailures("goal-001");
    expect(moteDb.goalStore.get("goal-001")!.consecutive_failures).toBe(0);
  });

  it("listChildren returns child goals", () => {
    moteDb.goalStore.add(makeGoal({ goal_id: "parent" }));
    moteDb.goalStore.add(makeGoal({ goal_id: "child-1", parent_goal_id: "parent" }));
    moteDb.goalStore.add(makeGoal({ goal_id: "child-2", parent_goal_id: "parent" }));
    moteDb.goalStore.add(makeGoal({ goal_id: "unrelated" }));

    const children = moteDb.goalStore.listChildren("parent");
    expect(children).toHaveLength(2);
    expect(children.map((c) => c.goal_id)).toEqual(["child-1", "child-2"]);
  });

  it("persists mode and one-shot goals", () => {
    moteDb.goalStore.add(makeGoal({ goal_id: "once-goal", mode: "once" }));
    const goal = moteDb.goalStore.get("once-goal")!;
    expect(goal.mode).toBe("once");
  });
});

describe("SqliteGoalOutcomeStore", () => {
  let moteDb: MotebitDatabase;

  beforeEach(() => {
    moteDb = createMotebitDatabase(":memory:");
  });

  function makeOutcome(overrides: Partial<GoalOutcome> = {}): GoalOutcome {
    return {
      outcome_id: "out-001",
      goal_id: "goal-001",
      motebit_id: "mote-abc",
      ran_at: Date.now(),
      status: "completed",
      summary: "All good",
      tool_calls_made: 2,
      memories_formed: 1,
      error_message: null,
      ...overrides,
    };
  }

  it("adds and retrieves outcomes for a goal", () => {
    moteDb.goalOutcomeStore.add(makeOutcome());
    const outcomes = moteDb.goalOutcomeStore.listForGoal("goal-001");
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.status).toBe("completed");
    expect(outcomes[0]!.summary).toBe("All good");
    expect(outcomes[0]!.tool_calls_made).toBe(2);
    expect(outcomes[0]!.memories_formed).toBe(1);
  });

  it("returns outcomes ordered by ran_at DESC", () => {
    const now = Date.now();
    moteDb.goalOutcomeStore.add(makeOutcome({ outcome_id: "o1", ran_at: now - 2000 }));
    moteDb.goalOutcomeStore.add(makeOutcome({ outcome_id: "o2", ran_at: now - 1000 }));
    moteDb.goalOutcomeStore.add(makeOutcome({ outcome_id: "o3", ran_at: now }));

    const outcomes = moteDb.goalOutcomeStore.listForGoal("goal-001");
    expect(outcomes[0]!.outcome_id).toBe("o3");
    expect(outcomes[2]!.outcome_id).toBe("o1");
  });

  it("respects limit parameter", () => {
    const now = Date.now();
    for (let i = 0; i < 5; i++) {
      moteDb.goalOutcomeStore.add(makeOutcome({ outcome_id: `o-${i}`, ran_at: now + i }));
    }
    const outcomes = moteDb.goalOutcomeStore.listForGoal("goal-001", 3);
    expect(outcomes).toHaveLength(3);
  });

  it("listRecent returns outcomes across goals", () => {
    const now = Date.now();
    moteDb.goalOutcomeStore.add(makeOutcome({ outcome_id: "a", goal_id: "g1", ran_at: now }));
    moteDb.goalOutcomeStore.add(makeOutcome({ outcome_id: "b", goal_id: "g2", ran_at: now + 100 }));

    const recent = moteDb.goalOutcomeStore.listRecent("mote-abc", 10);
    expect(recent).toHaveLength(2);
    expect(recent[0]!.outcome_id).toBe("b"); // most recent first
  });

  it("stores failed outcomes with error messages", () => {
    moteDb.goalOutcomeStore.add(
      makeOutcome({
        status: "failed",
        summary: null,
        error_message: "Connection timeout",
      }),
    );
    const outcomes = moteDb.goalOutcomeStore.listForGoal("goal-001");
    expect(outcomes[0]!.status).toBe("failed");
    expect(outcomes[0]!.error_message).toBe("Connection timeout");
    expect(outcomes[0]!.summary).toBeNull();
  });

  it("returns empty for unknown goal_id", () => {
    moteDb.goalOutcomeStore.add(makeOutcome());
    const outcomes = moteDb.goalOutcomeStore.listForGoal("nonexistent");
    expect(outcomes).toHaveLength(0);
  });
});
