import { PlanStatus, StepStatus } from "@motebit/sdk";
import type { Plan, PlanStep } from "@motebit/sdk";
import type { MotebitLoopDependencies, AgenticChunk } from "@motebit/ai-core";
import { runTurnStreaming } from "@motebit/ai-core";
import type { PlanStoreAdapter } from "./types.js";
import { decomposePlan } from "./decompose.js";
import type { DecompositionContext } from "./decompose.js";
import { reflectOnPlan } from "./reflect.js";
import type { ReflectionResult } from "./reflect.js";

export type PlanChunk =
  | { type: "plan_created"; plan: Plan; steps: PlanStep[] }
  | { type: "plan_truncated"; requestedSteps: number; maxSteps: number }
  | { type: "step_started"; step: PlanStep }
  | { type: "step_chunk"; chunk: AgenticChunk }
  | { type: "step_completed"; step: PlanStep }
  | { type: "step_failed"; step: PlanStep; error: string }
  | { type: "plan_completed"; plan: Plan }
  | { type: "plan_failed"; plan: Plan; reason: string }
  | { type: "approval_request"; step: PlanStep; chunk: AgenticChunk }
  | { type: "plan_retrying"; failedPlan: Plan; newPlan: Plan }
  | { type: "reflection"; result: ReflectionResult };

export interface PlanEngineConfig {
  maxStepRetries?: number;
  maxPlanRetries?: number;
  enableReflection?: boolean;
  /** Maximum number of steps a plan may contain (default 10). */
  maxStepsPerPlan?: number;
}

export class PlanEngine {
  private _isExecuting = false;

  constructor(
    private store: PlanStoreAdapter,
    private config: PlanEngineConfig = {},
  ) {}

  get isExecuting(): boolean {
    return this._isExecuting;
  }

  async createPlan(
    goalId: string,
    motebitId: string,
    ctx: DecompositionContext,
    deps: MotebitLoopDependencies,
  ): Promise<{ plan: Plan; truncatedFrom?: number }> {
    const rawPlan = await decomposePlan(ctx, deps.provider);
    const maxSteps = this.config.maxStepsPerPlan ?? 10;
    let truncatedFrom: number | undefined;
    if (rawPlan.steps.length > maxSteps) {
      truncatedFrom = rawPlan.steps.length;
      rawPlan.steps = rawPlan.steps.slice(0, maxSteps);
    }
    const now = Date.now();
    const planId = crypto.randomUUID();

    const plan: Plan = {
      plan_id: planId,
      goal_id: goalId,
      motebit_id: motebitId,
      title: rawPlan.title,
      status: PlanStatus.Active,
      created_at: now,
      updated_at: now,
      current_step_index: 0,
      total_steps: rawPlan.steps.length,
    };

    this.store.savePlan(plan);

    for (let i = 0; i < rawPlan.steps.length; i++) {
      const rawStep = rawPlan.steps[i]!;
      const step: PlanStep = {
        step_id: crypto.randomUUID(),
        plan_id: planId,
        ordinal: i,
        description: rawStep.description,
        prompt: rawStep.prompt,
        depends_on: i > 0 ? [plan.plan_id + ":" + (i - 1)] : [],
        optional: rawStep.optional ?? false,
        status: StepStatus.Pending,
        result_summary: null,
        error_message: null,
        tool_calls_made: 0,
        started_at: null,
        completed_at: null,
        retry_count: 0,
      };
      this.store.saveStep(step);
    }

    return { plan, truncatedFrom };
  }

  async *executePlan(
    planId: string,
    deps: MotebitLoopDependencies,
    ctx?: DecompositionContext,
    runId?: string,
  ): AsyncGenerator<PlanChunk> {
    const plan = this.store.getPlan(planId);
    if (!plan) throw new Error(`Plan not found: ${planId}`);

    const steps = this.store.getStepsForPlan(planId);

    yield { type: "plan_created", plan, steps };

    yield* this.runSteps(plan, steps, deps, ctx, 0, runId);
  }

  async *resumePlan(
    planId: string,
    deps: MotebitLoopDependencies,
    ctx?: DecompositionContext,
    runId?: string,
  ): AsyncGenerator<PlanChunk> {
    const plan = this.store.getPlan(planId);
    if (!plan) throw new Error(`Plan not found: ${planId}`);
    if (plan.status !== PlanStatus.Active) {
      throw new Error(`Plan ${planId} is not active (status: ${plan.status})`);
    }

    const steps = this.store.getStepsForPlan(planId);
    yield* this.runSteps(plan, steps, deps, ctx, 0, runId);
  }

