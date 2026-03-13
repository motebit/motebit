import { PlanStatus, StepStatus } from "@motebit/sdk";
import type { Plan, PlanStep, DeviceCapability, DelegatedStepResult } from "@motebit/sdk";
import type { MotebitLoopDependencies, AgenticChunk } from "@motebit/ai-core";
import { runTurnStreaming } from "@motebit/ai-core";
import type { PlanStoreAdapter } from "./types.js";
import type { CollaborativeDelegationAdapter } from "./delegation-adapter.js";
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
  | { type: "reflection"; result: ReflectionResult }
  | { type: "step_delegated"; step: PlanStep; task_id: string };

export interface StepDelegationAdapter {
  delegateStep(
    step: PlanStep,
    timeoutMs: number,
    onTaskSubmitted?: (taskId: string) => void,
  ): Promise<DelegatedStepResult>;
  /** Poll relay for a previously-submitted task's result. Returns null if task not found or still pending. */
  pollTaskResult?(taskId: string, stepId: string): Promise<DelegatedStepResult | null>;
}

export interface PlanEngineConfig {
  maxStepRetries?: number;
  maxPlanRetries?: number;
  enableReflection?: boolean;
  /** Maximum number of steps a plan may contain (default 10). */
  maxStepsPerPlan?: number;
  localCapabilities?: DeviceCapability[];
  delegationAdapter?: StepDelegationAdapter;
  /** Timeout for delegated steps in ms (default 300000 = 5 min). */
  delegationTimeoutMs?: number;
  collaborativeAdapter?: CollaborativeDelegationAdapter;
  localMotebitId?: string;
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

  setLocalCapabilities(caps: DeviceCapability[]): void {
    this.config = { ...this.config, localCapabilities: caps };
  }

  setDelegationAdapter(adapter: StepDelegationAdapter | undefined): void {
    this.config = { ...this.config, delegationAdapter: adapter };
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
        required_capabilities: rawStep.required_capabilities?.map((c) => c as DeviceCapability),
        status: StepStatus.Pending,
        result_summary: null,
        error_message: null,
        tool_calls_made: 0,
        started_at: null,
        completed_at: null,
        retry_count: 0,
        updated_at: now,
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
          if (step.result_summary != null && step.result_summary !== "") {
            completedResults.push(
              `[Step ${step.ordinal + 1}: ${step.description}]\n${step.result_summary}`,
            );
          }
          continue;
        }

        // Skip steps assigned to other agents in collaborative plans
        if (
          step.assigned_motebit_id != null &&
          this.config.localMotebitId != null &&
          step.assigned_motebit_id !== this.config.localMotebitId
        ) {
          // This step belongs to another participant — wait for their result
          continue;
        }

        // Check dependencies
        if (!this.areDependenciesMet(step)) {
          if (step.optional) {
            this.store.updateStep(step.step_id, {
              status: StepStatus.Skipped,
              updated_at: Date.now(),
            });
            continue;
          }
          // Required step with unmet deps — fail plan
          const reason = `Unmet dependencies for step ${step.ordinal + 1}`;
          this.failPlan(plan, reason);
          yield { type: "plan_failed", plan: this.store.getPlan(plan.plan_id)!, reason };
          return;
        }

        // Check if step requires capabilities we don't have locally
        const localCaps = this.config.localCapabilities ?? [];
        const requiredCaps = step.required_capabilities ?? [];
        const missingCaps = requiredCaps.filter((c) => !localCaps.includes(c));

