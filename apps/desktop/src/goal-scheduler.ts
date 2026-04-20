/**
 * Goal scheduler — owns the background goal execution loop, plan-based
 * goal dispatch, approval suspension/resumption, and the goal-management
 * tool handlers (createSubGoal, completeGoal, reportProgress).
 *
 * The scheduler is the downstream consumer of every other desktop module
 * — it reads identity (`motebitId`), dispatches via the runtime (tool
 * registry, streaming turns, event log), and delegates multi-step
 * execution to PlanEngine. Keeping it in its own file lets `index.ts`
 * stay a thin platform shell around MotebitRuntime.
 *
 * ### State ownership
 *
 * The scheduler owns:
 *
 *   - `timer`                    — the 60s setInterval handle
 *   - `_goalExecuting`           — true while a goal run is in flight
 *                                  (blocks overlapping ticks)
 *   - `_currentGoalId`           — goal_id of the currently executing run,
 *                                  captured in tool-handler closures so
 *                                  createSubGoal/completeGoal know which
 *                                  goal they're acting on
 *   - `_pendingGoalApproval`     — set when a tool call needs user
 *                                  approval mid-run; blocks further ticks
 *                                  until resumed
 *   - four callback slots        — status / complete / approval / plan
 *                                  progress, subscribed by the renderer
 *                                  to drive the goal UI
 *
 * ### Deps getter pattern
 *
 * Runtime, PlanEngine, PlanStore, and motebitId all change over the
 * DesktopApp lifecycle (null before `initAI`, set after). The scheduler
 * reads them lazily via getter functions passed in the constructor so
 * DesktopApp never has to re-bind the scheduler after init.
 *
 * ### Execution flow
 *
 * `goalTick` → `executePlanGoal` → (PlanEngine available?)
 *   → yes: `consumePlanStream` (multi-step, delegation, step progress)
 *   → no:  `executeSingleTurnGoal` (direct runtime.sendMessageStreaming)
 *
 * On `approval_request`, the scheduler captures `_pendingGoalApproval`,
 * returns `suspended: true`, and leaves `_goalExecuting = true`. The UI
 * surfaces the approval dialog. When the user responds, DesktopApp calls
 * `resumeGoalAfterApproval(approved)` which finishes the suspended run
 * via `runtime.resumeAfterApproval` and (if plan-based) continues via
 * `planEngine.resumePlan`.
 */

import type { MotebitRuntime, StreamChunk } from "@motebit/runtime";
import { PlanStatus } from "@motebit/sdk";
import type { PlanChunk, PlanEngine, PlanStoreAdapter } from "@motebit/planner";
import {
  createSubGoalDefinition,
  completeGoalDefinition,
  reportProgressDefinition,
} from "@motebit/tools/web-safe";
import type { InvokeFn, TauriPlanStore } from "./tauri-storage.js";

/** Maximum tool calls across all turns in a single goal run (default 50). */
const MAX_TOOL_CALLS_PER_RUN = 50;

export interface GoalCompleteEvent {
  goalId: string;
  prompt: string;
  status: "completed" | "failed";
  summary: string | null;
  error: string | null;
  /** Plan title if the goal used plan-based execution. */
  planTitle?: string;
  /** Number of plan steps completed. */
  stepsCompleted?: number;
  /** Total plan steps. */
  totalSteps?: number;
}

export interface GoalPlanProgressEvent {
  goalId: string;
  planTitle: string;
  stepIndex: number;
  totalSteps: number;
  stepDescription: string;
  type: "plan_created" | "step_started" | "step_completed" | "step_failed";
}

export interface GoalApprovalEvent {
  goalId: string;
  goalPrompt: string;
  toolName: string;
  args: Record<string, unknown>;
  riskLevel?: number;
}

interface GoalRow {
  goal_id: string;
  motebit_id: string;
  prompt: string;
  interval_ms: number;
  last_run_at: number | null;
  enabled: number;
  status: string;
  mode: string;
  parent_goal_id: string | null;
  max_retries: number;
  consecutive_failures: number;
}

