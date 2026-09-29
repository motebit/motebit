import { PlanStatus, StepStatus } from "@motebit/sdk";
import type {
  Plan,
  PlanStep,
  DeviceCapability,
  DelegatedStepResult,
  ExecutionTimelineEntry,
} from "@motebit/sdk";
import type { MotebitLoopDependencies, AgenticChunk, ResolvedTaskConfig } from "@motebit/ai-core";
import type { SensitivityCleared } from "@motebit/sdk";
import { runTurnStreaming, projectProviderClearance } from "@motebit/ai-core";
import type { PlanStoreAdapter } from "./types.js";
import type { CollaborativeDelegationAdapter } from "./delegation-adapter.js";
import { DelegationUndeterminedError, isDelegationUndetermined } from "./delegation-adapter.js";
import { decomposePlan } from "./decompose.js";
import type { DecompositionContext } from "./decompose.js";
import { reflectOnPlan } from "./reflect.js";
import {
  PROCESS_PLAN_LOCKS,
  DEFAULT_PLAN_LEASE_TTL_MS,
  isPlanLeaseStore,
  type PlanDriverLocks,
} from "./plan-lease.js";
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
  /**
   * Another driver holds this plan's lease (#890): a scheduler's resume and
   * a reconnect's recovery never drive one plan at once. Nothing was run or
   * delegated; not a failure — try again later.
   */
  | { type: "plan_busy"; plan: Plan }
  /**
   * The plan stopped on a delegated step whose paid outcome is UNKNOWN
   * (#890): the relay never confirmed the submission, or an earlier run died
   * mid-submit. Not a failure. The step stays `Running` with its task
   * handle and the plan stays `Active`; resuming the plan settles the step
   * from the relay's signed receipt when one exists, and holds again
   * otherwise. It is never delegated a second time, and `createPlan`
   * refuses a new plan for the goal while it holds. A scheduler must not
   * count this as a failure; the owner is pointed at `/result`.
   */
  | {
      type: "plan_undetermined";
      plan: Plan;
      step: PlanStep;
      reason: string;
      /** The relay task the step's submission was admitted as, when known. */
      task_id?: string;
    }
  | { type: "approval_request"; step: PlanStep; chunk: AgenticChunk }
  | { type: "plan_retrying"; failedPlan: Plan; newPlan: Plan }
  | { type: "reflection"; result: ReflectionResult }
  | {
      type: "step_delegated";
      step: PlanStep;
      task_id: string;
      routing_choice?: DelegatedStepResult["routing_choice"];
    };

export interface StepDelegationAdapter {
  delegateStep(
    step: PlanStep,
    timeoutMs: number,
    onTaskSubmitted?: (taskId: string) => void,
    /** Agents to exclude from routing (accumulated across plan steps). */
    excludeAgents?: string[],
  ): Promise<DelegatedStepResult>;
  /** Poll relay for a previously-submitted task's result. Returns null if task not found or still pending. */
  pollTaskResult?(taskId: string, stepId: string): Promise<DelegatedStepResult | null>;
  /**
   * True when every submission carries the step's DERIVED Idempotency-Key
   * (`planStepIdempotencyKey`), so re-posting a step whose first submission
   * has no known task id replays or names the task it may have admitted —
   * never a second one — within the relay's idempotency window (#890). An
   * adapter that pays before submitting (sovereign pay-forward) must not
   * set it: a re-post there is a second payment.
   */
  readonly resubmitsIdempotently?: boolean;
}

/**
 * How long after a step's first submission a re-post under its derived key
 * is still covered by the relay's idempotency window (24 h there; this
 * keeps a margin). Past it, a key could admit a NEW task, so the step holds.
 */
export const DEFAULT_RESUBMIT_WINDOW_MS = 20 * 60 * 60 * 1000;

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
  /** In-process plan locks (default: the process-wide set). Tests model a process with their own. */
  driverLocks?: PlanDriverLocks;
  /** Clock for the persisted plan lease (default `Date.now`). */
  now?: () => number;
  /** Persisted plan-lease lifetime, renewed each step (default 15 min). */
  planLeaseTtlMs?: number;
  /** See `DEFAULT_RESUBMIT_WINDOW_MS`. */
  resubmitWindowMs?: number;
}