        if (missingCaps.length > 0) {
          const delegationAdapter = this.config.delegationAdapter;
          if (!delegationAdapter) {
            // No delegation adapter — fail step
            const capsStr = missingCaps.join(", ");
            this.store.updateStep(step.step_id, {
              status: StepStatus.Failed,
              completed_at: Date.now(),
              error_message: `Requires capabilities not available locally: ${capsStr}`,
              updated_at: Date.now(),
            });
            const failedStep = this.store.getStep(step.step_id)!;
            yield { type: "step_failed", step: failedStep, error: failedStep.error_message! };

            if (!step.optional) {
              this.failPlan(
                plan,
                `Required step ${step.ordinal + 1} requires [${capsStr}] not available locally`,
              );
              yield {
                type: "plan_failed",
                plan: this.store.getPlan(plan.plan_id)!,
                reason: failedStep.error_message!,
              };
              return;
            }
            this.store.updateStep(step.step_id, {
              status: StepStatus.Skipped,
              updated_at: Date.now(),
            });
            continue;
          }

          // Delegate step to a capable device
          const startedAt = Date.now();
          this.store.updateStep(step.step_id, {
            status: StepStatus.Running,
            started_at: startedAt,
            updated_at: startedAt,
          });
          this.store.updatePlan(plan.plan_id, { current_step_index: i, updated_at: startedAt });
          const updatedStep = this.store.getStep(step.step_id)!;
          yield { type: "step_started", step: updatedStep };

          try {
            const timeoutMs = this.config.delegationTimeoutMs ?? 300_000;
            const delegationResult = await delegationAdapter.delegateStep(
              updatedStep,
              timeoutMs,
              (taskId) => {
                // Persist task_id immediately so recovery can find it if we crash/close
                this.store.updateStep(step.step_id, {
                  delegation_task_id: taskId,
                  updated_at: Date.now(),
                });
              },
            );

            const summary = delegationResult.result_text.slice(0, 2000);
            this.store.updateStep(step.step_id, {
              status: StepStatus.Completed,
              completed_at: Date.now(),
              result_summary: summary || null,
              updated_at: Date.now(),
            });
            completedResults.push(`[Step ${step.ordinal + 1}: ${step.description}]\n${summary}`);

            const completedStep = this.store.getStep(step.step_id)!;
            yield {
              type: "step_delegated",
              step: completedStep,
              task_id: delegationResult.task_id,
            };
            yield { type: "step_completed", step: completedStep };
          } catch (err: unknown) {
            const errMsg = err instanceof Error ? err.message : String(err);
            this.store.updateStep(step.step_id, {
              status: StepStatus.Failed,
              completed_at: Date.now(),
              error_message: errMsg,
              updated_at: Date.now(),
            });
            const failedStep = this.store.getStep(step.step_id)!;
            yield { type: "step_failed", step: failedStep, error: errMsg };

            if (!step.optional) {
              this.failPlan(plan, `Delegated step ${step.ordinal + 1} failed: ${errMsg}`);
              yield {
                type: "plan_failed",
                plan: this.store.getPlan(plan.plan_id)!,
                reason: errMsg,
              };
              return;
            }
            this.store.updateStep(step.step_id, {
              status: StepStatus.Skipped,
              updated_at: Date.now(),
            });
          }
          continue;
        }

        // Execute step with retries
        let stepSucceeded = false;
        let lastError = "";

