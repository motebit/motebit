import { StepStatus, PlanStatus } from "@motebit/sdk";
import type { Plan, PlanStep } from "@motebit/sdk";

export interface PlanStoreAdapter {
  savePlan(plan: Plan): void;
  getPlan(planId: string): Plan | null;
  getPlanForGoal(goalId: string): Plan | null;
  updatePlan(planId: string, updates: Partial<Plan>): void;
  saveStep(step: PlanStep): void;
  getStep(stepId: string): PlanStep | null;
  getStepsForPlan(planId: string): PlanStep[];
  updateStep(stepId: string, updates: Partial<PlanStep>): void;
  getNextPendingStep(planId: string): PlanStep | null;
  /** List all active plans for a motebit. Optional — returns [] if not implemented. */
  listActivePlans?(motebitId: string): Plan[];
}

export class InMemoryPlanStore implements PlanStoreAdapter {
  private plans = new Map<string, Plan>();
  private steps = new Map<string, PlanStep>();

  savePlan(plan: Plan): void {
    this.plans.set(plan.plan_id, { ...plan });
  }

  getPlan(planId: string): Plan | null {
    const p = this.plans.get(planId);
    return p ? { ...p } : null;
  }

  getPlanForGoal(goalId: string): Plan | null {
    for (const plan of this.plans.values()) {
      if (plan.goal_id === goalId) return { ...plan };
    }
    return null;
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