export class PlanEngine {
  private _isExecuting = false;
  private _timeline: ExecutionTimelineEntry[] = [];
  /** This engine's identity as a persisted-lease holder. */
  private readonly _leaseHolder = crypto.randomUUID();
  /** Plans this engine is driving right now. */
  private readonly _driving = new Set<string>();

  /**
   * Take the one-driver lease for a plan (#890): the in-process lock, then
   * the store's persisted lease when it has one. Returns the release, or
   * null when another driver holds the plan.
   */
  private acquireDriver(planId: string): (() => void) | null {
    const locks = this.config.driverLocks ?? PROCESS_PLAN_LOCKS;
    if (!locks.tryAcquire(planId)) return null;
    const store = this.store;
    if (isPlanLeaseStore(store)) {
      let taken = false;
      try {
        taken = store.acquirePlanLease(planId, this._leaseHolder, this.leaseNow(), this.leaseTtl());
      } catch {
        taken = false; // a lease that cannot be read is not ours
      }
      if (!taken) {
        locks.release(planId);
        return null;
      }
    }
    this._driving.add(planId);
    return () => {
      this._driving.delete(planId);
      if (isPlanLeaseStore(store)) {
        try {
          store.releasePlanLease(planId, this._leaseHolder);
        } catch {
          // expires on its own
        }
      }
      locks.release(planId);
    };
  }

  /** Renew the persisted lease before a step; false = lost it, stop driving. */
  private renewDriver(planId: string): boolean {
    if (!this._driving.has(planId)) return true; // a plan this call never leased (re-plan child)
    const store = this.store;
    if (!isPlanLeaseStore(store)) return true;
    try {
      return store.acquirePlanLease(planId, this._leaseHolder, this.leaseNow(), this.leaseTtl());
    } catch {
      return false;
    }
  }

  private leaseNow(): number {
    return (this.config.now ?? Date.now)();
  }

  private leaseTtl(): number {
    return Math.max(
      this.config.planLeaseTtlMs ?? DEFAULT_PLAN_LEASE_TTL_MS,
      3 * (this.config.delegationTimeoutMs ?? 300_000),
    );
  }

  constructor(
    private store: PlanStoreAdapter,
    private config: PlanEngineConfig = {},
  ) {}

  /**
   * Return the accumulated timeline from the last execution and reset.
   * Call this after an executePlan/resumePlan generator is fully consumed.
   */
  takeTimeline(): ExecutionTimelineEntry[] {
    const timeline = this._timeline;
    this._timeline = [];
    return timeline;
  }

