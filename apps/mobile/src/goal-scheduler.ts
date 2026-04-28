/**
 * Mobile goal scheduler — owns the background goal execution loop,
 * plan-based goal dispatch, approval suspension/resumption, and outcome
 * recording to the SQLite goal store.
 *
 * Mirrors the desktop `GoalScheduler` pattern — class owns the timer +
 * executing flag + pending approval state + 4 UI callback slots;
 * runtime, plan engine, and goal store are read lazily via getter
 * closures.
 *
 * ### State ownership
 *
 *   - `timer`                 — 60s setInterval handle
 *   - `tickCount`             — counter for periodic housekeeping
 *   - `_goalExecuting`        — true while a goal run is in flight
 *                               (blocks overlapping ticks)
 *   - `_currentGoalId`        — goal_id of the running goal
 *   - `_pendingGoalApproval`  — set when a tool call needs approval
 *                               mid-run; blocks further ticks until
 *                               the user responds
 *   - four callback slots     — status / complete / approval, plus
 *                               the subscription callback setters
 *
 * ### Execution flow
 *
 * `goalTick` → if PlanEngine available: `executePlanGoal` → `consumePlanStream`
 * else `executeSingleTurnGoal`. On `approval_request`, capture the
 * pending approval and return `suspended: true`. MobileApp's
 * `resumeGoalAfterApproval` (a delegate) finishes phase 1 via
 * `runtime.resumeAfterApproval` and phase 2 via `planEngine.resumePlan`.
 */

import type { MotebitRuntime, StreamChunk } from "@motebit/runtime";
import type { PlanChunk, PlanEngine } from "@motebit/planner";
import { PlanStatus } from "@motebit/sdk";
import type { ExpoGoalStore } from "./adapters/expo-sqlite";
import type { ExpoStorageResult } from "./adapters/expo-sqlite";

export interface GoalCompleteEvent {
  goalId: string;
  prompt: string;
  status: "completed" | "failed";
  summary: string | null;
  error: string | null;
}

export interface GoalApprovalEvent {
  goalId: string;
  goalPrompt: string;
  toolName: string;
  args: Record<string, unknown>;
  riskLevel?: number;
}

function formatTimeAgo(ms: number): string {
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
  return `${Math.round(ms / 86_400_000)}d ago`;
}

export interface GoalSchedulerDeps {
  getRuntime: () => MotebitRuntime | null;
  getMotebitId: () => string;
  getPlanEngine: () => PlanEngine | null;
  getStorage: () => ExpoStorageResult | null;
}

