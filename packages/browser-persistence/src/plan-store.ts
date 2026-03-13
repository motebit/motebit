import type { PlanStoreAdapter } from "@motebit/planner";
import type { Plan, PlanStep } from "@motebit/sdk";
import { StepStatus, PlanStatus } from "@motebit/sdk";
import { idbRequest } from "./idb.js";

/**
 * IDB-backed PlanStore with preload+cache pattern.
 *
 * PlanStoreAdapter has sync methods but IDB is async.
 * Preload all plans/steps into Maps at bootstrap, then serve sync reads
 * from cache with write-through to IDB (fire-and-forget).
 */
export class IdbPlanStore implements PlanStoreAdapter {
  private _plans = new Map<string, Plan>();
  private _steps = new Map<string, PlanStep>();
  private _goalIndex = new Map<string, string>(); // goalId -> planId

  constructor(private db: IDBDatabase) {}

  /** Preload all plans + steps for a motebit into cache. Call before runtime construction. */
  async preload(motebitId: string): Promise<void> {
    const tx = this.db.transaction(["plans", "plan_steps"], "readonly");
    const planStore = tx.objectStore("plans");
    const stepStore = tx.objectStore("plan_steps");

    const planIndex = planStore.index("motebit_id");
    const allPlans = (await idbRequest(planIndex.getAll(motebitId))) as Plan[];

    for (const plan of allPlans) {
      this._plans.set(plan.plan_id, plan);
      this._goalIndex.set(plan.goal_id, plan.plan_id);

      const stepIndex = stepStore.index("plan_id");
      const steps = (await idbRequest(stepIndex.getAll(plan.plan_id))) as PlanStep[];
      for (const step of steps) {
        this._steps.set(step.step_id, step);
      }
    }
  }

  savePlan(plan: Plan): void {
    this._plans.set(plan.plan_id, { ...plan });
    this._goalIndex.set(plan.goal_id, plan.plan_id);
    const tx = this.db.transaction("plans", "readwrite");
    tx.objectStore("plans").put({ ...plan });
  }

  getPlan(planId: string): Plan | null {
    const p = this._plans.get(planId);
    return p ? { ...p } : null;
  }

  getPlanForGoal(goalId: string): Plan | null {
    const planId = this._goalIndex.get(goalId);
    if (planId == null) return null;
    return this.getPlan(planId);
  }

  updatePlan(planId: string, updates: Partial<Plan>): void {
    const existing = this._plans.get(planId);
    if (!existing) return;
    const updated = { ...existing, ...updates };
    this._plans.set(planId, updated);
    if (updates.goal_id != null) {
      this._goalIndex.set(updates.goal_id, planId);
    }
    const tx = this.db.transaction("plans", "readwrite");
    tx.objectStore("plans").put({ ...updated });
  }

  saveStep(step: PlanStep): void {
    this._steps.set(step.step_id, { ...step });
    const tx = this.db.transaction("plan_steps", "readwrite");
    tx.objectStore("plan_steps").put({ ...step });
  }

  getStep(stepId: string): PlanStep | null {
    const s = this._steps.get(stepId);
    return s ? { ...s } : null;
  }

  getStepsForPlan(planId: string): PlanStep[] {
    const result: PlanStep[] = [];
    for (const step of this._steps.values()) {
      if (step.plan_id === planId) result.push({ ...step });
    }
    return result.sort((a, b) => a.ordinal - b.ordinal);
  }

  updateStep(stepId: string, updates: Partial<PlanStep>): void {
    const existing = this._steps.get(stepId);
    if (!existing) return;
    const updated = { ...existing, ...updates };
    this._steps.set(stepId, updated);
    const tx = this.db.transaction("plan_steps", "readwrite");
    tx.objectStore("plan_steps").put({ ...updated });
  }

  getNextPendingStep(planId: string): PlanStep | null {
    const steps = this.getStepsForPlan(planId);
    return steps.find((s) => s.status === StepStatus.Pending) ?? null;
  }

  listActivePlans(motebitId: string): Plan[] {
    const result: Plan[] = [];
    for (const plan of this._plans.values()) {
      if (plan.motebit_id === motebitId && plan.status === PlanStatus.Active) {
        result.push({ ...plan });
      }
    }
    return result;
  }
}