  private _pushTimelineEvent(
    type: ExecutionTimelineEntry["type"],
    payload: Record<string, unknown>,
  ): void {
    this._timeline.push({ timestamp: Date.now(), type, payload });
  }

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
    deps: SensitivityCleared<MotebitLoopDependencies>,
    planningConfig?: ResolvedTaskConfig,
  ): Promise<{ plan: Plan; truncatedFrom?: number }> {
    // A goal whose delegated step has an unknown paid outcome gets no new
    // plan: a new plan would delegate — and pay for — the same work again
    // (#890). The held plan is resumed instead, which settles or holds it.
    const held = this.findUnresolvedDelegation(goalId, motebitId);
    if (held != null) {
      throw new DelegationUndeterminedError(held.step.description);
    }
    const rawPlan = await decomposePlan(ctx, projectProviderClearance(deps), planningConfig);
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
    deps: SensitivityCleared<MotebitLoopDependencies>,
    ctx?: DecompositionContext,
    runId?: string,
    reflectionConfig?: ResolvedTaskConfig,
  ): AsyncGenerator<PlanChunk> {
    // Reset timeline for this execution
    this._timeline = [];

    const plan = this.store.getPlan(planId);
    if (!plan) throw new Error(`Plan not found: ${planId}`);

    const steps = this.store.getStepsForPlan(planId);

    this._pushTimelineEvent("plan_created", {
      plan_id: plan.plan_id,
      title: plan.title,
      total_steps: steps.length,
    });

    const release = this.acquireDriver(planId);
    if (release == null) {
      yield { type: "plan_busy", plan };
      return;
    }
    try {
      yield { type: "plan_created", plan, steps };
      yield* this.runSteps(plan, steps, deps, ctx, 0, runId, reflectionConfig);
    } finally {
      release();
    }
  }

  async *resumePlan(
    planId: string,
    deps: SensitivityCleared<MotebitLoopDependencies>,
    ctx?: DecompositionContext,
    runId?: string,
    reflectionConfig?: ResolvedTaskConfig,
  ): AsyncGenerator<PlanChunk> {
    const plan = this.store.getPlan(planId);
    if (!plan) throw new Error(`Plan not found: ${planId}`);
    if (plan.status !== PlanStatus.Active) {
      throw new Error(`Plan ${planId} is not active (status: ${plan.status})`);
    }

    const release = this.acquireDriver(planId);
    if (release == null) {
      yield { type: "plan_busy", plan };
      return;
    }
    try {
      yield* this.resumeLeased(planId, deps, ctx, runId, reflectionConfig);
    } finally {
      release();
    }
  }

  /** Resume a plan whose lease the caller already holds. */
  private async *resumeLeased(
    planId: string,
    deps: SensitivityCleared<MotebitLoopDependencies>,
    ctx?: DecompositionContext,
    runId?: string,
    reflectionConfig?: ResolvedTaskConfig,
  ): AsyncGenerator<PlanChunk> {
    // Re-read under the lease: another driver may have moved it on.
    const plan = this.store.getPlan(planId);
    if (!plan || plan.status !== PlanStatus.Active) return;
    const steps = this.store.getStepsForPlan(planId);
    yield* this.runSteps(plan, steps, deps, ctx, 0, runId, reflectionConfig);
  }

  private async *runSteps(
    plan: Plan,
    steps: PlanStep[],
    deps: SensitivityCleared<MotebitLoopDependencies>,
    ctx?: DecompositionContext,
    planRetryCount: number = 0,
    runId?: string,
    reflectionConfig?: ResolvedTaskConfig,
  ): AsyncGenerator<PlanChunk> {
    this._isExecuting = true;
    const maxRetries = this.config.maxStepRetries ?? 2;
    const maxPlanRetries = this.config.maxPlanRetries ?? 1;
    const enableReflection = this.config.enableReflection ?? true;
    const completedResults: string[] = [];
    // Accumulate failed agent IDs across all delegated steps in this plan run.
    // A bad agent demoted in step 1 won't be re-selected for step 3.
    const demotedAgents: string[] = [];

    try {
      for (let i = plan.current_step_index; i < steps.length; i++) {
        // Re-read the step: `steps` is a snapshot taken before the lease.
        const step = this.store.getStep(steps[i]!.step_id) ?? steps[i]!;

        // Keep the one-driver lease alive; a lease lost to another driver
        // (it expired under us) means stop — never drive alongside it.
        if (!this.renewDriver(plan.plan_id)) {
          yield { type: "plan_busy", plan: this.store.getPlan(plan.plan_id) ?? plan };
          return;
        }

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

        // A delegated step found Running on entry was submitted by an earlier
        // run whose paid outcome is unknown — it ended undetermined, or the
        // process died mid-submit. It is never delegated again: settle it
        // from the relay's signed receipt, or hold (#890).
        if (step.status === StepStatus.Running && this.isDelegatedStep(step)) {
          const settled = yield* this.settleHeldStep(plan, step);
          if (settled.kind === "completed") {
            completedResults.push(
              `[Step ${step.ordinal + 1}: ${step.description}]\n${settled.summary}`,
            );
            continue;
          }
          if (settled.kind === "skipped") continue;
          // Nothing left the device, or nothing came back naming a task:
          // re-post under the step's derived key (falls through to the
          // delegated path below). The relay replays or names the task.
          if (settled.kind !== "resubmit") return; // held, or failed its plan
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
          this._pushTimelineEvent("plan_failed", { plan_id: plan.plan_id, reason });
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
            this._pushTimelineEvent("step_failed", {
              plan_id: plan.plan_id,
              step_id: step.step_id,
              ordinal: step.ordinal,
              error: failedStep.error_message!,
            });
            yield { type: "step_failed", step: failedStep, error: failedStep.error_message! };

            if (!step.optional) {
              this.failPlan(
                plan,
                `Required step ${step.ordinal + 1} requires [${capsStr}] not available locally`,
              );
              this._pushTimelineEvent("plan_failed", {
                plan_id: plan.plan_id,
                reason: failedStep.error_message!,
              });
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

          // Delegate step to a capable device. A re-post of a held step keeps
          // its FIRST submission time: that is when its key entered the
          // relay's idempotency window (#890).
          const startedAt = Date.now();
          const firstSubmittedAt =
            step.status === StepStatus.Running && step.started_at != null
              ? step.started_at
              : startedAt;
          this.store.updateStep(step.step_id, {
            status: StepStatus.Running,
            started_at: firstSubmittedAt,
            updated_at: startedAt,
          });
          this.store.updatePlan(plan.plan_id, { current_step_index: i, updated_at: startedAt });
          const updatedStep = this.store.getStep(step.step_id)!;
          this._pushTimelineEvent("step_started", {
            plan_id: plan.plan_id,
            step_id: step.step_id,
            ordinal: step.ordinal,
            description: step.description,
          });
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
              demotedAgents,
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
            this._pushTimelineEvent("step_delegated", {
              plan_id: plan.plan_id,
              step_id: step.step_id,
              ordinal: step.ordinal,
              task_id: delegationResult.task_id,
              routing_choice: delegationResult.routing_choice ?? undefined,
            });
            this._pushTimelineEvent("step_completed", {
              plan_id: plan.plan_id,
              step_id: step.step_id,
              ordinal: step.ordinal,
              tool_calls_made: 0,
            });
            yield {
              type: "step_delegated",
              step: completedStep,
              task_id: delegationResult.task_id,
              routing_choice: delegationResult.routing_choice,
            };
            yield { type: "step_completed", step: completedStep };
          } catch (err: unknown) {
            const errMsg = err instanceof Error ? err.message : String(err);
            // Paid outcome unknown: not a failure. The step keeps its task
            // handle and stays Running, the plan stays Active, and nothing
            // is demoted or retried — a new attempt could pay twice (#890).
            if (isDelegationUndetermined(err)) {
              this.store.updateStep(step.step_id, {
                error_message: errMsg,
                updated_at: Date.now(),
              });
              yield this.undeterminedChunk(plan, step.step_id, errMsg);
              return;
            }
            // Extract failed agent IDs from the error cause chain for cross-step demotion.
            // The delegation adapter attaches failedAgentId to errors from failed receipts.
            for (let e: unknown = err; e instanceof Error; e = e.cause) {
              const agentId = (e as { failedAgentId?: string }).failedAgentId;
              if (agentId && !demotedAgents.includes(agentId)) {
                demotedAgents.push(agentId);
              }
            }
            this.store.updateStep(step.step_id, {
              status: StepStatus.Failed,
              completed_at: Date.now(),
              error_message: errMsg,
              updated_at: Date.now(),
            });
            const failedStep = this.store.getStep(step.step_id)!;
            this._pushTimelineEvent("step_failed", {
              plan_id: plan.plan_id,
              step_id: step.step_id,
              ordinal: step.ordinal,
              error: errMsg,
            });
            yield { type: "step_failed", step: failedStep, error: errMsg };

            if (!step.optional) {
              this.failPlan(plan, `Delegated step ${step.ordinal + 1} failed: ${errMsg}`);
              this._pushTimelineEvent("plan_failed", {
                plan_id: plan.plan_id,
                reason: errMsg,
              });
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
          this._pushTimelineEvent("step_started", {
            plan_id: plan.plan_id,
            step_id: step.step_id,
            ordinal: step.ordinal,
            description: step.description,
          });
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
            this._pushTimelineEvent("step_completed", {
              plan_id: plan.plan_id,
              step_id: step.step_id,
              ordinal: step.ordinal,
              tool_calls_made: result.toolCallsMade,
            });
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
          this._pushTimelineEvent("step_failed", {
            plan_id: plan.plan_id,
            step_id: step.step_id,
            ordinal: step.ordinal,
            error: lastError,
          });
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
                // The replacement plan is driven under its own lease too, so a
                // reconnect's recovery cannot drive it alongside us (#890).
                const releaseChild = this.acquireDriver(newPlan.plan_id);
                if (releaseChild == null) {
                  yield { type: "plan_busy", plan: newPlan };
                  return;
                }
                try {
                  yield* this.runSteps(newPlan, newSteps, deps, ctx, planRetryCount + 1, runId);
                } finally {
                  releaseChild();
                }
                return;
              } catch {
                // Re-planning itself failed — fall through to plan_failed
              }
            }

            this._pushTimelineEvent("plan_failed", {
              plan_id: plan.plan_id,
              reason: lastError,
            });
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
      this._pushTimelineEvent("plan_completed", { plan_id: plan.plan_id });
      yield { type: "plan_completed", plan: completedPlan };

      // Post-execution reflection
      if (enableReflection) {
        try {
          const allSteps = this.store.getStepsForPlan(plan.plan_id);
          const result = await reflectOnPlan(
            completedPlan,
            allSteps,
            projectProviderClearance(deps),
            reflectionConfig,
          );
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
    deps: SensitivityCleared<MotebitLoopDependencies>,
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
    // Track in-flight tool calls for timeline events
    const toolStartTimes = new Map<string, number>();

    for await (const chunk of stream) {
      if (chunk.type === "text") {
        responseText += chunk.text;
      }
      if (chunk.type === "tool_status") {
        if (chunk.status === "calling") {
          toolCallsMade++;
          toolStartTimes.set(chunk.name, Date.now());
          this._pushTimelineEvent("tool_invoked", {
            tool: chunk.name,
            args_hash: "", // args not available from stream — populated by runtime from audit sink
            call_id: "",
          });
        } else if (chunk.status === "done") {
          const startTime = toolStartTimes.get(chunk.name);
          const durationMs = startTime != null ? Date.now() - startTime : 0;
          toolStartTimes.delete(chunk.name);
          this._pushTimelineEvent("tool_result", {
            tool: chunk.name,
            ok:
              chunk.result == null ||
              typeof chunk.result !== "string" ||
              !chunk.result.startsWith("Error"),
            duration_ms: durationMs,
            call_id: "",
          });
        }
      }
      if (chunk.type === "approval_request") {
        yield { type: "approval_request", step, chunk };
        return { suspended: true, toolCallsMade, responseText };
      }
      yield { type: "step_chunk", chunk };
    }

    return { suspended: false, toolCallsMade, responseText };
  }

  /**
   * Was this step handed to another agent? True when it carries a relay
   * task handle, or when it needs a capability this device lacks (the
   * engine delegates exactly those).
   */
  private isDelegatedStep(step: PlanStep): boolean {
    if (step.delegation_task_id != null && step.delegation_task_id !== "") return true;
    const local = this.config.localCapabilities ?? [];
    return (step.required_capabilities ?? []).some((c) => !local.includes(c));
  }

  /**
   * The goal's delegated step whose paid outcome is unknown, if any: a
   * `Running` delegated step in one of the goal's `Active` plans (#890).
   * While one exists the goal must not delegate again — `createPlan`
   * refuses, and a runner resumes that plan instead, which settles the step
   * from the relay's signed receipt or holds it.
   */
  findUnresolvedDelegation(
    goalId: string,
    motebitId: string,
  ): { plan: Plan; step: PlanStep } | null {
    const active =
      this.store.listActivePlans != null
        ? this.store.listActivePlans(motebitId).filter((p) => p.goal_id === goalId)
        : [this.store.getPlanForGoal(goalId)].filter(
            (p): p is Plan => p != null && p.status === PlanStatus.Active,
          );
    for (const plan of active) {
      for (const step of this.store.getStepsForPlan(plan.plan_id)) {
        if (step.status === StepStatus.Running && this.isDelegatedStep(step)) {
          return { plan, step };
        }
      }
    }
    return null;
  }

  private undeterminedChunk(plan: Plan, stepId: string, reason: string): PlanChunk {
    const step = this.store.getStep(stepId)!;
    const taskId = step.delegation_task_id;
    return {
      type: "plan_undetermined",
      plan: this.store.getPlan(plan.plan_id)!,
      step,
      reason,
      ...(taskId != null && taskId !== "" ? { task_id: taskId } : {}),
    };
  }

  /**
   * Settle a held delegated step from durable facts only: the relay's
   * signed receipt for its task. A completed receipt completes the step; a
   * receipt with any other status is a conclusive failure; no receipt
   * (still running, unreachable, gone, or no task handle at all) holds the
   * step — never a timeout, never a guess, never a second submission (#890).
   */
  private async *settleHeldStep(
    plan: Plan,
    step: PlanStep,
  ): AsyncGenerator<
    PlanChunk,
    | { kind: "completed"; summary: string }
    | { kind: "skipped" }
    | { kind: "failed" | "held" | "resubmit" }
  > {
    const adapter = this.config.delegationAdapter;
    const taskId = step.delegation_task_id;
    // No task handle: the only way to learn what the first submission did is
    // to ask under its key again — safe only through an adapter whose key is
    // derived, and only while the relay still remembers that key (#890).
    if (
      (taskId == null || taskId === "") &&
      adapter?.resubmitsIdempotently === true &&
      step.started_at != null &&
      this.leaseNow() - step.started_at <
        (this.config.resubmitWindowMs ?? DEFAULT_RESUBMIT_WINDOW_MS)
    ) {
      return { kind: "resubmit" };
    }
    let result: DelegatedStepResult | null = null;
    if (taskId != null && taskId !== "" && adapter?.pollTaskResult != null) {
      try {
        result = await adapter.pollTaskResult(taskId, step.step_id);
      } catch {
        result = null;
      }
    }

    if (result == null) {
      const reason =
        taskId != null && taskId !== ""
          ? `Awaiting the result of delegated task ${taskId} — it may still complete; check /result (step "${step.description}")`
          : `Submission unconfirmed and no task id was recorded — the task may still complete; check /result (step "${step.description}")`;
      yield this.undeterminedChunk(plan, step.step_id, reason);
      return { kind: "held" };
    }

    const summary = result.result_text.slice(0, 2000);
    if (result.receipt.status === "completed") {
      this.store.updateStep(step.step_id, {
        status: StepStatus.Completed,
        completed_at: Date.now(),
        result_summary: summary || null,
        error_message: null,
        updated_at: Date.now(),
      });
      const completedStep = this.store.getStep(step.step_id)!;
      this._pushTimelineEvent("step_delegated", {
        plan_id: plan.plan_id,
        step_id: step.step_id,
        ordinal: step.ordinal,
        task_id: result.task_id,
      });
      this._pushTimelineEvent("step_completed", {
        plan_id: plan.plan_id,
        step_id: step.step_id,
        ordinal: step.ordinal,
        tool_calls_made: 0,
      });
      yield { type: "step_delegated", step: completedStep, task_id: result.task_id };
      yield { type: "step_completed", step: completedStep };
      return { kind: "completed", summary };
    }

    const errMsg = `Delegated step ${result.receipt.status}: ${summary}`;
    this.store.updateStep(step.step_id, {
      status: StepStatus.Failed,
      completed_at: Date.now(),
      error_message: errMsg,
      updated_at: Date.now(),
    });
    this._pushTimelineEvent("step_failed", {
      plan_id: plan.plan_id,
      step_id: step.step_id,
      ordinal: step.ordinal,
      error: errMsg,
    });
    yield { type: "step_failed", step: this.store.getStep(step.step_id)!, error: errMsg };
    if (step.optional) {
      this.store.updateStep(step.step_id, { status: StepStatus.Skipped, updated_at: Date.now() });
      return { kind: "skipped" };
    }
    this.failPlan(plan, `Delegated step ${step.ordinal + 1} failed: ${errMsg}`);
    this._pushTimelineEvent("plan_failed", { plan_id: plan.plan_id, reason: errMsg });
    yield { type: "plan_failed", plan: this.store.getPlan(plan.plan_id)!, reason: errMsg };
    return { kind: "failed" };
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
    deps: SensitivityCleared<MotebitLoopDependencies>,
  ): AsyncGenerator<PlanChunk> {
    const adapter = this.config.delegationAdapter;
    if (!adapter?.pollTaskResult) return;
    if (!this.store.listActivePlans) return;

    const activePlans = this.store.listActivePlans(motebitId);

    for (const plan of activePlans) {
      // One driver per plan (#890): a plan a scheduler is resuming right now
      // is that driver's to settle.
      const release = this.acquireDriver(plan.plan_id);
      if (release == null) {
        yield { type: "plan_busy", plan };
        continue;
      }
      try {
        yield* this.recoverLeasedPlan(plan, deps);
      } finally {
        release();
      }
    }
  }

  private async *recoverLeasedPlan(
    leasedPlan: Plan,
    deps: SensitivityCleared<MotebitLoopDependencies>,
  ): AsyncGenerator<PlanChunk> {
    const adapter = this.config.delegationAdapter;
    if (!adapter?.pollTaskResult) return;
    {
      // Re-read under the lease.
      const plan = this.store.getPlan(leasedPlan.plan_id);
      if (plan == null || plan.status !== PlanStatus.Active) return;
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
          yield* this.resumeLeased(plan.plan_id, deps);
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
    deps: SensitivityCleared<MotebitLoopDependencies>,
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
