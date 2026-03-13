import { describe, it, expect, vi } from "vitest";
import { PlanSyncEngine, InMemoryPlanSyncStore } from "../plan-sync.js";
import type { PlanSyncRemoteAdapter } from "../plan-sync.js";
import { PlanStatus, StepStatus } from "@motebit/sdk";
import type { SyncPlan, SyncPlanStep, PlanId, GoalId, MotebitId } from "@motebit/sdk";

function makePlan(id: string, updatedAt: number, status = PlanStatus.Active): SyncPlan {
  return {
    plan_id: `plan-${id}` as PlanId,
    goal_id: `goal-${id}` as GoalId,
    motebit_id: "test-mote" as MotebitId,
    title: `Plan ${id}`,
    status,
    created_at: 1000,
    updated_at: updatedAt,
    current_step_index: 0,
    total_steps: 2,
    proposal_id: null,
    collaborative: 0,
  };
}

function makeStep(id: string, planId: string, status = StepStatus.Pending, updatedAt = 2000): SyncPlanStep {
  return {
    step_id: `step-${id}`,
    plan_id: `plan-${planId}` as PlanId,
    motebit_id: "test-mote" as MotebitId,
    ordinal: 0,
    description: `Step ${id}`,
    prompt: `Do step ${id}`,
    depends_on: "[]",
    optional: false,
    status,
    required_capabilities: null,
    delegation_task_id: null,
    assigned_motebit_id: null,
    result_summary: null,
    error_message: null,
    tool_calls_made: 0,
    started_at: null,
    completed_at: null,
    retry_count: 0,
    updated_at: updatedAt,
  };
}

describe("PlanSyncEngine", () => {
  it("pushes local plans and steps to remote", async () => {
    const localStore = new InMemoryPlanSyncStore();
    const plan = makePlan("1", 5000);
    const step = makeStep("1", "1");
    localStore.upsertPlan(plan);
    localStore.upsertStep(step);

    const remote: PlanSyncRemoteAdapter = {
      pushPlans: vi.fn().mockResolvedValue(1),
      pullPlans: vi.fn().mockResolvedValue([]),
      pushSteps: vi.fn().mockResolvedValue(1),
      pullSteps: vi.fn().mockResolvedValue([]),
    };

    const engine = new PlanSyncEngine(localStore, "test-mote");
    engine.connectRemote(remote);

    const result = await engine.sync();
    expect(result.plans_pushed).toBe(1);
    expect(result.steps_pushed).toBe(1);
    expect(remote.pushPlans).toHaveBeenCalledWith("test-mote", [plan]);
    expect(remote.pushSteps).toHaveBeenCalledWith("test-mote", [step]);
  });

  it("pulls remote plans and steps into local store", async () => {
    const localStore = new InMemoryPlanSyncStore();
    const remotePlan = makePlan("r1", 3000);
    const remoteStep = makeStep("r1", "r1", StepStatus.Completed, 3000);

    const remote: PlanSyncRemoteAdapter = {
      pushPlans: vi.fn().mockResolvedValue(0),
      pullPlans: vi.fn().mockResolvedValue([remotePlan]),
      pushSteps: vi.fn().mockResolvedValue(0),
      pullSteps: vi.fn().mockResolvedValue([remoteStep]),
    };

    const engine = new PlanSyncEngine(localStore, "test-mote");
    engine.connectRemote(remote);

    const result = await engine.sync();
    expect(result.plans_pulled).toBe(1);
    expect(result.steps_pulled).toBe(1);

    const stored = localStore.plans.get("plan-r1");
    expect(stored).toBeDefined();
    expect(stored!.title).toBe("Plan r1");

    const storedStep = localStore.steps.get("step-r1");
    expect(storedStep).toBeDefined();
    expect(storedStep!.status).toBe(StepStatus.Completed);
  });

  it("plan upsert uses last-writer-wins on updated_at", () => {
    const store = new InMemoryPlanSyncStore();
    store.upsertPlan(makePlan("1", 5000, PlanStatus.Active));
    store.upsertPlan(makePlan("1", 3000, PlanStatus.Failed)); // older — should not overwrite

    const plan = store.plans.get("plan-1");
    expect(plan!.status).toBe(PlanStatus.Active);
    expect(plan!.updated_at).toBe(5000);
  });

  it("step upsert enforces status monotonicity", () => {
    const store = new InMemoryPlanSyncStore();
    store.upsertStep(makeStep("1", "1", StepStatus.Completed, 5000));
    store.upsertStep(makeStep("1", "1", StepStatus.Running, 6000)); // newer but lower status — should not regress

    const step = store.steps.get("step-1");
    expect(step!.status).toBe(StepStatus.Completed);
  });

  it("step upsert allows same-tier update with newer timestamp", () => {
    const store = new InMemoryPlanSyncStore();
    const step1 = makeStep("1", "1", StepStatus.Running, 5000);
    step1.result_summary = "old";
    store.upsertStep(step1);

    const step2 = makeStep("1", "1", StepStatus.Running, 6000);
    step2.result_summary = "new";
    store.upsertStep(step2);

    const step = store.steps.get("step-1");
    expect(step!.result_summary).toBe("new");
    expect(step!.updated_at).toBe(6000);
  });

  it("returns zero counts when no remote adapter", async () => {
    const localStore = new InMemoryPlanSyncStore();
    const engine = new PlanSyncEngine(localStore, "test-mote");

    const result = await engine.sync();
    expect(result).toEqual({
      plans_pushed: 0, plans_pulled: 0, steps_pushed: 0, steps_pulled: 0,
    });
    expect(engine.getStatus()).toBe("offline");
  });

  it("handles sync errors gracefully", async () => {
    const localStore = new InMemoryPlanSyncStore();
    const remote: PlanSyncRemoteAdapter = {
      pushPlans: vi.fn().mockRejectedValue(new Error("Network error")),
      pullPlans: vi.fn(),
      pushSteps: vi.fn(),
      pullSteps: vi.fn(),
    };

    const engine = new PlanSyncEngine(localStore, "test-mote");
    engine.connectRemote(remote);

    const result = await engine.sync();
    expect(result.plans_pushed).toBe(0);
    expect(engine.getStatus()).toBe("error");
  });

  it("status listeners are notified", async () => {
    const localStore = new InMemoryPlanSyncStore();
    const remote: PlanSyncRemoteAdapter = {
      pushPlans: vi.fn().mockResolvedValue(0),
      pullPlans: vi.fn().mockResolvedValue([]),
      pushSteps: vi.fn().mockResolvedValue(0),
      pullSteps: vi.fn().mockResolvedValue([]),
    };

    const engine = new PlanSyncEngine(localStore, "test-mote");
    engine.connectRemote(remote);

    const statuses: string[] = [];
    engine.onStatusChange((s) => statuses.push(s));

    await engine.sync();
    expect(statuses).toEqual(["syncing", "idle"]);
  });
});