export class MobileGoalScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private tickCount = 0;
  private _goalExecuting = false;
  private _currentGoalId: string | null = null;
  private _goalStatusCallback: ((executing: boolean) => void) | null = null;
  private _goalCompleteCallback: ((event: GoalCompleteEvent) => void) | null = null;
  private _goalApprovalCallback: ((event: GoalApprovalEvent) => void) | null = null;
  private _pendingGoalApproval: {
    goalId: string;
    prompt: string;
    mode: string;
    planId?: string;
  } | null = null;

  constructor(private deps: GoalSchedulerDeps) {}

  getGoalStore(): ExpoGoalStore | null {
    return this.deps.getStorage()?.goalStore ?? null;
  }

  get isGoalExecuting(): boolean {
    return this._goalExecuting;
  }

  /** goal_id of the currently-running goal, or null. Read by mobile-app
   *  to scope the createSubGoal / completeGoal / reportProgress tool handlers. */
  get currentGoalId(): string | null {
    return this._currentGoalId;
  }

  /** Subscribe to goal execution status changes (for UI indicator). */
  onGoalStatus(callback: (executing: boolean) => void): void {
    this._goalStatusCallback = callback;
  }

  /** Subscribe to goal completion events (success or failure, for chat surfacing). */
  onGoalComplete(callback: (event: GoalCompleteEvent) => void): void {
    this._goalCompleteCallback = callback;
  }

  /** Subscribe to goal approval requests. */
  onGoalApproval(callback: (event: GoalApprovalEvent) => void): void {
    this._goalApprovalCallback = callback;
  }

  /** Start background goal scheduling. 60s tick interval. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.goalTick();
    }, 60_000);
    // Run first tick after a short delay (let UI settle)
    setTimeout(() => {
      void this.goalTick();
    }, 5_000);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // Final consolidation on stop
    void this.deps.getRuntime()?.consolidationCycle();
  }

  /**
   * Resume a goal after the user approves/denies a tool call.
   * Streams the continuation back so the UI can render it into chat.
   */
  async *resumeGoalAfterApproval(approved: boolean): AsyncGenerator<StreamChunk> {
    const runtime = this.deps.getRuntime();
    if (!runtime) throw new Error("AI not initialized");
    if (!this._pendingGoalApproval) throw new Error("No pending goal approval");

    const goalStore = this.deps.getStorage()?.goalStore;
    if (!goalStore) throw new Error("Goal store not available");

    const { goalId, prompt, mode, planId } = this._pendingGoalApproval;

    try {
      let accumulated = "";

      // Phase 1: Complete the current step via runtime approval resume
      for await (const chunk of runtime.resumeAfterApproval(approved)) {
        if (chunk.type === "text") {
          accumulated += chunk.text;
        }
        yield chunk;
      }

      // Phase 2: If plan-based goal, resume remaining plan steps
      const planEngine = this.deps.getPlanEngine();
      if (planId != null && planId !== "" && planEngine != null) {
        const loopDeps = runtime.getLoopDeps();
        if (loopDeps) {
          const planResult = await this.consumePlanStream(
            planEngine.resumePlan(planId, loopDeps),
            { goal_id: goalId, prompt, mode },
            planId,
          );
          accumulated += planResult.summary;
          if (planResult.suspended) return; // Another approval needed
        }
      }

      // Record outcome
      const now = Date.now();
      this.finishGoalSuccess({ goal_id: goalId, prompt, mode }, accumulated.slice(0, 500), now);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.finishGoalFailure({ goal_id: goalId, prompt, mode }, msg, Date.now());
      throw err;
    } finally {
      this._goalExecuting = false;
      this._currentGoalId = null;
      this._goalStatusCallback?.(false);
      this._pendingGoalApproval = null;
      this.deps.getRuntime()?.resetConversation();
    }
  }

  private async goalTick(): Promise<void> {
    const runtime = this.deps.getRuntime();
    if (!runtime || this._goalExecuting || runtime.isProcessing) return;

    const goalStore = this.deps.getStorage()?.goalStore;
    if (!goalStore) return;

    // Periodic consolidation (every 10 ticks ≈ 10 min at 60s default)
    this.tickCount++;
    if (this.tickCount % 10 === 0) {
      void runtime.consolidationCycle();
    }

    try {
      const goals = goalStore.listActiveGoals(this.deps.getMotebitId());
      if (goals.length === 0) return;

      const now = Date.now();
      for (const goal of goals) {
        const elapsed = goal.last_run_at != null ? now - goal.last_run_at : Infinity;
        if (elapsed < goal.interval_ms) continue;
        if (runtime.isProcessing) break;

        this._goalExecuting = true;
        this._currentGoalId = goal.goal_id;
        this._goalStatusCallback?.(true);

        try {
          const outcomes = goalStore.getRecentOutcomes(goal.goal_id, 3);
          const loopDeps = runtime.getLoopDeps();
          const planEngine = this.deps.getPlanEngine();

          // Plan-based execution when PlanEngine is available
          if (planEngine && loopDeps) {
            const result = await this.executePlanGoal(goal, outcomes);
            if (result.suspended) return; // Waiting for approval
            this.finishGoalSuccess(goal, result.summary, now);
          } else {
            // Fallback: single-turn streaming
            const result = await this.executeSingleTurnGoal(goal, outcomes, now);
            if (result.suspended) return;
            this.finishGoalSuccess(goal, result.summary, now);
          }
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          this.finishGoalFailure(goal, msg, now);
        } finally {
          if (!this._pendingGoalApproval) {
            this._goalExecuting = false;
            this._currentGoalId = null;
            this._goalStatusCallback?.(false);
            this.deps.getRuntime()?.resetConversation();
          }
        }
      }
    } catch {
      this._goalExecuting = false;
      this._currentGoalId = null;
      this._goalStatusCallback?.(false);
    }
  }

  /** Execute a goal with PlanEngine multi-step decomposition. */
  private async executePlanGoal(
    goal: { goal_id: string; prompt: string; mode: string },
    outcomes: Array<{
      ran_at: number;
      status: string;
      summary: string | null;
      error_message: string | null;
    }>,
  ): Promise<{ suspended: boolean; summary: string }> {
    const runtime = this.deps.getRuntime()!;
    const planEngine = this.deps.getPlanEngine()!;
    const loopDeps = runtime.getLoopDeps()!;
    const planStore = this.deps.getStorage()!.planStore;
    const registry = runtime.getToolRegistry();

    // Check for existing active plan (resume interrupted plan)
    let plan = planStore.getPlanForGoal(goal.goal_id);
    let planStream: AsyncGenerator<PlanChunk>;

    if (plan && plan.status === PlanStatus.Active) {
      planStream = planEngine.resumePlan(plan.plan_id, loopDeps);
    } else {
      const created = await planEngine.createPlan(
        goal.goal_id,
        this.deps.getMotebitId(),
        {
          goalPrompt: goal.prompt,
          previousOutcomes: outcomes.map((o) =>
            o.status === "failed"
              ? `failed: ${o.error_message ?? "unknown"}`
              : `${o.status}: ${o.summary ?? "no summary"}`,
          ),
          availableTools: registry.list().map((t) => t.name),
        },
        loopDeps,
      );
      plan = created.plan;
      planStream = planEngine.executePlan(created.plan.plan_id, loopDeps);
    }

    return this.consumePlanStream(planStream, goal, plan.plan_id);
  }

  /** Consume a PlanEngine stream, handling approval requests. */
  private async consumePlanStream(
    stream: AsyncGenerator<PlanChunk>,
    goal: { goal_id: string; prompt: string; mode: string },
    planId: string,
  ): Promise<{ suspended: boolean; summary: string }> {
    let accumulated = "";

    for await (const chunk of stream) {
      switch (chunk.type) {
        case "step_chunk":
          if (chunk.chunk.type === "text") {
            accumulated += chunk.chunk.text;
          }
          break;
        case "approval_request": {
          this._pendingGoalApproval = {
            goalId: goal.goal_id,
            prompt: goal.prompt,
            mode: goal.mode,
            planId,
          };
          this._goalApprovalCallback?.({
            goalId: goal.goal_id,
            goalPrompt: goal.prompt,
            toolName: chunk.chunk.type === "approval_request" ? chunk.chunk.name : "unknown",
            args: chunk.chunk.type === "approval_request" ? chunk.chunk.args : {},
            riskLevel: chunk.chunk.type === "approval_request" ? chunk.chunk.risk_level : undefined,
          });
          return { suspended: true, summary: accumulated.slice(0, 500) };
        }
        case "plan_completed":
        case "plan_failed":
          break;
      }
    }

    return { suspended: false, summary: accumulated.slice(0, 500) };
  }

  /** Execute a goal with simple single-turn streaming (fallback). */
  private async executeSingleTurnGoal(
    goal: { goal_id: string; prompt: string; mode: string },
    outcomes: Array<{
      ran_at: number;
      status: string;
      summary: string | null;
      error_message: string | null;
    }>,
    now: number,
  ): Promise<{ suspended: boolean; summary: string }> {
    const runtime = this.deps.getRuntime()!;
    let context = `You are executing a scheduled goal.\n\nGoal: ${goal.prompt}`;
    if (outcomes.length > 0) {
      context += "\n\nPrevious executions (most recent first):";
      for (const o of outcomes) {
        const ago = formatTimeAgo(now - o.ran_at);
        if (o.status === "failed" && o.error_message != null && o.error_message !== "") {
          context += `\n- ${ago}: failed — [error: ${o.error_message}]`;
        } else if (o.summary != null && o.summary !== "") {
          context += `\n- ${ago}: ${o.status} — "${o.summary.slice(0, 100)}"`;
        } else {
          context += `\n- ${ago}: ${o.status}`;
        }
      }
    }
    if (goal.mode === "once") {
      context += "\n\nThis is a one-time goal. Complete it fully in this execution.";
    }

    let accumulated = "";
    for await (const chunk of runtime.sendMessageStreaming(context)) {
      if (chunk.type === "text") {
        accumulated += chunk.text;
      } else if (chunk.type === "approval_request") {
        this._pendingGoalApproval = {
          goalId: goal.goal_id,
          prompt: goal.prompt,
          mode: goal.mode,
        };
        this._goalApprovalCallback?.({
          goalId: goal.goal_id,
          goalPrompt: goal.prompt,
          toolName: chunk.name,
          args: chunk.args,
          riskLevel: chunk.risk_level,
        });
        return { suspended: true, summary: accumulated.slice(0, 500) };
      }
    }

    return { suspended: false, summary: accumulated.slice(0, 500) };
  }

  private finishGoalSuccess(
    goal: { goal_id: string; prompt: string; mode: string },
    summary: string,
    now: number,
  ): void {
    const goalStore = this.deps.getStorage()?.goalStore;
    if (!goalStore) return;
    const motebitId = this.deps.getMotebitId();

    goalStore.updateLastRun(goal.goal_id, now);
    goalStore.resetFailures(goal.goal_id);

    goalStore.insertOutcome({
      outcome_id: crypto.randomUUID(),
      goal_id: goal.goal_id,
      motebit_id: motebitId,
      ran_at: now,
      status: "completed",
      summary,
      tool_calls_made: 0,
      memories_formed: 0,
      error_message: null,
    });

    if (goal.mode === "once") {
      goalStore.setStatus(goal.goal_id, "completed");
    }

    this._goalCompleteCallback?.({
      goalId: goal.goal_id,
      prompt: goal.prompt,
      status: "completed",
      summary: summary.slice(0, 200),
      error: null,
    });
  }

  private finishGoalFailure(
    goal: { goal_id: string; prompt: string; mode: string },
    error: string,
    now: number,
  ): void {
    const goalStore = this.deps.getStorage()?.goalStore;
    if (!goalStore) return;
    const motebitId = this.deps.getMotebitId();

    try {
      goalStore.insertOutcome({
        outcome_id: crypto.randomUUID(),
        goal_id: goal.goal_id,
        motebit_id: motebitId,
        ran_at: now,
        status: "failed",
        summary: null,
        tool_calls_made: 0,
        memories_formed: 0,
        error_message: error,
      });
    } catch {
      /* non-fatal */
    }

    try {
      goalStore.incrementFailures(goal.goal_id);
    } catch {
      /* non-fatal */
    }

    this._goalCompleteCallback?.({
      goalId: goal.goal_id,
      prompt: goal.prompt,
      status: "failed",
      summary: null,
      error,
    });
  }
}