interface OutcomeRow {
  ran_at: number;
  status: string;
  summary: string | null;
  error_message: string | null;
}

export interface GoalSchedulerDeps {
  getRuntime: () => MotebitRuntime | null;
  getMotebitId: () => string;
  getPlanEngine: () => PlanEngine | null;
  getPlanStore: () => PlanStoreAdapter | TauriPlanStore | null;
}

function formatTimeAgo(ms: number): string {
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
  return `${Math.round(ms / 86_400_000)}d ago`;
}

export class GoalScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private _goalExecuting = false;
  private _currentGoalId: string | null = null;
  private _goalStatusCallback: ((executing: boolean) => void) | null = null;
  private _goalCompleteCallback: ((event: GoalCompleteEvent) => void) | null = null;
  private _goalApprovalCallback: ((event: GoalApprovalEvent) => void) | null = null;
  private _goalPlanProgressCallback: ((event: GoalPlanProgressEvent) => void) | null = null;
  private _pendingGoalApproval: {
    goalId: string;
    prompt: string;
    invoke: InvokeFn;
    mode: string;
    planId?: string;
    runId?: string;
  } | null = null;

  constructor(private deps: GoalSchedulerDeps) {}

  get isGoalExecuting(): boolean {
    return this._goalExecuting;
  }

  /** Subscribe to goal execution status changes (for UI indicator). */
  onGoalStatus(callback: (executing: boolean) => void): void {
    this._goalStatusCallback = callback;
  }

  /** Subscribe to goal completion events (success or failure, for chat surfacing). */
  onGoalComplete(callback: (event: GoalCompleteEvent) => void): void {
    this._goalCompleteCallback = callback;
  }

  /** Subscribe to goal approval requests (tool needs user approval during background goal). */
  onGoalApproval(callback: (event: GoalApprovalEvent) => void): void {
    this._goalApprovalCallback = callback;
  }

  /** Subscribe to plan progress events (step started/completed/failed during goal execution). */
  onGoalPlanProgress(callback: (event: GoalPlanProgressEvent) => void): void {
    this._goalPlanProgressCallback = callback;
  }

  /**
   * Register goal-management tools that the agent can use during goal execution.
   * These tools let the agent create sub-goals, complete goals, and report progress.
   * They are no-ops when called outside of an active goal context.
   *
   * Must be called after the runtime is initialized (initAI). Reads runtime
   * via the deps getter — a no-op if runtime is null.
   */
  registerGoalTools(invoke: InvokeFn): void {
    const runtime = this.deps.getRuntime();
    if (!runtime) return;
    const registry = runtime.getToolRegistry();
    const getMotebitId = this.deps.getMotebitId;

    // Helper: parse interval strings like "1h", "30m", "1d" to milliseconds
    const parseInterval = (s: string): number => {
      const match = s.match(/^(\d+)\s*(s|m|h|d)$/i);
      if (!match) return 3_600_000; // default 1h
      const n = parseInt(match[1]!, 10);
      switch (match[2]!.toLowerCase()) {
        case "s":
          return n * 1_000;
        case "m":
          return n * 60_000;
        case "h":
          return n * 3_600_000;
        case "d":
          return n * 86_400_000;
        default:
          return 3_600_000;
      }
    };

    registry.register(createSubGoalDefinition, async (args: Record<string, unknown>) => {
      if (this._currentGoalId == null || this._currentGoalId === "") {
        return { ok: false, error: "No active goal context" };
      }
      const prompt = args.prompt as string;
      const interval = args.interval as string | undefined;
      const once = args.once as boolean | undefined;
      const intervalMs = interval != null && interval !== "" ? parseInterval(interval) : 3_600_000;
      const mode = once === true ? "once" : "recurring";
      const subGoalId = crypto.randomUUID();

      try {
        await invoke("goals_create", {
          motebit_id: getMotebitId(),
          goal_id: subGoalId,
          prompt,
          interval_ms: intervalMs,
          mode,
        });
        await invoke<number>("db_execute", {
          sql: "UPDATE goals SET parent_goal_id = ? WHERE goal_id = ?",
          params: [this._currentGoalId, subGoalId],
        });
        return { ok: true, data: { goal_id: subGoalId, prompt, mode, interval_ms: intervalMs } };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, error: msg };
      }
    });

    registry.register(completeGoalDefinition, async (args: Record<string, unknown>) => {
      if (this._currentGoalId == null || this._currentGoalId === "") {
        return { ok: false, error: "No active goal context" };
      }
      const reason = args.reason as string;
      try {
        const rt = this.deps.getRuntime();
        if (rt) {
          // Emit goal_completed BEFORE flipping status — the
          // terminal-state guard on runtime.goals would suppress the
          // event otherwise (spec/goal-lifecycle-v1.md §3.4).
          await rt.goals.completed({ goal_id: this._currentGoalId, reason });
        }
        await invoke<number>("db_execute", {
          sql: "UPDATE goals SET status = 'completed' WHERE goal_id = ?",
          params: [this._currentGoalId],
        });
        return { ok: true, data: { goal_id: this._currentGoalId, status: "completed", reason } };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, error: msg };
      }
    });

    registry.register(reportProgressDefinition, async (args: Record<string, unknown>) => {
      if (this._currentGoalId == null || this._currentGoalId === "") {
        return { ok: false, error: "No active goal context" };
      }
      const note = args.note as string;
      const rt = this.deps.getRuntime();
      if (!rt) return { ok: false, error: "Runtime not initialized" };
      await rt.goals.progress({ goal_id: this._currentGoalId, note });
      return { ok: true, data: { goal_id: this._currentGoalId, note } };
    });
  }

  /**
   * Start background goal scheduling. Checks for active goals every 60s and
   * executes them in the background without interrupting the user's chat.
   * Goals are stored in the database as rows in a `goals` table — the desktop
   * reads them via Tauri IPC. If the goals table doesn't exist or has no active
   * goals, the tick is a no-op.
   */
  start(invoke: InvokeFn): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.goalTick(invoke);
    }, 60_000);
    // Run first tick after a short delay (let UI settle)
    setTimeout(() => {
      void this.goalTick(invoke);
    }, 5_000);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Resume a goal after the user approves/denies a tool call.
   * Streams the continuation back so main.ts can render it into chat.
   * After streaming completes, records the goal outcome and cleans up.
   *
   * If the goal was executing a plan (planId is set), this method:
   * 1. Completes the current step via runtime.resumeAfterApproval()
   * 2. Resumes the remaining plan steps via planEngine.resumePlan()
   */
  async *resumeGoalAfterApproval(approved: boolean): AsyncGenerator<StreamChunk> {
    const runtime = this.deps.getRuntime();
    if (!runtime) throw new Error("AI not initialized");
    if (!this._pendingGoalApproval) throw new Error("No pending goal approval");

    const { goalId, prompt, invoke, mode, planId, runId } = this._pendingGoalApproval;
    this._currentGoalId = goalId;

    try {
      let accumulated = "";
      let toolCallsMade = 0;
      let planTitle: string | undefined;
      let stepsCompleted: number | undefined;
      let totalSteps: number | undefined;

      // Phase 1: Complete the current tool call / step via runtime approval
      for await (const chunk of runtime.resumeAfterApproval(approved)) {
        if (chunk.type === "text") {
          accumulated += chunk.text;
        } else if (chunk.type === "tool_status" && chunk.status === "calling") {
          toolCallsMade++;
        }
        yield chunk;
      }

      // Phase 2: If this was a plan-based goal, resume remaining steps
      const planEngine = this.deps.getPlanEngine();
      if (planId != null && planId !== "" && planEngine != null) {
        const loopDeps = runtime.getLoopDeps();
        if (loopDeps) {
          const planResult = await this.consumePlanStream(
            planEngine.resumePlan(planId, loopDeps, undefined, runId),
            { goal_id: goalId, prompt, mode },
            invoke,
          );

          if (planResult.suspended) {
            return;
          }

          accumulated += planResult.responseText;
          toolCallsMade += planResult.toolCallsMade;
          planTitle = planResult.planTitle;
          stepsCompleted = planResult.stepsCompleted;
          totalSteps = planResult.totalSteps;
        }
      }

      // Record outcome to DB (use runId as outcome_id for audit correlation)
      const outcomeId = runId ?? crypto.randomUUID();
      const now = Date.now();
      const motebitId = this.deps.getMotebitId();
      await invoke<number>("db_execute", {
        sql: "UPDATE goals SET last_run_at = ?, consecutive_failures = 0 WHERE goal_id = ?",
        params: [now, goalId],
      });

      await invoke<number>("db_execute", {
        sql: `INSERT INTO goal_outcomes (outcome_id, goal_id, motebit_id, ran_at, status, summary, tool_calls_made, memories_formed, error_message)
              VALUES (?, ?, ?, ?, 'completed', ?, ?, 0, NULL)`,
        params: [outcomeId, goalId, motebitId, now, accumulated.slice(0, 500), toolCallsMade],
      });

      if (mode === "once") {
        await invoke<number>("db_execute", {
          sql: "UPDATE goals SET status = 'completed' WHERE goal_id = ?",
          params: [goalId],
        });
      }

      this._goalCompleteCallback?.({
        goalId,
        prompt,
        status: "completed",
        summary: accumulated.slice(0, 200),
        error: null,
        planTitle,
        stepsCompleted,
        totalSteps,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this._goalCompleteCallback?.({
        goalId,
        prompt,
        status: "failed",
        summary: null,
        error: msg,
      });
      throw err;
    } finally {
      if (this._pendingGoalApproval == null || this._pendingGoalApproval.goalId === goalId) {
        this._goalExecuting = false;
        this._currentGoalId = null;
        this._goalStatusCallback?.(false);
        this._pendingGoalApproval = null;
        this.deps.getRuntime()?.resetConversation();
      }
    }
  }

  private async goalTick(invoke: InvokeFn): Promise<void> {
    const runtime = this.deps.getRuntime();
    if (!runtime || this._goalExecuting || runtime.isProcessing) return;
    const motebitId = this.deps.getMotebitId();

    try {
      const goals = await invoke<GoalRow[]>("db_query", {
        sql: "SELECT * FROM goals WHERE motebit_id = ? AND enabled = 1 AND status = 'active'",
        params: [motebitId],
      });

      if (goals.length === 0) return;

      const now = Date.now();
      for (const goal of goals) {
        const elapsed = goal.last_run_at != null ? now - goal.last_run_at : Infinity;
        if (elapsed < goal.interval_ms) continue;
        if (runtime.isProcessing) break;

        this._goalExecuting = true;
        this._currentGoalId = goal.goal_id;
        this._goalStatusCallback?.(true);

        const runId = crypto.randomUUID();

        try {
          const outcomes = await invoke<OutcomeRow[]>("db_query", {
            sql: "SELECT ran_at, status, summary, error_message FROM goal_outcomes WHERE goal_id = ? ORDER BY ran_at DESC LIMIT 3",
            params: [goal.goal_id],
          });

          // Wall-clock limit: 10 minutes per goal run
          const GOAL_WALL_CLOCK_MS = 10 * 60 * 1000;
          const abortController = new AbortController();
          const deadlineTimer = setTimeout(
            () => abortController.abort(new Error("Goal exceeded 10-minute wall-clock limit")),
            GOAL_WALL_CLOCK_MS,
          );
          let result: Awaited<ReturnType<typeof this.executePlanGoal>>;
          try {
            result = await this.executePlanGoal(
              goal,
              outcomes ?? [],
              invoke,
              runId,
              abortController.signal,
            );
          } finally {
            clearTimeout(deadlineTimer);
          }

          if (result.suspended) {
            // Approval requested — _goalExecuting stays true to block further ticks.
            return;
          }

          await invoke<number>("db_execute", {
            sql: "UPDATE goals SET last_run_at = ?, consecutive_failures = 0 WHERE goal_id = ?",
            params: [now, goal.goal_id],
          });

          await invoke<number>("db_execute", {
            sql: `INSERT INTO goal_outcomes (outcome_id, goal_id, motebit_id, ran_at, status, summary, tool_calls_made, memories_formed, error_message, tokens_used)
                  VALUES (?, ?, ?, ?, 'completed', ?, ?, 0, NULL, ?)`,
            params: [
              runId,
              goal.goal_id,
              motebitId,
              now,
              result.responseText.slice(0, 500),
              result.toolCallsMade,
              result.tokensUsed ?? null,
            ],
          });

          if (goal.mode === "once") {
            await invoke<number>("db_execute", {
              sql: "UPDATE goals SET status = 'completed' WHERE goal_id = ?",
              params: [goal.goal_id],
            });
          }

          this._goalCompleteCallback?.({
            goalId: goal.goal_id,
            prompt: goal.prompt,
            status: "completed",
            summary: result.responseText.slice(0, 200),
            error: null,
            planTitle: result.planTitle,
            stepsCompleted: result.stepsCompleted,
            totalSteps: result.totalSteps,
          });
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);

          await invoke<number>("db_execute", {
            sql: `INSERT INTO goal_outcomes (outcome_id, goal_id, motebit_id, ran_at, status, summary, tool_calls_made, memories_formed, error_message)
                  VALUES (?, ?, ?, ?, 'failed', NULL, 0, 0, ?)`,
            params: [runId, goal.goal_id, motebitId, now, msg],
          }).catch(() => {});

          await invoke<number>("db_execute", {
            sql: "UPDATE goals SET consecutive_failures = consecutive_failures + 1 WHERE goal_id = ?",
            params: [goal.goal_id],
          }).catch(() => {});

          if (goal.consecutive_failures + 1 >= goal.max_retries) {
            await invoke<number>("db_execute", {
              sql: "UPDATE goals SET status = 'paused' WHERE goal_id = ?",
              params: [goal.goal_id],
            }).catch(() => {});
          }

          this._goalCompleteCallback?.({
            goalId: goal.goal_id,
            prompt: goal.prompt,
            status: "failed",
            summary: null,
            error: msg,
          });
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

  /**
   * Execute a goal using PlanEngine for multi-step decomposition.
   * Falls back to single-turn streaming if PlanEngine is unavailable.
   */
  private async executePlanGoal(
    goal: { goal_id: string; prompt: string; mode: string },
    outcomes: Array<{
      ran_at: number;
      status: string;
      summary: string | null;
      error_message: string | null;
    }>,
    invoke: InvokeFn,
    runId?: string,
    signal?: AbortSignal,
  ): Promise<{
    suspended: boolean;
    toolCallsMade: number;
    responseText: string;
    planTitle?: string;
    stepsCompleted?: number;
    totalSteps?: number;
    tokensUsed?: number;
  }> {
    const runtime = this.deps.getRuntime()!;
    const loopDeps = runtime.getLoopDeps();
    const planEngine = this.deps.getPlanEngine();
    const planStore = this.deps.getPlanStore();

    // If PlanEngine or loopDeps are unavailable, fall back to single-turn execution
    if (!planEngine || !loopDeps || !planStore) {
      return this.executeSingleTurnGoal(goal, outcomes, invoke, runId, signal);
    }

    const registry = runtime.getToolRegistry();

    // Pre-load any existing active plan for this goal (async cache warm-up for Tauri)
    if ("preloadForGoal" in planStore && typeof planStore.preloadForGoal === "function") {
      await planStore.preloadForGoal(goal.goal_id);
    }

    // Check for existing active plan (resume interrupted plan)
    let plan = planStore.getPlanForGoal(goal.goal_id);
    let planStream: AsyncGenerator<PlanChunk>;

    if (plan && plan.status === PlanStatus.Active) {
      planStream = planEngine.resumePlan(plan.plan_id, loopDeps, undefined, runId);
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
      const newPlan = created.plan;
      plan = newPlan;
      if (created.truncatedFrom != null && created.truncatedFrom > 0) {
        // eslint-disable-next-line no-console
        console.warn(
          `Plan truncated from ${created.truncatedFrom} to ${newPlan.total_steps} steps (max ${newPlan.total_steps})`,
        );
      }
      planStream = planEngine.executePlan(newPlan.plan_id, loopDeps, undefined, runId);
    }

    return this.consumePlanStream(planStream, goal, invoke, runId, signal);
  }

  /**
   * Fallback: single-turn goal execution (pre-PlanEngine behavior).
   */
  private async executeSingleTurnGoal(
    goal: { goal_id: string; prompt: string; mode: string },
    outcomes: Array<{
      ran_at: number;
      status: string;
      summary: string | null;
      error_message: string | null;
    }>,
    invoke: InvokeFn,
    runId?: string,
    signal?: AbortSignal,
  ): Promise<{
    suspended: boolean;
    toolCallsMade: number;
    responseText: string;
    tokensUsed?: number;
  }> {
    const runtime = this.deps.getRuntime()!;
    const now = Date.now();
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
    let toolCallsMade = 0;
    let tokensUsed = 0;

    for await (const chunk of runtime.sendMessageStreaming(context, runId)) {
      if (signal?.aborted === true) {
        throw signal.reason instanceof Error ? signal.reason : new Error("Goal aborted");
      }
      if (chunk.type === "text") {
        accumulated += chunk.text;
      } else if (chunk.type === "tool_status" && chunk.status === "calling") {
        toolCallsMade++;
        if (toolCallsMade > MAX_TOOL_CALLS_PER_RUN) {
          throw new Error(`Goal exceeded ${MAX_TOOL_CALLS_PER_RUN} tool calls — run stopped`);
        }
      } else if (
        chunk.type === "result" &&
        chunk.result.totalTokens != null &&
        chunk.result.totalTokens > 0
      ) {
        tokensUsed += chunk.result.totalTokens;
      } else if (chunk.type === "approval_request") {
        this._pendingGoalApproval = {
          goalId: goal.goal_id,
          prompt: goal.prompt,
          invoke,
          mode: goal.mode,
          runId,
        };
        this._goalApprovalCallback?.({
          goalId: goal.goal_id,
          goalPrompt: goal.prompt,
          toolName: chunk.name,
          args: chunk.args,
          riskLevel: chunk.risk_level,
        });
        return {
          suspended: true,
          toolCallsMade,
          responseText: accumulated,
          tokensUsed: tokensUsed > 0 ? tokensUsed : undefined,
        };
      }
    }

    return {
      suspended: false,
      toolCallsMade,
      responseText: accumulated,
      tokensUsed: tokensUsed > 0 ? tokensUsed : undefined,
    };
  }

  /**
   * Consume a PlanEngine stream, forwarding progress to UI callbacks.
   */
  private async consumePlanStream(
    stream: AsyncGenerator<PlanChunk>,
    goal: { goal_id: string; prompt: string; mode: string },
    invoke: InvokeFn,
    runId?: string,
    signal?: AbortSignal,
  ): Promise<{
    suspended: boolean;
    toolCallsMade: number;
    responseText: string;
    planTitle?: string;
    stepsCompleted?: number;
    totalSteps?: number;
    tokensUsed?: number;
  }> {
    let toolCallsMade = 0;
    let responseText = "";
    let tokensUsed = 0;
    let planTitle: string | undefined;
    let totalSteps = 0;
    let stepsCompleted = 0;

    for await (const chunk of stream) {
      if (signal?.aborted === true) {
        throw signal.reason instanceof Error ? signal.reason : new Error("Goal aborted");
      }
      switch (chunk.type) {
        case "plan_created":
          planTitle = chunk.plan.title;
          totalSteps = chunk.steps.length;
          this._goalPlanProgressCallback?.({
            goalId: goal.goal_id,
            planTitle: chunk.plan.title,
            stepIndex: 0,
            totalSteps: chunk.steps.length,
            stepDescription: chunk.steps[0]?.description ?? "",
            type: "plan_created",
          });
          break;

        case "step_started":
          this._goalPlanProgressCallback?.({
            goalId: goal.goal_id,
            planTitle: planTitle ?? "",
            stepIndex: chunk.step.ordinal + 1,
            totalSteps,
            stepDescription: chunk.step.description,
            type: "step_started",
          });
          break;

        case "step_chunk":
          // Forward inner agentic chunks
          if (chunk.chunk.type === "text") {
            responseText += chunk.chunk.text;
          } else if (chunk.chunk.type === "tool_status" && chunk.chunk.status === "calling") {
            toolCallsMade++;
            if (toolCallsMade > MAX_TOOL_CALLS_PER_RUN) {
              throw new Error(`Goal exceeded ${MAX_TOOL_CALLS_PER_RUN} tool calls — run stopped`);
            }
          } else if (
            chunk.chunk.type === "result" &&
            chunk.chunk.result.totalTokens != null &&
            chunk.chunk.result.totalTokens > 0
          ) {
            tokensUsed += chunk.chunk.result.totalTokens;
          }
          break;

        case "step_completed":
          stepsCompleted++;
          this._goalPlanProgressCallback?.({
            goalId: goal.goal_id,
            planTitle: planTitle ?? "",
            stepIndex: chunk.step.ordinal + 1,
            totalSteps,
            stepDescription: chunk.step.description,
            type: "step_completed",
          });
          break;

        case "step_delegated": {
          const rc = chunk.routing_choice;
          const agentId = rc?.selected_agent ?? chunk.task_id?.slice(0, 8) ?? "network";
          const agentShort = agentId.length > 12 ? agentId.slice(0, 8) + "…" : agentId;
          let desc = `→ agent ${agentShort}: ${chunk.step.description}`;
          if (rc?.alternatives_considered != null && rc.alternatives_considered > 0)
            desc += ` (${rc.alternatives_considered + 1} evaluated)`;
          this._goalPlanProgressCallback?.({
            goalId: goal.goal_id,
            planTitle: planTitle ?? "",
            stepIndex: chunk.step.ordinal + 1,
            totalSteps,
            stepDescription: desc,
            type: "step_started",
          });
          break;
        }

        case "step_failed":
          this._goalPlanProgressCallback?.({
            goalId: goal.goal_id,
            planTitle: planTitle ?? "",
            stepIndex: chunk.step.ordinal + 1,
            totalSteps,
            stepDescription: chunk.step.description,
            type: "step_failed",
          });
          break;

        case "approval_request": {
          const innerChunk = chunk.chunk;
          if (innerChunk.type !== "approval_request") break;
          this._pendingGoalApproval = {
            goalId: goal.goal_id,
            prompt: goal.prompt,
            invoke,
            mode: goal.mode,
            planId: chunk.step.plan_id,
            runId,
          };
          this._goalApprovalCallback?.({
            goalId: goal.goal_id,
            goalPrompt: goal.prompt,
            toolName: innerChunk.name,
            args: innerChunk.args,
            riskLevel: innerChunk.risk_level,
          });
          return {
            suspended: true,
            toolCallsMade,
            responseText,
            planTitle,
            stepsCompleted,
            totalSteps,
            tokensUsed: tokensUsed > 0 ? tokensUsed : undefined,
          };
        }

        case "plan_completed":
          break;

        case "plan_failed":
          throw new Error(`Plan failed: ${chunk.reason}`);
      }
    }

    return {
      suspended: false,
      toolCallsMade,
      responseText,
      planTitle,
      stepsCompleted,
      totalSteps,
      tokensUsed: tokensUsed > 0 ? tokensUsed : undefined,
    };
  }
}