  private async *runSteps(
    plan: Plan,
    steps: PlanStep[],
    deps: MotebitLoopDependencies,
    ctx?: DecompositionContext,
    planRetryCount: number = 0,
    runId?: string,
  ): AsyncGenerator<PlanChunk> {
    this._isExecuting = true;
    const maxRetries = this.config.maxStepRetries ?? 2;
    const maxPlanRetries = this.config.maxPlanRetries ?? 1;
    const enableReflection = this.config.enableReflection ?? true;
    const completedResults: string[] = [];

    try {
      for (let i = plan.current_step_index; i < steps.length; i++) {
        const step = steps[i]!;

        // Skip already completed/skipped steps (for resume)
        if (step.status === StepStatus.Completed || step.status === StepStatus.Skipped) {
          if (step.result_summary) {
            completedResults.push(`[Step ${step.ordinal + 1}: ${step.description}]\n${step.result_summary}`);
          }
          continue;
        }

        // Check dependencies
        if (!this.areDependenciesMet(step)) {
          if (step.optional) {
            this.store.updateStep(step.step_id, { status: StepStatus.Skipped });
            continue;
          }
          // Required step with unmet deps — fail plan
          const reason = `Unmet dependencies for step ${step.ordinal + 1}`;
          this.failPlan(plan, reason);
          yield { type: "plan_failed", plan: this.store.getPlan(plan.plan_id)!, reason };
          return;
        }

        // Execute step with retries
        let stepSucceeded = false;
        let lastError = "";

        for (let attempt = 0; attempt <= maxRetries; attempt++) {
          if (attempt > 0) {
            this.store.updateStep(step.step_id, { retry_count: attempt });
          }

          // Mark step as running
          const startedAt = Date.now();
          this.store.updateStep(step.step_id, {
            status: StepStatus.Running,
            started_at: startedAt,
          });
          this.store.updatePlan(plan.plan_id, {
            current_step_index: i,
            updated_at: startedAt,
          });

          const updatedStep = this.store.getStep(step.step_id)!;
          yield { type: "step_started", step: updatedStep };

          try {
            const result = yield* this.executeStep(updatedStep, completedResults, deps, runId);

            if (result.suspended) {
              // Approval request — pause plan, caller will resumePlan later
              this.store.updatePlan(plan.plan_id, { updated_at: Date.now() });
              return;
            }

            // Step completed successfully
            const summary = result.responseText.slice(0, 2000);
            this.store.updateStep(step.step_id, {
              status: StepStatus.Completed,
              completed_at: Date.now(),
              result_summary: summary || null,
              tool_calls_made: result.toolCallsMade,
            });

            completedResults.push(`[Step ${step.ordinal + 1}: ${step.description}]\n${summary}`);

            const completedStep = this.store.getStep(step.step_id)!;
            yield { type: "step_completed", step: completedStep };
            stepSucceeded = true;
            break;
          } catch (err: unknown) {
            lastError = err instanceof Error ? err.message : String(err);
            if (attempt < maxRetries) {
              continue;
            }
          }
        }

        if (!stepSucceeded) {
          this.store.updateStep(step.step_id, {
            status: StepStatus.Failed,
            completed_at: Date.now(),
            error_message: lastError,
          });

          const failedStep = this.store.getStep(step.step_id)!;
          yield { type: "step_failed", step: failedStep, error: lastError };

          if (!step.optional) {
            this.failPlan(plan, `Required step ${step.ordinal + 1} failed: ${lastError}`);
            const failedPlan = this.store.getPlan(plan.plan_id)!;

            // Adaptive re-planning: retry with failure context if we have a decomposition context
            if (ctx && planRetryCount < maxPlanRetries) {
              const retryOutcomes = this.buildRetryOutcomes(plan, steps, step, lastError, completedResults);
              const retryCtx: DecompositionContext = {
                ...ctx,
                previousOutcomes: retryOutcomes,
              };

              try {
                const { plan: newPlan, truncatedFrom: retryTruncated } = await this.createPlan(plan.goal_id, plan.motebit_id, retryCtx, deps);
                yield { type: "plan_retrying", failedPlan, newPlan };
                if (retryTruncated) {
                  yield { type: "plan_truncated", requestedSteps: retryTruncated, maxSteps: this.config.maxStepsPerPlan ?? 10 };
                }

                const newSteps = this.store.getStepsForPlan(newPlan.plan_id);
                yield { type: "plan_created", plan: newPlan, steps: newSteps };
                yield* this.runSteps(newPlan, newSteps, deps, ctx, planRetryCount + 1, runId);
                return;
              } catch {
                // Re-planning itself failed — fall through to plan_failed
              }
            }

            yield { type: "plan_failed", plan: failedPlan, reason: lastError };
            return;
          }

          // Optional step failed — skip and continue
          this.store.updateStep(step.step_id, { status: StepStatus.Skipped });
        }
      }

      // All steps done — mark plan completed
      this.store.updatePlan(plan.plan_id, {
        status: PlanStatus.Completed,
        updated_at: Date.now(),
      });
      const completedPlan = this.store.getPlan(plan.plan_id)!;
      yield { type: "plan_completed", plan: completedPlan };

      // Post-execution reflection
      if (enableReflection) {
        try {
          const allSteps = this.store.getStepsForPlan(plan.plan_id);
          const result = await reflectOnPlan(completedPlan, allSteps, deps.provider);
          yield { type: "reflection", result };
        } catch {
          // Reflection failure should never break the plan flow
        }
      }
    } finally {
      this._isExecuting = false;
    }
  }

