import { StepStatus, PlanStatus } from "@motebit/sdk";
import type { Plan, PlanStep, PlanStoreAdapter } from "@motebit/sdk";

export type { PlanStoreAdapter } from "@motebit/sdk";

export class InMemoryPlanStore implements PlanStoreAdapter {
  private plans = new Map<string, Plan>();
  private steps = new Map<string, PlanStep>();
  private leases = new Map<string, { holder: string; expiresAt: number }>();

  /**
   * Cross-driver plan lease, compare-and-set (#890; `PlanLeaseStore`). Free,
   * expired, or already ours ⇒ taken (or renewed); otherwise refused.
   */
  acquirePlanLease(planId: string, holder: string, now: number, ttlMs: number): boolean {
    const cur = this.leases.get(planId);
    if (cur != null && cur.holder !== holder && cur.expiresAt > now) return false;
    this.leases.set(planId, { holder, expiresAt: now + ttlMs });
    return true;
  }

  releasePlanLease(planId: string, holder: string): void {
    if (this.leases.get(planId)?.holder === holder) this.leases.delete(planId);
  }

  savePlan(plan: Plan): void {
    // A plan saved without a stamp keeps the one on record (never erased).
    const sensitivity = plan.sensitivity ?? this.plans.get(plan.plan_id)?.sensitivity;
    this.plans.set(plan.plan_id, sensitivity != null ? { ...plan, sensitivity } : { ...plan });
  }

  getPlan(planId: string): Plan | null {
    const p = this.plans.get(planId);
    return p ? { ...p } : null;
  }

  getPlanForGoal(goalId: string): Plan | null {
    // The goal's MOST RECENT plan, as the SQLite stores answer it
    // (`ORDER BY created_at DESC`). Returning the first one inserted made a
    // runner resume — or re-plan past — a stale plan, and hid a newer plan
    // holding a delegated step with an unknown paid outcome (#890).
    let latest: Plan | null = null;
    for (const plan of this.plans.values()) {
      if (plan.goal_id !== goalId) continue;
      if (latest == null || plan.created_at >= latest.created_at) latest = plan;
    }
    return latest != null ? { ...latest } : null;
  }

  updatePlan(planId: string, updates: Partial<Plan>): void {
    const existing = this.plans.get(planId);
    if (!existing) return;
    this.plans.set(planId, { ...existing, ...updates });
  }

  saveStep(step: PlanStep): void {
    this.steps.set(step.step_id, { ...step });
  }

  getStep(stepId: string): PlanStep | null {
    const s = this.steps.get(stepId);
    return s ? { ...s } : null;
  }

  getStepsForPlan(planId: string): PlanStep[] {
    const result: PlanStep[] = [];
    for (const step of this.steps.values()) {
      if (step.plan_id === planId) result.push({ ...step });
    }
    return result.sort((a, b) => a.ordinal - b.ordinal);
  }

  updateStep(stepId: string, updates: Partial<PlanStep>): void {
    const existing = this.steps.get(stepId);
    if (!existing) return;
    this.steps.set(stepId, { ...existing, ...updates });
  }

  getNextPendingStep(planId: string): PlanStep | null {
    const steps = this.getStepsForPlan(planId);
    return steps.find((s) => s.status === StepStatus.Pending) ?? null;
  }

  listActivePlans(motebitId: string): Plan[] {
    const result: Plan[] = [];
    for (const plan of this.plans.values()) {
      if (plan.motebit_id === motebitId && plan.status === PlanStatus.Active) {
        result.push({ ...plan });
      }
    }
    return result;
  }
}
