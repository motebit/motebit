import type { SyncPlan, SyncPlanStep, Plan, PlanStep } from "@motebit/sdk";
import type { IdbPlanStore } from "./plan-store.js";

/**
 * IDB-backed plan sync store adapter.
 * Bridges IdbPlanStore to the PlanSyncEngine's sync interface.
 *
 * Uses the IdbPlanStore's in-memory cache for reads (preloaded at bootstrap).
 * Write-through to IDB on upserts.
 *
 * Duck-typed to match PlanSyncStoreAdapter from @motebit/sync-engine
 * (browser-persistence doesn't depend on sync-engine).
 */
export class IdbPlanSyncStore {
  constructor(
    private planStore: IdbPlanStore,
    private motebitId: string,
  ) {}

  getPlansSince(_motebitId: string, since: number): SyncPlan[] {
    // Access the cache via the public API — list all plans, filter by updated_at
    const allPlans = this.planStore.listAllPlans(this.motebitId);
    return allPlans
      .filter((p) => p.updated_at > since)
      .map(planToSync);
  }

  getStepsSince(_motebitId: string, since: number): SyncPlanStep[] {
    // Get all plans changed since last sync, then get their steps
    const changedPlans = this.planStore.listAllPlans(this.motebitId)
      .filter((p) => p.updated_at > since);

    const result: SyncPlanStep[] = [];
    for (const plan of changedPlans) {
      const steps = this.planStore.getStepsForPlan(plan.plan_id);
      for (const step of steps) {
        const stepUpdatedAt = step.completed_at ?? step.started_at ?? plan.created_at;
        if (stepUpdatedAt > since) {
          result.push(stepToSync(step, this.motebitId, stepUpdatedAt));
        }
      }
    }
    return result.sort((a, b) => a.updated_at - b.updated_at);
  }

  upsertPlan(plan: SyncPlan): void {
    const existing = this.planStore.getPlan(plan.plan_id);
    if (!existing) {
      this.planStore.savePlan(syncToPlan(plan));
      return;
    }
    // Last-writer-wins on updated_at
    if (plan.updated_at >= existing.updated_at) {
      this.planStore.updatePlan(plan.plan_id, syncToPlan(plan));
    }
  }

  upsertStep(step: SyncPlanStep): void {
    const existing = this.planStore.getStep(step.step_id);
    if (!existing) {
      this.planStore.saveStep(syncToStep(step));
      return;
    }
    // Status monotonicity
    const incomingOrder = STEP_STATUS_ORDER[step.status] ?? 0;
    const existingOrder = STEP_STATUS_ORDER[existing.status] ?? 0;
    if (incomingOrder < existingOrder) return;
    if (incomingOrder === existingOrder) {
      const existingUpdatedAt = existing.completed_at ?? existing.started_at ?? 0;
      if (step.updated_at < existingUpdatedAt) return;
    }
    this.planStore.updateStep(step.step_id, syncToStep(step));
  }
}

const STEP_STATUS_ORDER: Record<string, number> = {
  pending: 0, running: 1, completed: 2, failed: 2, skipped: 2,
};

function planToSync(plan: Plan): SyncPlan {
  return {
    plan_id: plan.plan_id,
    goal_id: plan.goal_id,
    motebit_id: plan.motebit_id,
    title: plan.title,
    status: plan.status,
    created_at: plan.created_at,
    updated_at: plan.updated_at,
    current_step_index: plan.current_step_index,
    total_steps: plan.total_steps,
  };
}

function stepToSync(step: PlanStep, motebitId: string, updatedAt: number): SyncPlanStep {
  return {
    step_id: step.step_id,
    plan_id: step.plan_id,
    motebit_id: motebitId,
    ordinal: step.ordinal,
    description: step.description,
    prompt: step.prompt,
    depends_on: JSON.stringify(step.depends_on),
    optional: step.optional,
    status: step.status,
    required_capabilities: step.required_capabilities != null
      ? JSON.stringify(step.required_capabilities) : null,
    delegation_task_id: step.delegation_task_id ?? null,
    result_summary: step.result_summary,
    error_message: step.error_message,
    tool_calls_made: step.tool_calls_made,
    started_at: step.started_at,
    completed_at: step.completed_at,
    retry_count: step.retry_count,
    updated_at: updatedAt,
  };
}

function syncToPlan(s: SyncPlan): Plan {
  return {
    plan_id: s.plan_id,
    goal_id: s.goal_id,
    motebit_id: s.motebit_id,
    title: s.title,
    status: s.status,
    created_at: s.created_at,
    updated_at: s.updated_at,
    current_step_index: s.current_step_index,
    total_steps: s.total_steps,
  };
}

function syncToStep(s: SyncPlanStep): PlanStep {
  return {
    step_id: s.step_id,
    plan_id: s.plan_id,
    ordinal: s.ordinal,
    description: s.description,
    prompt: s.prompt,
    depends_on: typeof s.depends_on === "string" ? JSON.parse(s.depends_on) as string[] : [],
    optional: s.optional,
    status: s.status,
    required_capabilities: s.required_capabilities != null
      ? JSON.parse(s.required_capabilities) as PlanStep["required_capabilities"] : undefined,
    delegation_task_id: s.delegation_task_id ?? undefined,
    result_summary: s.result_summary,
    error_message: s.error_message,
    tool_calls_made: s.tool_calls_made,
    started_at: s.started_at,
    completed_at: s.completed_at,
    retry_count: s.retry_count,
  };
}