  private buildRetryOutcomes(
    plan: Plan,
    steps: PlanStep[],
    failedStep: PlanStep,
    error: string,
    completedResults: string[],
  ): string[] {
    const outcomes: string[] = [];
    outcomes.push(`Original plan "${plan.title}" failed at step ${failedStep.ordinal + 1}: ${failedStep.description}`);
    outcomes.push(`Error: ${error}`);

    if (completedResults.length > 0) {
      outcomes.push(`Completed steps before failure:`);
      for (const result of completedResults) {
        // Trim each result to keep context manageable
        outcomes.push(result.length > 300 ? result.slice(0, 300) + "..." : result);
      }
    }

    // Include info about remaining steps that were never reached
    const remainingSteps = steps.filter((s) => s.ordinal > failedStep.ordinal);
    if (remainingSteps.length > 0) {
      outcomes.push(`Steps not reached: ${remainingSteps.map((s) => s.description).join(", ")}`);
    }

    return outcomes;
  }

  private async *executeStep(
    step: PlanStep,
    priorResults: string[],
    deps: MotebitLoopDependencies,
    runId?: string,
  ): AsyncGenerator<PlanChunk, { suspended: boolean; toolCallsMade: number; responseText: string }> {
    // Build step prompt with accumulated context
    const contextParts: string[] = [];
    if (priorResults.length > 0) {
      // Cap accumulated context at ~16KB
      let accumulated = priorResults.join("\n\n");
      if (accumulated.length > 16384) {
        accumulated = accumulated.slice(-16384);
      }
      contextParts.push("Previous step results:\n" + accumulated);
      contextParts.push("");
    }
    contextParts.push(`Current step: ${step.description}`);
    contextParts.push("");
    contextParts.push(step.prompt);

    const stepPrompt = contextParts.join("\n");

    // Build conversation history from prior results
    const conversationHistory = priorResults.map((r) => ({
      role: "assistant" as const,
      content: r,
    }));

    const stream = runTurnStreaming(deps, stepPrompt, {
      conversationHistory: conversationHistory.length > 0 ? conversationHistory : undefined,
      runId,
    });

    let responseText = "";
    let toolCallsMade = 0;

    for await (const chunk of stream) {
      if (chunk.type === "text") {
        responseText += chunk.text;
      }
      if (chunk.type === "tool_status" && chunk.status === "calling") {
        toolCallsMade++;
      }
      if (chunk.type === "approval_request") {
        yield { type: "approval_request", step, chunk };
        return { suspended: true, toolCallsMade, responseText };
      }
      yield { type: "step_chunk", chunk };
    }

    return { suspended: false, toolCallsMade, responseText };
  }

  private areDependenciesMet(step: PlanStep): boolean {
    // Simple sequential dependency: all prior steps must be completed or skipped
    const allSteps = this.store.getStepsForPlan(step.plan_id);
    for (const prior of allSteps) {
      if (prior.ordinal >= step.ordinal) break;
      if (prior.status !== StepStatus.Completed && prior.status !== StepStatus.Skipped) {
        return false;
      }
    }
    return true;
  }

  private failPlan(plan: Plan, _reason: string): void {
    this.store.updatePlan(plan.plan_id, {
      status: PlanStatus.Failed,
      updated_at: Date.now(),
    });
  }
}
