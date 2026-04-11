import { describe, it, expect } from "vitest";
import { InMemoryPlanStore } from "../types.js";
import { PlanStatus, StepStatus } from "@motebit/sdk";
import type { Plan, PlanStep, PlanId, MotebitId } from "@motebit/sdk";

function makePlan(overrides: Partial<Plan> = {}): Plan {
  return {
    plan_id: "plan-1" as PlanId,
    goal_id: "goal-1",
    motebit_id: "mote-1" as MotebitId,
    title: "Test plan",
    status: PlanStatus.Active,
    created_at: Date.now(),
    updated_at: Date.now(),
    current_step_index: 0,
    total_steps: 1,
    ...overrides,
  };
}

function makeStep(overrides: Partial<PlanStep> = {}): PlanStep {
  return {
    step_id: "step-1",
    plan_id: "plan-1" as PlanId,
    ordinal: 0,
    description: "Test step",
    prompt: "Do it",
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

describe("InMemoryPlanStore", () => {
  it("getPlan returns null for nonexistent plan", () => {
    const store = new InMemoryPlanStore();
    expect(store.getPlan("nonexistent")).toBeNull();
  });

  it("updatePlan is no-op for nonexistent plan", () => {
    const store = new InMemoryPlanStore();
    // Should not throw
    store.updatePlan("nonexistent", { title: "Updated" });
    expect(store.getPlan("nonexistent")).toBeNull();
  });

  it("getStep returns null for nonexistent step", () => {
    const store = new InMemoryPlanStore();
    expect(store.getStep("nonexistent")).toBeNull();
  });

  it("updateStep is no-op for nonexistent step", () => {
    const store = new InMemoryPlanStore();
    // Should not throw
    store.updateStep("nonexistent", { status: StepStatus.Running });
    expect(store.getStep("nonexistent")).toBeNull();
  });

  it("getPlanForGoal returns null when no plan matches", () => {
    const store = new InMemoryPlanStore();
    store.savePlan(makePlan({ goal_id: "goal-1" }));
    expect(store.getPlanForGoal("goal-nonexistent")).toBeNull();
  });

  it("getNextPendingStep returns null when no pending steps", () => {
    const store = new InMemoryPlanStore();
    store.saveStep(makeStep({ status: StepStatus.Completed }));
    expect(store.getNextPendingStep("plan-1")).toBeNull();
  });

  it("listActivePlans excludes non-active plans", () => {
    const store = new InMemoryPlanStore();
    store.savePlan(makePlan({ plan_id: "p1" as PlanId, status: PlanStatus.Active }));
    store.savePlan(makePlan({ plan_id: "p2" as PlanId, status: PlanStatus.Failed }));
    const active = store.listActivePlans("mote-1" as MotebitId);
    expect(active).toHaveLength(1);
    expect(active[0]!.plan_id).toBe("p1");
  });

  it("listActivePlans excludes plans for other motebit ids", () => {
    const store = new InMemoryPlanStore();
    store.savePlan(makePlan({ motebit_id: "mote-other" as MotebitId }));
    const active = store.listActivePlans("mote-1" as MotebitId);
    expect(active).toHaveLength(0);
  });
});
