import { describe, it, expect, beforeEach } from "vitest";
import { PlanStatus, StepStatus } from "@motebit/sdk";
import type { Plan, PlanStep } from "@motebit/sdk";
import { createMotebitDatabase, type MotebitDatabase } from "../index.js";

describe("SqlitePlanStore", () => {
  let moteDb: MotebitDatabase;

  beforeEach(() => {
    moteDb = createMotebitDatabase(":memory:");
  });

  function makePlan(overrides: Partial<Plan> = {}): Plan {
    return {
      plan_id: "plan-001",
      goal_id: "goal-001",
      motebit_id: "mote-abc",
      title: "Test plan",
      status: PlanStatus.Active,
      created_at: Date.now(),
      updated_at: Date.now(),
      current_step_index: 0,
      total_steps: 2,
      ...overrides,
    };
  }

  function makeStep(overrides: Partial<PlanStep> = {}): PlanStep {
    return {
      step_id: "step-001",
      plan_id: "plan-001",
      ordinal: 0,
      description: "Test step",
      prompt: "Do something",
      depends_on: [],
      optional: false,
      status: StepStatus.Pending,
      result_summary: null,
      error_message: null,
      tool_calls_made: 0,
      started_at: null,
      completed_at: null,
      retry_count: 0,
      updated_at: Date.now(),
      ...overrides,
    };
  }

  it("saves and retrieves a plan", () => {
    const plan = makePlan();
    moteDb.planStore.savePlan(plan);

    const retrieved = moteDb.planStore.getPlan("plan-001");
    expect(retrieved).not.toBeNull();
    expect(retrieved!.plan_id).toBe("plan-001");
    expect(retrieved!.goal_id).toBe("goal-001");
    expect(retrieved!.title).toBe("Test plan");
    expect(retrieved!.status).toBe(PlanStatus.Active);
    expect(retrieved!.total_steps).toBe(2);
  });

  it("returns null for non-existent plan", () => {
    expect(moteDb.planStore.getPlan("nonexistent")).toBeNull();
  });

  it("gets plan for goal", () => {
    moteDb.planStore.savePlan(makePlan());

    const found = moteDb.planStore.getPlanForGoal("goal-001");
    expect(found).not.toBeNull();
    expect(found!.plan_id).toBe("plan-001");
  });

  it("returns null when no plan for goal", () => {
    expect(moteDb.planStore.getPlanForGoal("nonexistent")).toBeNull();
  });

  it("updates plan fields", () => {
    moteDb.planStore.savePlan(makePlan());

    moteDb.planStore.updatePlan("plan-001", {
      status: PlanStatus.Completed,
      current_step_index: 2,
    });

    const updated = moteDb.planStore.getPlan("plan-001");
    expect(updated!.status).toBe(PlanStatus.Completed);
    expect(updated!.current_step_index).toBe(2);
    expect(updated!.title).toBe("Test plan"); // unchanged
  });

  it("saves and retrieves steps", () => {
    moteDb.planStore.savePlan(makePlan());

    moteDb.planStore.saveStep(makeStep({ step_id: "step-001", ordinal: 0 }));
    moteDb.planStore.saveStep(makeStep({ step_id: "step-002", ordinal: 1 }));

    const steps = moteDb.planStore.getStepsForPlan("plan-001");
    expect(steps).toHaveLength(2);
    expect(steps[0]!.ordinal).toBe(0);
    expect(steps[1]!.ordinal).toBe(1);
  });

  it("retrieves single step by id", () => {
    moteDb.planStore.savePlan(makePlan());
    moteDb.planStore.saveStep(makeStep());

    const step = moteDb.planStore.getStep("step-001");
    expect(step).not.toBeNull();
    expect(step!.description).toBe("Test step");
    expect(step!.depends_on).toEqual([]);
    expect(step!.optional).toBe(false);
  });

  it("updates step fields", () => {
    moteDb.planStore.savePlan(makePlan());
    moteDb.planStore.saveStep(makeStep());

    moteDb.planStore.updateStep("step-001", {
      status: StepStatus.Completed,
      result_summary: "It worked",
      tool_calls_made: 3,
      completed_at: Date.now(),
    });

    const updated = moteDb.planStore.getStep("step-001");
    expect(updated!.status).toBe(StepStatus.Completed);
    expect(updated!.result_summary).toBe("It worked");
    expect(updated!.tool_calls_made).toBe(3);
    expect(updated!.completed_at).not.toBeNull();
  });

  it("gets next pending step", () => {
    moteDb.planStore.savePlan(makePlan());
    moteDb.planStore.saveStep(
      makeStep({ step_id: "step-001", ordinal: 0, status: StepStatus.Completed }),
    );
    moteDb.planStore.saveStep(
      makeStep({ step_id: "step-002", ordinal: 1, status: StepStatus.Pending }),
    );

    const next = moteDb.planStore.getNextPendingStep("plan-001");
    expect(next).not.toBeNull();
    expect(next!.step_id).toBe("step-002");
  });

  it("returns null when no pending steps", () => {
    moteDb.planStore.savePlan(makePlan());
    moteDb.planStore.saveStep(makeStep({ status: StepStatus.Completed }));

    expect(moteDb.planStore.getNextPendingStep("plan-001")).toBeNull();
  });

  it("stores and retrieves depends_on array", () => {
    moteDb.planStore.savePlan(makePlan());
    moteDb.planStore.saveStep(
      makeStep({
        depends_on: ["plan-001:0", "plan-001:1"],
      }),
    );

    const step = moteDb.planStore.getStep("step-001");
    expect(step!.depends_on).toEqual(["plan-001:0", "plan-001:1"]);
  });

  it("stores optional flag correctly", () => {
    moteDb.planStore.savePlan(makePlan());
    moteDb.planStore.saveStep(makeStep({ optional: true }));

    const step = moteDb.planStore.getStep("step-001");
    expect(step!.optional).toBe(true);
  });

  it("gets most recent plan for goal when multiple exist", () => {
    const now = Date.now();
    moteDb.planStore.savePlan(
      makePlan({
        plan_id: "plan-old",
        created_at: now - 1000,
      }),
    );
    moteDb.planStore.savePlan(
      makePlan({
        plan_id: "plan-new",
        created_at: now,
      }),
    );

    const found = moteDb.planStore.getPlanForGoal("goal-001");
    expect(found!.plan_id).toBe("plan-new");
  });
});