        for (let attempt = 0; attempt <= maxRetries; attempt++) {
          if (attempt > 0) {
            this.store.updateStep(step.step_id, { retry_count: attempt, updated_at: Date.now() });
          }

          // Mark step as running
          const startedAt = Date.now();
          this.store.updateStep(step.step_id, {
            status: StepStatus.Running,
            started_at: startedAt,
            updated_at: startedAt,
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
              updated_at: Date.now(),
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
            updated_at: Date.now(),
          });

          const failedStep = this.store.getStep(step.step_id)!;
          yield { type: "step_failed", step: failedStep, error: lastError };

          if (!step.optional) {
            this.failPlan(plan, `Required step ${step.ordinal + 1} failed: ${lastError}`);
            const failedPlan = this.store.getPlan(plan.plan_id)!;

            // Adaptive re-planning: retry with failure context if we have a decomposition context
            if (ctx && planRetryCount < maxPlanRetries) {
              const retryOutcomes = this.buildRetryOutcomes(
                plan,
                steps,
                step,
                lastError,
                completedResults,
              );
              const retryCtx: DecompositionContext = {
                ...ctx,
                previousOutcomes: retryOutcomes,
              };

              try {
                const { plan: newPlan, truncatedFrom: retryTruncated } = await this.createPlan(
                  plan.goal_id,
                  plan.motebit_id,
                  retryCtx,
                  deps,
                );
                yield { type: "plan_retrying", failedPlan, newPlan };
                if (retryTruncated != null) {
                  yield {
                    type: "plan_truncated",
                    requestedSteps: retryTruncated,
                    maxSteps: this.config.maxStepsPerPlan ?? 10,
                  };
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
          this.store.updateStep(step.step_id, {
            status: StepStatus.Skipped,
            updated_at: Date.now(),
          });
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
    outcomes.push(
      `Original plan "${plan.title}" failed at step ${failedStep.ordinal + 1}: ${failedStep.description}`,
    );
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
  ): AsyncGenerator<
    PlanChunk,
    { suspended: boolean; toolCallsMade: number; responseText: string }
  > {
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

  /**
   * Recover delegated steps that were orphaned (e.g. tab closed during delegation).
   * Scans active plans for Running steps with a delegation_task_id, polls the relay
   * for their results, and resumes the plan if all delegations are resolved.
   */
  async *recoverDelegatedSteps(
    motebitId: string,
    deps: MotebitLoopDependencies,
  ): AsyncGenerator<PlanChunk> {
    const adapter = this.config.delegationAdapter;
    if (!adapter?.pollTaskResult) return;
    if (!this.store.listActivePlans) return;

    const activePlans = this.store.listActivePlans(motebitId);

    for (const plan of activePlans) {
      const steps = this.store.getStepsForPlan(plan.plan_id);
      let recoveredAny = false;

      for (const step of steps) {
        if (step.status !== StepStatus.Running) continue;
        if (step.delegation_task_id == null || step.delegation_task_id === "") continue;

        // This step was delegated but we lost the listener — poll relay
        const result = await adapter.pollTaskResult(step.delegation_task_id, step.step_id);

        if (result != null) {
          // Task completed (or failed) while we were away
          const summary = result.result_text.slice(0, 2000);

          if (result.receipt.status === "completed") {
            this.store.updateStep(step.step_id, {
              status: StepStatus.Completed,
              completed_at: Date.now(),
              result_summary: summary || null,
              updated_at: Date.now(),
            });
            yield {
              type: "step_delegated",
              step: this.store.getStep(step.step_id)!,
              task_id: result.task_id,
            };
            yield { type: "step_completed", step: this.store.getStep(step.step_id)! };
          } else {
            this.store.updateStep(step.step_id, {
              status: StepStatus.Failed,
              completed_at: Date.now(),
              error_message: `Delegated step ${result.receipt.status}: ${summary}`,
              updated_at: Date.now(),
            });
            yield { type: "step_failed", step: this.store.getStep(step.step_id)!, error: summary };
          }
          recoveredAny = true;
        }
        // If null, task not found on relay (expired or never submitted) — leave as Running,
        // will be cleaned up by the caller or a future housekeeping pass
      }

      if (recoveredAny) {
        // Check if the plan can continue — resume from where it left off
        const updatedSteps = this.store.getStepsForPlan(plan.plan_id);
        const hasRunning = updatedSteps.some((s) => s.status === StepStatus.Running);
        const hasFailed = updatedSteps.some((s) => s.status === StepStatus.Failed && !s.optional);

        if (hasFailed) {
          this.failPlan(plan, "Recovered delegated step failed");
          yield {
            type: "plan_failed",
            plan: this.store.getPlan(plan.plan_id)!,
            reason: "Recovered delegated step failed",
          };
        } else if (!hasRunning) {
          // No more running steps — resume plan execution for remaining pending steps
          yield* this.resumePlan(plan.plan_id, deps);
        }
      }
    }
  }

  setCollaborativeAdapter(adapter: CollaborativeDelegationAdapter | undefined): void {
    this.config = { ...this.config, collaborativeAdapter: adapter };
  }

  setLocalMotebitId(motebitId: string): void {
    this.config = { ...this.config, localMotebitId: motebitId };
  }

  /**
   * Execute only the steps assigned to the local motebit in a collaborative plan.
   * Posts results back to the relay via the collaborative adapter.
   */
  async *executeCollaborativeSteps(
    plan: Plan,
    steps: PlanStep[],
    localMotebitId: string,
    deps: MotebitLoopDependencies,
    runId?: string,
  ): AsyncGenerator<PlanChunk> {
    const adapter = this.config.collaborativeAdapter;
    const localSteps = steps.filter(
      (s) => s.assigned_motebit_id === localMotebitId && s.status === StepStatus.Pending,
    );

    this._isExecuting = true;
    const completedResults: string[] = [];

    try {
      for (const step of localSteps) {
        // Check dependencies
        if (!this.areDependenciesMet(step)) {
          continue; // Will be picked up on next pass
        }

        const startedAt = Date.now();
        this.store.updateStep(step.step_id, {
          status: StepStatus.Running,
          started_at: startedAt,
          updated_at: startedAt,
        });

        const updatedStep = this.store.getStep(step.step_id)!;
        yield { type: "step_started", step: updatedStep };

        try {
          const result = yield* this.executeStep(updatedStep, completedResults, deps, runId);

          if (result.suspended) {
            return;
          }

          const summary = result.responseText.slice(0, 2000);
          this.store.updateStep(step.step_id, {
            status: StepStatus.Completed,
            completed_at: Date.now(),
            result_summary: summary || null,
            tool_calls_made: result.toolCallsMade,
            updated_at: Date.now(),
          });

          completedResults.push(`[Step ${step.ordinal + 1}: ${step.description}]\n${summary}`);

          const completedStep = this.store.getStep(step.step_id)!;
          yield { type: "step_completed", step: completedStep };

          // Post result to relay
          if (adapter && plan.proposal_id) {
            try {
              await adapter.postStepResult(plan.proposal_id, step.step_id, {
                status: "completed",
                result_summary: summary,
              });
            } catch {
              // Best-effort posting
            }
          }
        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : String(err);
          this.store.updateStep(step.step_id, {
            status: StepStatus.Failed,
            completed_at: Date.now(),
            error_message: errMsg,
            updated_at: Date.now(),
          });

          const failedStep = this.store.getStep(step.step_id)!;
          yield { type: "step_failed", step: failedStep, error: errMsg };

          // Post failure to relay
          if (adapter && plan.proposal_id) {
            try {
              await adapter.postStepResult(plan.proposal_id, step.step_id, {
                status: "failed",
                result_summary: errMsg,
              });
            } catch {
              // Best-effort posting
            }
          }
        }
      }
    } finally {
      this._isExecuting = false;
    }
  }

  private failPlan(plan: Plan, _reason: string): void {
    this.store.updatePlan(plan.plan_id, {
      status: PlanStatus.Failed,
      updated_at: Date.now(),
    });
  }
}
