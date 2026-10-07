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

import type { GoalRunScope, GoalRunGoal, MotebitRuntime, StreamChunk } from "@motebit/runtime";
import {
  paymentNoticeCopy,
  paidResultsOwedByRuns,
  goalRunWindows,
  goalAwaitingResultMessage,
} from "@motebit/runtime";
import { PlanStatus, SensitivityLevel } from "@motebit/sdk";
import type { PlanChunk, PlanEngine, PlanStoreAdapter } from "@motebit/planner";
import { isDelegationUndetermined } from "@motebit/planner";
import {
  createSubGoalDefinition,
  completeGoalDefinition,
  reportProgressDefinition,
} from "@motebit/tools/web-safe";
import { createGoalRow } from "./goal-rows.js";
import type { InvokeFn, TauriPlanStore } from "./tauri-storage.js";

/** Maximum tool calls across all turns in a single goal run (default 50). */
const MAX_TOOL_CALLS_PER_RUN = 50;

/** Wall-clock limit per goal run: 10 minutes. Bounds a run's window (#890). */
const GOAL_WALL_CLOCK_MS = 10 * 60 * 1000;

export interface GoalCompleteEvent {
  goalId: string;
  prompt: string;
  /**
   * `awaiting_result` (#890): the run stopped on a paid delegation whose
   * outcome is unknown. Not a failure; the goal does not re-fire into a
   * second payment and the owner checks `/result`.
   */
  status: "completed" | "failed" | "awaiting_result";
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
  /** v1 axis of the bounded-commitment envelope. NULL = no cap. See
   *  docs/doctrine/panel-temporal-registers.md §"Bounded commitment is
   *  multi-dimensional." */
  budget_tokens: number | null;
  /** The tier the goal's text was written at (tauri-migrations v10); NULL = legacy. */
  sensitivity?: string | null;
}

interface OutcomeRow {
  ran_at: number;
  status: string;
  summary: string | null;
  error_message: string | null;
  /** The tier of the run that produced it (tauri-migrations v10); NULL = legacy. */
  sensitivity?: string | null;
}

/** The goal fields a run reads. */
type RunGoal = { goal_id: string; prompt: string; mode: string } & GoalRunGoal;

export interface GoalSchedulerDeps {
  getRuntime: () => MotebitRuntime | null;
  getMotebitId: () => string;
  getPlanEngine: () => PlanEngine | null;
  getPlanStore: () => PlanStoreAdapter | TauriPlanStore | null;
}

/**
 * The outcome summary the owner reads (#885): a money warning from a hire in
 * the run leads it, so the 500/200-char previews never truncate it away. The
 * signed response artifact keeps the model's text alone.
 */
function ownerSummary(r: { responseText: string; paymentNotice?: string }): string {
  return r.paymentNotice != null ? `${r.paymentNotice} ${r.responseText}` : r.responseText;
}

