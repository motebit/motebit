/**
 * Owner-interior WRITE APIs take the tier by type: a goal row or a goal
 * outcome row written without its sensitivity would silently take the
 * legacy exception (`goalTextSensitivity` / `goalOutcomeSensitivity` in
 * @motebit/runtime) meant only for rows that pre-date migration #52. The
 * `@ts-expect-error` lines are the static half (typecheck fails if the
 * field becomes optional again); the runtime half refuses a write whose
 * stamp was erased by a cast.
 */
import { describe, it, expect } from "vitest";
import { SensitivityLevel } from "@motebit/sdk";
import { createMotebitDatabase, type Goal, type GoalOutcome } from "../index.js";

const unstampedGoal: Omit<Goal, "sensitivity"> = {
  goal_id: "g",
  motebit_id: "m",
  prompt: "p",
  interval_ms: 1,
  last_run_at: null,
  enabled: true,
  created_at: 1,
  mode: "recurring",
  status: "active",
  parent_goal_id: null,
  max_retries: 3,
  consecutive_failures: 0,
  wall_clock_ms: null,
  project_id: null,
};

const unstampedOutcome: Omit<GoalOutcome, "sensitivity"> = {
  outcome_id: "o",
  goal_id: "g",
  motebit_id: "m",
  ran_at: 1,
  status: "completed",
  summary: "s",
  tool_calls_made: 0,
  memories_formed: 0,
  error_message: null,
};

describe("owner-interior writes require a tier", () => {
  it("a goal row cannot be written without its stamp", () => {
    const db = createMotebitDatabase(":memory:");
    // @ts-expect-error — `sensitivity` is required on a goal write
    expect(() => db.goalStore.add(unstampedGoal)).toThrow(/sensitivity/);
    expect(() =>
      db.goalStore.add({ ...unstampedGoal, sensitivity: null as unknown as SensitivityLevel }),
    ).toThrow(/sensitivity/);
    expect(db.goalStore.list("m")).toEqual([]);
    db.goalStore.add({ ...unstampedGoal, sensitivity: SensitivityLevel.Personal });
    expect(db.goalStore.get("g")?.sensitivity).toBe(SensitivityLevel.Personal);
    db.close();
  });

  it("a goal outcome row cannot be written without its stamp", () => {
    const db = createMotebitDatabase(":memory:");
    // @ts-expect-error — `sensitivity` is required on an outcome write
    expect(() => db.goalOutcomeStore.add(unstampedOutcome)).toThrow(/sensitivity/);
    expect(db.goalOutcomeStore.listForGoal("g", 10)).toEqual([]);
    db.goalOutcomeStore.add({ ...unstampedOutcome, sensitivity: SensitivityLevel.Secret });
    expect(db.goalOutcomeStore.listForGoal("g", 10)[0]?.sensitivity).toBe(SensitivityLevel.Secret);
    db.close();
  });
});
