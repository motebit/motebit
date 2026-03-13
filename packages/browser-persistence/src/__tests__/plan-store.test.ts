import { describe, it, expect, beforeEach } from "vitest";
import { openMotebitDB } from "../idb.js";
import { IdbPlanStore } from "../plan-store.js";
import type { Plan, PlanStep, PlanId, GoalId, MotebitId } from "@motebit/sdk";
import { PlanStatus, StepStatus } from "@motebit/sdk";

describe("IdbPlanStore", () => {
  let store: IdbPlanStore;
  const motebitId = "m-test-1" as MotebitId;

  function makePlan(overrides: Partial<Plan> = {}): Plan {
    return {
      plan_id: ("plan-" + crypto.randomUUID()) as PlanId,
      goal_id: ("goal-" + crypto.randomUUID()) as GoalId,
      motebit_id: motebitId,
      title: "Test plan",
      status: PlanStatus.Active,
      created_at: Date.now(),
      updated_at: Date.now(),
      current_step_index: 0,
      total_steps: 2,
      ...overrides,
    };
  }

  function makeStep(planId: string, ordinal: number, overrides: Partial<PlanStep> = {}): PlanStep {
    return {
      step_id: "step-" + crypto.randomUUID(),
      plan_id: planId as PlanId,
      ordinal,
      description: `Step ${ordinal}`,
      prompt: `Do step ${ordinal}`,
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

  beforeEach(async () => {
    const db = await openMotebitDB(`test-plan-store-${crypto.randomUUID()}`);
    store = new IdbPlanStore(db);
  });

  it("saves and retrieves a plan", () => {
    const plan = makePlan();
    store.savePlan(plan);
    const loaded = store.getPlan(plan.plan_id);
    expect(loaded).not.toBeNull();
    expect(loaded!.plan_id).toBe(plan.plan_id);
    expect(loaded!.title).toBe("Test plan");
  });

  it("returns null for missing plan", () => {
    expect(store.getPlan("nonexistent" as PlanId)).toBeNull();
  });

  it("gets plan by goal ID", () => {
    const plan = makePlan();
    store.savePlan(plan);
    const found = store.getPlanForGoal(plan.goal_id);
    expect(found).not.toBeNull();
    expect(found!.plan_id).toBe(plan.plan_id);
  });

  it("updates a plan", () => {
    const plan = makePlan();
    store.savePlan(plan);
    store.updatePlan(plan.plan_id, { status: PlanStatus.Completed, current_step_index: 2 });
    const loaded = store.getPlan(plan.plan_id);
    expect(loaded!.status).toBe(PlanStatus.Completed);
    expect(loaded!.current_step_index).toBe(2);
  });

  it("saves and retrieves steps", () => {
    const plan = makePlan();
    store.savePlan(plan);
    const step1 = makeStep(plan.plan_id, 0);
    const step2 = makeStep(plan.plan_id, 1);
    store.saveStep(step1);
    store.saveStep(step2);

    const steps = store.getStepsForPlan(plan.plan_id);
    expect(steps).toHaveLength(2);
    expect(steps[0]!.ordinal).toBe(0);
    expect(steps[1]!.ordinal).toBe(1);
  });

  it("gets a single step", () => {
    const plan = makePlan();
    store.savePlan(plan);
    const step = makeStep(plan.plan_id, 0);
    store.saveStep(step);
    const loaded = store.getStep(step.step_id);
    expect(loaded).not.toBeNull();
    expect(loaded!.step_id).toBe(step.step_id);
  });

  it("updates a step", () => {
    const plan = makePlan();
    store.savePlan(plan);
    const step = makeStep(plan.plan_id, 0);
    store.saveStep(step);
    store.updateStep(step.step_id, { status: StepStatus.Completed, result_summary: "done" });
    const loaded = store.getStep(step.step_id);
    expect(loaded!.status).toBe(StepStatus.Completed);
    expect(loaded!.result_summary).toBe("done");
  });

  it("getNextPendingStep returns first pending step", () => {
    const plan = makePlan();
    store.savePlan(plan);
    const step1 = makeStep(plan.plan_id, 0, { status: StepStatus.Completed });
    const step2 = makeStep(plan.plan_id, 1, { status: StepStatus.Pending });
    store.saveStep(step1);
    store.saveStep(step2);
    const next = store.getNextPendingStep(plan.plan_id);
    expect(next).not.toBeNull();
    expect(next!.step_id).toBe(step2.step_id);
  });

  it("getNextPendingStep returns null when all completed", () => {
    const plan = makePlan();
    store.savePlan(plan);
    const step = makeStep(plan.plan_id, 0, { status: StepStatus.Completed });
    store.saveStep(step);
    expect(store.getNextPendingStep(plan.plan_id)).toBeNull();
  });

  it("preload round-trip", async () => {
    const plan = makePlan();
    store.savePlan(plan);
    const step = makeStep(plan.plan_id, 0);
    store.saveStep(step);

    // Wait for IDB writes to flush
    await new Promise((r) => setTimeout(r, 50));

    // Create a new store pointing at the same DB and preload
    const db = (store as unknown as { db: IDBDatabase }).db;
    const store2 = new IdbPlanStore(db);
    await store2.preload(motebitId);

    expect(store2.getPlan(plan.plan_id)).not.toBeNull();
    expect(store2.getStep(step.step_id)).not.toBeNull();
    expect(store2.getPlanForGoal(plan.goal_id)).not.toBeNull();
  });
});