export class GoalScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private _goalExecuting = false;
  /** The last "held — awaiting result" line logged, so a hold logs once (#890). */
  private _heldLogged: string | null = null;
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
    /** The paused run: its goal (to re-enter at its stamp) and its tier so far. */
    goal: RunGoal;
    run: GoalRunScope;
  } | null = null;
  /**
   * The run in flight (`runtime.beginGoalRun`): every interior item in its
   * prompt passes through it, and what it produces is stamped from it.
   */
  private _run: GoalRunScope | null = null;

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
        // The sub-goal's text was written by the model during this run:
        // stamped at the run's tier (runtime goal-run.ts). With no run in
        // reach its taint is unknowable: `secret`.
        await createGoalRow(invoke, {
          motebitId: getMotebitId(),
          goalId: subGoalId,
          prompt,
          intervalMs,
          mode,
          parentGoalId: this._currentGoalId,
          sensitivity: this._run?.outcomeSensitivity() ?? SensitivityLevel.Secret,
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

    const { goalId, prompt, invoke, mode, planId, runId, goal } = this._pendingGoalApproval;
    this._currentGoalId = goalId;
    let run: GoalRunScope | null = null;

    try {
      // The continuation is the same run: re-entered at the goal's stamp,
      // carrying the paused run's tier into what it produces.
      run = runtime.beginGoalRun(goal, {
        inherit: this._pendingGoalApproval.run.outcomeSensitivity(),
      });
      this._run = run;
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
        const planStore = this.deps.getPlanStore();
        if (loopDeps) {
          // Resuming the plan sends its steps: a send at its stamp.
          run.enterPlan(planStore?.getPlan(planId) ?? {});
          const planResult = await this.consumePlanStream(
            planEngine.resumePlan(planId, loopDeps, undefined, runId),
            goal,
            invoke,
          );
          if (planStore != null) run.stampPlan(planStore, planId);

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

      // Same signing path as the cadence-driven INSERT below: sign
      // the accumulated artifact bytes, persist the manifest JSON
      // alongside the artifact. Approval-resume IS a completed turn,
      // and Phase-3-deferral-close says every completed goal-fire's
      // artifact ships with a `ContentArtifactManifest`.
      const signedManifestJson = await this.signArtifactManifestJson(
        accumulated,
        goalId,
        outcomeId,
      );

      await invoke<number>("db_execute", {
        sql: `INSERT OR REPLACE INTO goal_outcomes (outcome_id, goal_id, motebit_id, ran_at, status, summary, tool_calls_made, memories_formed, error_message, response_full, signed_manifest, sensitivity)
              VALUES (?, ?, ?, ?, 'completed', ?, ?, 0, NULL, ?, ?, ?)`,
        params: [
          outcomeId,
          goalId,
          motebitId,
          now,
          accumulated.slice(0, 500),
          toolCallsMade,
          // Same artifact-preservation shape as the cadence-driven
          // path. Approval-resume IS the goal's completed turn — the
          // accumulated text is the full artifact.
          accumulated.length > 0 ? accumulated : null,
          signedManifestJson,
          run.outcomeSensitivity(),
        ],
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
      run?.end();
      if (this._pendingGoalApproval == null || this._pendingGoalApproval.goalId === goalId) {
        this._run = null;
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

        // Pre-fire budget gate. Sum spent tokens, compare against cap,
        // and on exhaustion flip status to `budget_exhausted` so the
        // next tick skips this goal until the user raises the cap via
        // `goals_set_budget_tokens` (which re-evaluates and flips back
        // to `active` when the new cap clears spend). Auto-pause is a
        // synthesized state from (cap, spent), never sticky.
        if (await this.checkBudgetExhausted(goal, invoke)) {
          continue;
        }

        const suspended = await this.executeGoalOnce(goal, invoke, motebitId, now);
        if (suspended) return;
      }
    } catch {
      this._goalExecuting = false;
      this._currentGoalId = null;
      this._goalStatusCallback?.(false);
    }
  }

  /**
   * True when a payment made during any of this goal's recent runs is still
   * owed its result (#890). Every run leaves a `running` outcome row BEFORE
   * it starts (`executeGoalOnce`), so a run that paid and then died is
   * counted too. A run's window is its `ran_at` (start) to the next run's
   * start — never cut at the wall clock, which a hire in flight outlives.
   * A ledger or database that cannot answer holds: an unknown answer is
   * not "nothing owed".
   */
  private async paidResultsOwed(
    goalId: string,
    invoke: InvokeFn,
    runtime: MotebitRuntime,
  ): Promise<boolean> {
    try {
      const rows = await invoke<Array<{ ran_at: number }>>("db_query", {
        sql: "SELECT ran_at FROM goal_outcomes WHERE goal_id = ? ORDER BY ran_at DESC LIMIT 20",
        params: [goalId],
      });
      if (rows.length === 0) return false;
      const owed = paidResultsOwedByRuns(
        runtime.outstandingPaidResults(),
        // No wall-clock bound on the window (#890 r3): the deadline abort is
        // cooperative, so a hire in flight at the deadline still lands — and
        // is stamped — after it. A run's window ends where the goal's next
        // run began.
        goalRunWindows(rows.map((r) => ({ startedAt: r.ran_at, endedAt: null }))),
      );
      if (owed.length === 0) return false;
      const line = goalAwaitingResultMessage(owed);
      if (this._heldLogged !== `${goalId}:${line}`) {
        this._heldLogged = `${goalId}:${line}`;
        // eslint-disable-next-line no-console
        console.warn(`[goal] ${goalId.slice(0, 8)} held — ${line}`);
      }
      return true;
    } catch {
      return true;
    }
  }

  /**
   * Returns true if the goal's tokens-axis budget envelope is
   * exhausted. On exhaustion: persists `status='budget_exhausted'`
   * (idempotent against the active-status pre-condition) so the
   * surface picks up the state on the next refresh. Mirrors the
   * runtime's `checkGoalBudget` in `@motebit/runtime/goals.ts` —
   * inlined here for the v1 single-axis case because the desktop
   * scheduler doesn't yet round-trip multi-axis caps.
   */
  private async checkBudgetExhausted(goal: GoalRow, invoke: InvokeFn): Promise<boolean> {
    if (goal.budget_tokens == null) return false;
    const rows = await invoke<Array<{ spent: number | null }>>("db_query", {
      sql: "SELECT COALESCE(SUM(tokens_used), 0) AS spent FROM goal_outcomes WHERE goal_id = ?",
      params: [goal.goal_id],
    });
    const spent = Number(rows[0]?.spent ?? 0);
    if (spent < goal.budget_tokens) return false;
    await invoke<number>("db_execute", {
      sql: "UPDATE goals SET status = 'budget_exhausted' WHERE goal_id = ? AND status NOT IN ('completed', 'failed')",
      params: [goal.goal_id],
    }).catch(() => {});
    return true;
  }

  /**
   * Sign a goal-fire's artifact bytes as a `ContentArtifactManifest`
   * (JCS-canonical + suite-dispatched signing via `@motebit/crypto`)
   * and return the JSON for persistence into
   * `goal_outcomes.signed_manifest`. Returns `null` when content is
   * empty, identity isn't loaded, or the signer throws — calm-software
   * degradation per `docs/doctrine/goal-results.md` §"Phase-3 deferral
   * close" (no placeholder signatures, ever). The SQL projection in
   * `list_goals_with_meta` reads `signed_manifest IS NOT NULL` to
   * surface the receipt-summary row's "signed" indicator; null here
   * cleanly maps to the row rendering without the chip.
   */
  private async signArtifactManifestJson(
    content: string,
    goalId: string,
    runId: string,
  ): Promise<string | null> {
    if (content.length === 0) return null;
    const runtime = this.deps.getRuntime();
    if (!runtime) return null;
    try {
      const manifest = await runtime.signGoalArtifact(content, { goalId, runId });
      return manifest != null ? JSON.stringify(manifest) : null;
    } catch {
      return null;
    }
  }

  /**
   * Immediately run a single active goal, bypassing cadence. Invoked by
   * the Goals-panel "Run now" affordance. Silently skips if another
   * goal is executing or the runtime is mid-turn (same semantics as the
   * tick loop's `skipped` outcome — no throw, no outcome row). Throws
   * only on adapter errors (missing goal, DB failure) so callers can
   * surface them.
   */
  async runNow(invoke: InvokeFn, goalId: string): Promise<void> {
    const runtime = this.deps.getRuntime();
    if (!runtime) throw new Error("Runtime not initialized");
    if (this._goalExecuting || runtime.isProcessing) return;

    const motebitId = this.deps.getMotebitId();
    const rows = await invoke<GoalRow[]>("db_query", {
      sql: "SELECT * FROM goals WHERE goal_id = ? LIMIT 1",
      params: [goalId],
    });
    const goal = rows[0];
    if (!goal) throw new Error(`Goal not found: ${goalId}`);

    // Run-now is a user-driven escape from cadence; it should respect
    // the goal's lifecycle state (paused / completed / failed). UIs
    // only render the button on active rows, but enforce here too.
    if (goal.status !== "active") return;

    await this.executeGoalOnce(goal, invoke, motebitId, Date.now());
  }

  /**
   * Execute one goal through the plan flow, record its outcome, and
   * manage the scheduler's execution state. Returns `true` if the run
   * suspended for user approval — caller should not start another goal
   * this pass. Shared by `goalTick` (cadence-driven) and `runNow`
   * (user-driven). Preconditions: `_goalExecuting` is false and the
   * runtime is not mid-turn — callers guard before calling.
   */
  private async executeGoalOnce(
    goal: GoalRow,
    invoke: InvokeFn,
    motebitId: string,
    now: number,
  ): Promise<boolean> {
    // A payment one of the goal's runs made whose result never arrived
    // holds the goal (#890): a re-fire could hire a different worker for the
    // same work and pay twice. Checked HERE, at the one entry both the
    // cadence tick and "Run now" go through. Lifts only when the result is
    // retrieved or dismissed (`/result`).
    const runtime = this.deps.getRuntime();
    if (runtime == null || (await this.paidResultsOwed(goal.goal_id, invoke, runtime))) {
      return false;
    }

    this._goalExecuting = true;
    this._currentGoalId = goal.goal_id;
    this._goalStatusCallback?.(true);

    const runId = crypto.randomUUID();

    // The run's start, recorded durably BEFORE anything can be paid (#890):
    // a run that pays and then dies still owns a window the paid-intent
    // hold can attribute to. The final outcome replaces this row. No start
    // record, no run — failing closed costs one tick.
    try {
      await invoke<number>("db_execute", {
        // Stamped `secret` until the final outcome replaces it: a row left
        // behind by a dead run has no knowable taint (it carries no text).
        sql: `INSERT OR REPLACE INTO goal_outcomes (outcome_id, goal_id, motebit_id, ran_at, status, summary, tool_calls_made, memories_formed, error_message, sensitivity)
              VALUES (?, ?, ?, ?, 'running', NULL, 0, 0, NULL, ?)`,
        params: [runId, goal.goal_id, motebitId, now, SensitivityLevel.Secret],
      });
    } catch {
      this._goalExecuting = false;
      this._currentGoalId = null;
      this._goalStatusCallback?.(false);
      return false;
    }

    let run: GoalRunScope | null = null;
    try {
      const outcomes = await invoke<OutcomeRow[]>("db_query", {
        sql: "SELECT ran_at, status, summary, error_message, sensitivity FROM goal_outcomes WHERE goal_id = ? AND status != 'running' ORDER BY ran_at DESC LIMIT 3",
        params: [goal.goal_id],
      });
      // The run sends at no lower tier than the goal's text: a goal written
      // at Secret refuses here on an external provider (runtime goal-run.ts).
      run = runtime.beginGoalRun(goal);
      this._run = run;

      // Wall-clock limit per goal run.
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
          run,
          runId,
          abortController.signal,
        );
      } finally {
        clearTimeout(deadlineTimer);
      }

      if (result.suspended) {
        // Approval requested — _goalExecuting stays true to block
        // further ticks and run-now invocations.
        return true;
      }

      await invoke<number>("db_execute", {
        sql: "UPDATE goals SET last_run_at = ?, consecutive_failures = 0 WHERE goal_id = ?",
        params: [now, goal.goal_id],
      });

      // Sign the artifact bytes per the Phase-3 deferral close
      // (docs/doctrine/goal-results.md §"Phase-3 deferral close"):
      // every successful fire's `response_full` lands as a signed
      // `ContentArtifactManifest` next to the artifact itself.
      // `signArtifactManifestJson` returns `null` calm-software-
      // gracefully on every degradation path (empty / no identity /
      // signer throws); the SQL projection reads NULL as "no
      // indicator on the card."
      const signedManifestJson = await this.signArtifactManifestJson(
        result.responseText,
        goal.goal_id,
        runId,
      );

      await invoke<number>("db_execute", {
        sql: `INSERT OR REPLACE INTO goal_outcomes (outcome_id, goal_id, motebit_id, ran_at, status, summary, tool_calls_made, memories_formed, error_message, tokens_used, response_full, signed_manifest, sensitivity)
              VALUES (?, ?, ?, ?, 'completed', ?, ?, 0, NULL, ?, ?, ?, ?)`,
        params: [
          runId,
          goal.goal_id,
          motebitId,
          now,
          ownerSummary(result).slice(0, 500),
          result.toolCallsMade,
          result.tokensUsed ?? null,
          // Preserve the full artifact bytes per
          // `docs/doctrine/goal-results.md` §"The three categories".
          // `summary` (500-char) feeds the executions-panel preview;
          // `response_full` is the artifact the slab already rendered
          // via `motebit-runtime.ts` `restItem`; `signed_manifest`
          // is the cryptographic attestation on the same row.
          result.responseText.length > 0 ? result.responseText : null,
          signedManifestJson,
          run.outcomeSensitivity(),
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
        summary: ownerSummary(result).slice(0, 200),
        error: null,
        planTitle: result.planTitle,
        stepsCompleted: result.stepsCompleted,
        totalSteps: result.totalSteps,
      });

      return false;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      // A refused run's message is the gate's (content-free): stamped at
      // the session's tier so the next run can read why it failed.
      const stamp = run?.outcomeSensitivity() ?? runtime.goalCreationSensitivity();

      // A delegated step whose paid outcome is unknown (#890): not a
      // failure. `partial`, no failure count, no auto-pause; the next fire
      // comes on the goal's own cadence and resumes the held plan.
      if (isDelegationUndetermined(err)) {
        const note = `awaiting result — ${msg}`;
        await invoke<number>("db_execute", {
          sql: `INSERT OR REPLACE INTO goal_outcomes (outcome_id, goal_id, motebit_id, ran_at, status, summary, tool_calls_made, memories_formed, error_message, sensitivity)
                VALUES (?, ?, ?, ?, 'partial', ?, 0, 0, NULL, ?)`,
          params: [runId, goal.goal_id, motebitId, now, note.slice(0, 500), stamp],
        }).catch(() => {});
        await invoke<number>("db_execute", {
          sql: "UPDATE goals SET last_run_at = ? WHERE goal_id = ?",
          params: [now, goal.goal_id],
        }).catch(() => {});
        this._goalCompleteCallback?.({
          goalId: goal.goal_id,
          prompt: goal.prompt,
          status: "awaiting_result",
          summary: note,
          error: null,
        });
        return false;
      }

      await invoke<number>("db_execute", {
        sql: `INSERT OR REPLACE INTO goal_outcomes (outcome_id, goal_id, motebit_id, ran_at, status, summary, tool_calls_made, memories_formed, error_message, sensitivity)
              VALUES (?, ?, ?, ?, 'failed', NULL, 0, 0, ?, ?)`,
        params: [runId, goal.goal_id, motebitId, now, msg, stamp],
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

      return false;
    } finally {
      // The floor is released even when the run pauses for approval: the
      // paused turn carries its own stamp, and the resume re-enters the run.
      run?.end();
      if (!this._pendingGoalApproval) {
        this._run = null;
        this._goalExecuting = false;
        this._currentGoalId = null;
        this._goalStatusCallback?.(false);
        this.deps.getRuntime()?.resetConversation();
      }
    }
  }

  /**
   * Execute a goal using PlanEngine for multi-step decomposition.
   * Falls back to single-turn streaming if PlanEngine is unavailable.
   */
  private async executePlanGoal(
    goal: RunGoal,
    outcomes: OutcomeRow[],
    invoke: InvokeFn,
    run: GoalRunScope,
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
    /** #885: owner-facing money warning(s) from a hire in this run. */
    paymentNotice?: string;
  }> {
    const runtime = this.deps.getRuntime()!;
    const loopDeps = runtime.getLoopDeps();
    const planEngine = this.deps.getPlanEngine();
    const planStore = this.deps.getPlanStore();

    // If PlanEngine or loopDeps are unavailable, fall back to single-turn execution
    if (!planEngine || !loopDeps || !planStore) {
      return this.executeSingleTurnGoal(goal, outcomes, invoke, run, runId, signal);
    }

    const registry = runtime.getToolRegistry();

    // Pre-load any existing active plan for this goal (async cache warm-up for Tauri)
    if ("preloadForGoal" in planStore && typeof planStore.preloadForGoal === "function") {
      await planStore.preloadForGoal(goal.goal_id);
    }

    // Check for existing active plan (resume interrupted plan). A plan
    // holding a delegated step with an unknown paid outcome is the goal's
    // latest, so it is resumed here, which settles the step from the relay's
    // receipt or holds it again; `createPlan` refuses a new one (#890).
    let plan = planStore.getPlanForGoal(goal.goal_id);
    let planStream: AsyncGenerator<PlanChunk>;

    if (plan && plan.status === PlanStatus.Active) {
      // Resuming the plan sends its steps: a send at its stamp.
      run.enterPlan(plan);
      planStream = planEngine.resumePlan(plan.plan_id, loopDeps, undefined, runId);
    } else {
      const created = await planEngine.createPlan(
        goal.goal_id,
        this.deps.getMotebitId(),
        {
          goalPrompt: goal.prompt,
          previousOutcomes: run.planOutcomes(outcomes),
          availableTools: registry.list().map((t) => t.name),
        },
        loopDeps,
      );
      run.stampPlan(planStore, created.plan.plan_id);
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

    try {
      return await this.consumePlanStream(planStream, goal, invoke, runId, signal);
    } finally {
      // The plan's steps now carry what this run produced.
      run.stampPlan(planStore, plan.plan_id);
    }
  }

  /**
   * Fallback: single-turn goal execution (pre-PlanEngine behavior).
   */
  private async executeSingleTurnGoal(
    goal: RunGoal,
    outcomes: OutcomeRow[],
    invoke: InvokeFn,
    run: GoalRunScope,
    runId?: string,
    signal?: AbortSignal,
  ): Promise<{
    suspended: boolean;
    toolCallsMade: number;
    responseText: string;
    tokensUsed?: number;
  }> {
    const runtime = this.deps.getRuntime()!;
    // The goal and the earlier outcomes the run's tier permits — the one
    // shared assembly (runtime goal-run.ts).
    const context = run.prompt(goal, outcomes, Date.now());

    let accumulated = "";
    let toolCallsMade = 0;
    let tokensUsed = 0;
    // #885: a money warning from a hire in this run — carried on the result
    // (the outcome summary + onGoalComplete), never into the signed artifact.
    const notices: string[] = [];

    // Phase 3 of the goal-results arc — annotate the resting slab
    // item with goalContext so it's *legible* as the goal's artifact
    // per `docs/doctrine/goal-results.md` §"The three categories".
    // The slab item's id is `slabTurnIdForRun(runId)`; the desktop
    // scheduler already uses `runId` as `goal_outcomes.outcome_id`,
    // so `goals_list` projects `slab-turn-${outcome_id}` onto
    // `ScheduledGoal.last_turn_id` without a separate column.
    for await (const chunk of runtime.sendMessageStreaming(context, runId, {
      goalContext: { goal_id: goal.goal_id, goal_prompt: goal.prompt },
    })) {
      if (signal?.aborted === true) {
        throw signal.reason instanceof Error ? signal.reason : new Error("Goal aborted");
      }
      if (chunk.type === "text") {
        accumulated += chunk.text;
      } else if (chunk.type === "payment_notice") {
        notices.push(paymentNoticeCopy(chunk));
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
          goal,
          run,
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
          ...(notices.length > 0 ? { paymentNotice: notices.join(" ") } : {}),
        };
      }
    }

    return {
      suspended: false,
      toolCallsMade,
      responseText: accumulated,
      tokensUsed: tokensUsed > 0 ? tokensUsed : undefined,
      ...(notices.length > 0 ? { paymentNotice: notices.join(" ") } : {}),
    };
  }

  /**
   * Consume a PlanEngine stream, forwarding progress to UI callbacks.
   */
  private async consumePlanStream(
    stream: AsyncGenerator<PlanChunk>,
    goal: RunGoal,
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
            goal,
            run: this._run!,
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

        case "plan_undetermined":
          // Not a failure (#890) — `executeGoalOnce` records it as awaiting
          // its result and never counts it toward auto-pause.
          throw Object.assign(new Error(chunk.reason), { undetermined: true });

        case "plan_busy":
          // Another driver holds the plan right now (#890) — not a failure.
          throw Object.assign(new Error("the plan is being settled by another run"), {
            undetermined: true,
          });
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
