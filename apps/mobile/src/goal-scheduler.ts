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

import type { GoalRunGoal, GoalRunScope, MotebitRuntime, StreamChunk } from "@motebit/runtime";
import {
  paymentNoticeCopy,
  paidResultsOwedByRuns,
  goalRunWindows,
  goalAwaitingResultMessage,
} from "@motebit/runtime";
import type { PlanChunk, PlanEngine } from "@motebit/planner";
import { isDelegationUndetermined } from "@motebit/planner";
import { PlanStatus } from "@motebit/sdk";
import { SensitivityLevel } from "@motebit/sdk";
import type { ExpoGoalStore, GoalOutcome } from "./adapters/expo-sqlite";
import type { ExpoStorageResult } from "./adapters/expo-sqlite";

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
}

export interface GoalApprovalEvent {
  goalId: string;
  goalPrompt: string;
  toolName: string;
  args: Record<string, unknown>;
  riskLevel?: number;
}

/** The goal fields a run reads. */
type RunGoal = {
  goal_id: string;
  prompt: string;
  mode: string;
  budget_tokens?: number | null;
} & GoalRunGoal;

/** Parse interval strings like "1h", "30m", "1d", "1w" to milliseconds. */
export function parseInterval(s: string): number {
  const match = s.match(/^(\d+)\s*(m|h|d|w)$/i);
  if (!match) return 3_600_000;
  const n = parseInt(match[1]!, 10);
  switch (match[2]!.toLowerCase()) {
    case "m":
      return n * 60_000;
    case "h":
      return n * 3_600_000;
    case "d":
      return n * 86_400_000;
    case "w":
      return n * 604_800_000;
    default:
      return 3_600_000;
  }
}

export interface GoalSchedulerDeps {
  getRuntime: () => MotebitRuntime | null;
  getMotebitId: () => string;
  getPlanEngine: () => PlanEngine | null;
  getStorage: () => ExpoStorageResult | null;
}

/** The plan store the scheduler's runs read and stamp. */
function planStore(deps: GoalSchedulerDeps): ExpoStorageResult["planStore"] | null {
  return deps.getStorage()?.planStore ?? null;
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
    /** The paused run: its goal (to re-enter at its stamp) and its tier so far. */
    goal: RunGoal;
    scope: GoalRunScope;
  } | null = null;

  /**
   * The run in flight (`runtime.beginGoalRun`): every interior item in its
   * prompt passes through it, and what it produces — the outcome row, a
   * plan, a sub-goal — is stamped from it.
   */
  private _scope: GoalRunScope | null = null;

  /**
   * The run in flight: its outcome id and start (#890). The start row is
   * written before anything can be paid; the final outcome replaces it, so a
   * run that pays and dies still owns a window the paid-intent hold sees.
   * Kept across an approval pause — the resume finishes the same run.
   */
  private _run: { id: string; startedAt: number } | null = null;

  constructor(private deps: GoalSchedulerDeps) {}

  /** The current run's outcome row identity; a fresh one when none is open. */
  private takeRun(now: number): { id: string; startedAt: number } {
    const run = this._run ?? { id: crypto.randomUUID(), startedAt: now };
    this._run = null;
    return run;
  }

  getGoalStore(): ExpoGoalStore | null {
    return this.deps.getStorage()?.goalStore ?? null;
  }

  /**
   * The stamp for what the current run produces (no run: the session's
   * write tier; no runtime either: unknowable, `secret`). Never absent.
   */
  private outcomeStamp(): SensitivityLevel {
    return (
      this._scope?.outcomeSensitivity() ??
      this.deps.getRuntime()?.interiorWriteSensitivity() ??
      SensitivityLevel.Secret
    );
  }

  /**
   * The `create_sub_goal` tool (wired by MobileApp): the model writes the
   * sub-goal's text during the run, so it is stamped at the run's tier.
   */
  createSubGoal(
    args: Record<string, unknown>,
  ): Promise<
    | { ok: true; data: { goal_id: string; prompt: string; mode: string; interval_ms: number } }
    | { ok: false; error: string }
  > {
    const goalStore = this.getGoalStore();
    if (this._currentGoalId == null || this._currentGoalId === "" || goalStore == null) {
      return Promise.resolve({ ok: false, error: "No active goal context" });
    }
    const prompt = args.prompt as string;
    const interval = args.interval as string | undefined;
    const once = args.once as boolean | undefined;
    const intervalMs = interval != null && interval !== "" ? parseInterval(interval) : 3_600_000;
    const mode = once === true ? "once" : "recurring";
    const subGoalId = goalStore.addGoal(
      this.deps.getMotebitId(),
      prompt,
      intervalMs,
      mode,
      null,
      this.outcomeStamp(),
    );
    return Promise.resolve({
      ok: true,
      data: { goal_id: subGoalId, prompt, mode, interval_ms: intervalMs },
    });
  }

  /**
   * Sign a goal-fire's artifact bytes as a `ContentArtifactManifest`
   * (JCS-canonical + suite-dispatched via `@motebit/crypto`) and return
   * the JSON for persistence into `goal_outcomes.signed_manifest`.
   * Returns `null` on every degradation path (empty content, no
   * runtime, signer threw, manifest came back null) — calm-software
   * default per `docs/doctrine/goal-results.md` §"Phase-3 deferral
   * close": never silently signed with a placeholder. The receipt-
   * summary row on the goal card reads
   * `last_manifest_signed = (signed_manifest != null)` to render the
   * "signed" indicator, identical wire shape to web + desktop.
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

    const { goalId, prompt, mode, planId, goal } = this._pendingGoalApproval;
    let scope: GoalRunScope | null = null;

    try {
      // The continuation is the same run: re-entered at the goal's stamp,
      // carrying the paused run's tier into what it produces.
      scope = runtime.beginGoalRun(goal, {
        inherit: this._pendingGoalApproval.scope.outcomeSensitivity(),
      });
      this._scope = scope;
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
          // Resuming the plan sends its steps: a send at its stamp.
          const ps = planStore(this.deps);
          scope.enterPlan(ps?.getPlan(planId) ?? {});
          const planResult = await this.consumePlanStream(
            planEngine.resumePlan(planId, loopDeps),
            goal,
            planId,
          );
          if (ps != null) scope.stampPlan(ps, planId);
          accumulated += planResult.responseFull;
          if (planResult.suspended) return; // Another approval needed
        }
      }

      // Record outcome — `summary` stays the 500-char executions-panel
      // preview; `responseFull` is the artifact bytes (full untruncated
      // text). Per `docs/doctrine/goal-results.md` §"The three
      // categories" Phase 2.
      const now = Date.now();
      await this.finishGoalSuccess(
        { goal_id: goalId, prompt, mode },
        accumulated.slice(0, 500),
        now,
        null,
        accumulated,
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.finishGoalFailure({ goal_id: goalId, prompt, mode }, msg, Date.now());
      throw err;
    } finally {
      scope?.end();
      this._scope = null;
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

        // Pre-fire budget gate. The v1 axis is `tokens`; sum spent
        // tokens against the goal's cap and flip status to
        // `budget_exhausted` on exhaustion. listActiveGoals naturally
        // skips exhausted goals on the next tick because it filters
        // status='active' — raising the cap via setBudgetTokens flips
        // status back to active and the goal resumes. Doctrine:
        // panel-temporal-registers.md §"Bounded commitment is
        // multi-dimensional."
        if (goal.budget_tokens != null) {
          const spent = goalStore.getSpentTokens(goal.goal_id);
          if (spent >= goal.budget_tokens) {
            goalStore.setStatus(goal.goal_id, "budget_exhausted");
            continue;
          }
        }

        // A payment the goal's last run made whose result never arrived
        // holds the goal (#890): a re-fire could hire a different worker
        // for the same work and pay twice. Lifts only when the result is
        // retrieved or dismissed (`/result`).
        if (this.paidResultsOwed(goal.goal_id, runtime)) continue;

        // The run's start, durably, before it can pay (#890). No start
        // record, no run — failing closed costs one tick.
        const runId = crypto.randomUUID();
        try {
          goalStore.insertOutcome({
            outcome_id: runId,
            goal_id: goal.goal_id,
            motebit_id: this.deps.getMotebitId(),
            ran_at: now,
            status: "running",
            summary: null,
            tool_calls_made: 0,
            memories_formed: 0,
            error_message: null,
            tokens_used: null,
            response_full: null,
            signed_manifest: null,
            // Replaced by the final outcome; a row left behind by a dead
            // run carries no text and has no knowable taint.
            sensitivity: SensitivityLevel.Secret,
          });
        } catch {
          continue;
        }
        this._run = { id: runId, startedAt: now };

        this._goalExecuting = true;
        this._currentGoalId = goal.goal_id;
        this._goalStatusCallback?.(true);

        try {
          // Past runs only — this run's own start row is not history.
          const outcomes = goalStore
            .getRecentOutcomes(goal.goal_id, 4)
            .filter((o) => o.status !== "running" && o.outcome_id !== runId)
            .slice(0, 3);
          // The run sends at no lower tier than the goal's text — a goal
          // written at Secret refuses here on an external provider — and
          // its prompt carries only what that tier permits (runtime
          // goal-run.ts).
          const scope = runtime.beginGoalRun(goal);
          this._scope = scope;
          const loopDeps = runtime.getLoopDeps();
          const planEngine = this.deps.getPlanEngine();

          // Plan-based execution when PlanEngine is available
          if (planEngine && loopDeps) {
            const result = await this.executePlanGoal(goal, outcomes, scope);
            if (result.suspended) return; // Waiting for approval
            await this.finishGoalSuccess(
              goal,
              result.summary,
              now,
              result.tokensUsed,
              result.responseFull,
            );
          } else {
            // Fallback: single-turn streaming
            const result = await this.executeSingleTurnGoal(goal, outcomes, now, scope);
            if (result.suspended) return;
            await this.finishGoalSuccess(
              goal,
              result.summary,
              now,
              result.tokensUsed,
              result.responseFull,
            );
          }
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          // A delegated step whose paid outcome is unknown (#890): not a
          // failure — no failure count, and the next fire resumes the held
          // plan on the goal's own cadence.
          if (isDelegationUndetermined(err)) this.finishGoalAwaitingResult(goal, msg, now);
          else this.finishGoalFailure(goal, msg, now);
        } finally {
          // Released even when the run pauses for approval: the paused
          // turn carries its own stamp, and the resume re-enters the run.
          this._scope?.end();
          if (!this._pendingGoalApproval) {
            this._scope = null;
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
    goal: RunGoal,
    outcomes: GoalOutcome[],
    scope: GoalRunScope,
  ): Promise<{
    suspended: boolean;
    summary: string;
    responseFull: string;
    tokensUsed: number | null;
  }> {
    const runtime = this.deps.getRuntime()!;
    const planEngine = this.deps.getPlanEngine()!;
    const loopDeps = runtime.getLoopDeps()!;
    const planStore = this.deps.getStorage()!.planStore;
    const registry = runtime.getToolRegistry();

    // Check for existing active plan (resume interrupted plan). A plan
    // holding a delegated step with an unknown paid outcome is the goal's
    // latest active plan, so it is resumed here, which settles the step from
    // the relay's receipt or holds it again; `createPlan` refuses a new one
    // (#890).
    let plan = planStore.getPlanForGoal(goal.goal_id);
    let planStream: AsyncGenerator<PlanChunk>;

    if (plan && plan.status === PlanStatus.Active) {
      // Resuming the plan sends its steps: a send at its stamp.
      scope.enterPlan(plan);
      planStream = planEngine.resumePlan(plan.plan_id, loopDeps);
    } else {
      const created = await planEngine.createPlan(
        goal.goal_id,
        this.deps.getMotebitId(),
        {
          goalPrompt: goal.prompt,
          previousOutcomes: scope.planOutcomes(outcomes),
          availableTools: registry.list().map((t) => t.name),
        },
        loopDeps,
      );
      plan = created.plan;
      scope.stampPlan(planStore, plan.plan_id);
      planStream = planEngine.executePlan(created.plan.plan_id, loopDeps);
    }

    try {
      return await this.consumePlanStream(planStream, goal, plan.plan_id);
    } finally {
      // The plan's steps now carry what this run produced.
      scope.stampPlan(planStore, plan.plan_id);
    }
  }

  /** Consume a PlanEngine stream, handling approval requests. */
  private async consumePlanStream(
    stream: AsyncGenerator<PlanChunk>,
    goal: RunGoal,
    planId: string,
  ): Promise<{
    suspended: boolean;
    summary: string;
    responseFull: string;
    tokensUsed: number | null;
  }> {
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
            goal,
            scope: this._scope!,
          };
          this._goalApprovalCallback?.({
            goalId: goal.goal_id,
            goalPrompt: goal.prompt,
            toolName: chunk.chunk.type === "approval_request" ? chunk.chunk.name : "unknown",
            args: chunk.chunk.type === "approval_request" ? chunk.chunk.args : {},
            riskLevel: chunk.chunk.type === "approval_request" ? chunk.chunk.risk_level : undefined,
          });
          // Plan-side token attribution lands when plan_completed
          // carries per-step or aggregate token counts; for now the
          // plan-mode goal accumulates spent_tokens=0 (advisory).
          return {
            suspended: true,
            summary: accumulated.slice(0, 500),
            responseFull: accumulated,
            tokensUsed: null,
          };
        }
        case "plan_completed":
        case "plan_failed":
          break;
        case "plan_undetermined":
          // Not a failure (#890) — the catch records it as awaiting its result.
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
      summary: accumulated.slice(0, 500),
      responseFull: accumulated,
      tokensUsed: null,
    };
  }

  /** Execute a goal with simple single-turn streaming (fallback). */
  private async executeSingleTurnGoal(
    goal: RunGoal,
    outcomes: GoalOutcome[],
    now: number,
    scope: GoalRunScope,
  ): Promise<{
    suspended: boolean;
    summary: string;
    responseFull: string;
    tokensUsed: number | null;
  }> {
    const runtime = this.deps.getRuntime()!;
    // The goal and the earlier outcomes the run's tier permits — the one
    // shared assembly (runtime goal-run.ts).
    const context = scope.prompt(goal, outcomes, now);

    let accumulated = "";
    let tokensUsed: number | null = null;
    // #885: a money warning from a hire in this run — carried at the FRONT of
    // the outcome summary (the row and onGoalComplete the owner sees), never
    // into the signed response artifact.
    const notices: string[] = [];
    const summarize = (): string =>
      (notices.length > 0 ? `${notices.join(" ")} ${accumulated}` : accumulated).slice(0, 500);
    for await (const chunk of runtime.sendMessageStreaming(context)) {
      if (chunk.type === "text") {
        accumulated += chunk.text;
      } else if (chunk.type === "payment_notice") {
        notices.push(paymentNoticeCopy(chunk));
      } else if (chunk.type === "result" && typeof chunk.result.totalTokens === "number") {
        // TurnResult.totalTokens is sum across the agentic loop's LLM
        // calls in this turn. Feeds the runtime register's budget
        // envelope (v1 axis = tokens).
        tokensUsed = chunk.result.totalTokens;
      } else if (chunk.type === "approval_request") {
        this._pendingGoalApproval = {
          goalId: goal.goal_id,
          prompt: goal.prompt,
          mode: goal.mode,
          goal,
          scope,
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
          summary: summarize(),
          responseFull: accumulated,
          tokensUsed,
        };
      }
    }

    return {
      suspended: false,
      summary: summarize(),
      responseFull: accumulated,
      tokensUsed,
    };
  }

  private async finishGoalSuccess(
    goal: { goal_id: string; prompt: string; mode: string; budget_tokens?: number | null },
    summary: string,
    now: number,
    tokensUsed: number | null = null,
    responseFull: string | null = null,
  ): Promise<void> {
    const goalStore = this.deps.getStorage()?.goalStore;
    if (!goalStore) return;
    const motebitId = this.deps.getMotebitId();

    goalStore.updateLastRun(goal.goal_id, now);
    goalStore.resetFailures(goal.goal_id);

    // Sign the artifact bytes per docs/doctrine/goal-results.md
    // §"Phase-3 deferral close" — the manifest JSON lands on the
    // outcome row alongside the artifact bytes. Calm-software default
    // (null on every degradation path) means the card's
    // receipt-summary row simply omits the "signed" indicator when
    // signing isn't possible; no placeholder signatures.
    const run = this.takeRun(now);
    const outcomeId = run.id;
    const signedManifestJson =
      responseFull != null
        ? await this.signArtifactManifestJson(responseFull, goal.goal_id, outcomeId)
        : null;

    goalStore.insertOutcome({
      outcome_id: outcomeId,
      goal_id: goal.goal_id,
      motebit_id: motebitId,
      ran_at: run.startedAt,
      status: "completed",
      summary,
      tool_calls_made: 0,
      memories_formed: 0,
      error_message: null,
      tokens_used: tokensUsed,
      // Preserve the full artifact bytes per
      // `docs/doctrine/goal-results.md` §"The three categories". The
      // `summary` field stays a 500-char executions-panel preview;
      // `response_full` is the artifact the slab already rendered via
      // `motebit-runtime.ts` `restItem`; `signed_manifest` is the
      // cryptographic attestation on the same row (Phase-3 deferral
      // close).
      response_full: responseFull,
      signed_manifest: signedManifestJson,
      sensitivity: this.outcomeStamp(),
    });

    if (goal.mode === "once") {
      goalStore.setStatus(goal.goal_id, "completed");
    } else if (goal.budget_tokens != null) {
      // Recurring goal under a cap — re-evaluate post-run to catch the
      // crossing-point case where this fire's tokens push spent past
      // cap. Next tick already filters status='active', so flipping
      // here gates the next firing immediately rather than waiting for
      // the next tick's cap-check.
      const spent = goalStore.getSpentTokens(goal.goal_id);
      if (spent >= goal.budget_tokens) {
        goalStore.setStatus(goal.goal_id, "budget_exhausted");
      }
    }

    this._goalCompleteCallback?.({
      goalId: goal.goal_id,
      prompt: goal.prompt,
      status: "completed",
      summary: summary.slice(0, 200),
      error: null,
    });
  }

  /**
   * True when a payment made since this goal's last run started is still
   * owed its result (#890). Mobile runs carry no wall-clock bound, so the
   * window stays open: a later unrelated hire can over-hold, never
   * under-hold. A ledger that cannot answer holds.
   */
  private paidResultsOwed(goalId: string, runtime: MotebitRuntime): boolean {
    const goalStore = this.deps.getStorage()?.goalStore;
    try {
      // Every recent run, finished or not — each wrote its start row
      // before it could pay. Mobile runs carry no wall clock, so a run's
      // window ends where the goal's next run began; the latest stays open.
      const runs = goalStore?.getRecentOutcomes(goalId, 20) ?? [];
      if (runs.length === 0) return false;
      const owed = paidResultsOwedByRuns(
        runtime.outstandingPaidResults(),
        goalRunWindows(runs.map((r) => ({ startedAt: r.ran_at, endedAt: null }))),
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

  /** The last "held — awaiting result" line logged, so a hold logs once (#890). */
  private _heldLogged: string | null = null;

  /**
   * Close a run that stopped on an unknown paid outcome (#890): `partial`,
   * never a failure — no failure count, no auto-pause, a `once` goal stays
   * active. The next fire resumes the held plan on the goal's cadence.
   */
  private finishGoalAwaitingResult(
    goal: { goal_id: string; prompt: string; mode: string; budget_tokens?: number | null },
    reason: string,
    now: number,
  ): void {
    const goalStore = this.deps.getStorage()?.goalStore;
    if (!goalStore) return;
    const note = `awaiting result — ${reason}`;
    const run = this.takeRun(now);
    try {
      goalStore.insertOutcome({
        outcome_id: run.id,
        goal_id: goal.goal_id,
        motebit_id: this.deps.getMotebitId(),
        ran_at: run.startedAt,
        status: "partial",
        summary: note.slice(0, 500),
        tool_calls_made: 0,
        memories_formed: 0,
        error_message: null,
        tokens_used: null,
        response_full: null,
        signed_manifest: null,
        sensitivity: this.outcomeStamp(),
      });
      goalStore.updateLastRun(goal.goal_id, now);
    } catch {
      /* non-fatal */
    }
    this._goalCompleteCallback?.({
      goalId: goal.goal_id,
      prompt: goal.prompt,
      status: "awaiting_result",
      summary: note,
      error: null,
    });
  }

  private finishGoalFailure(
    goal: { goal_id: string; prompt: string; mode: string; budget_tokens?: number | null },
    error: string,
    now: number,
  ): void {
    const goalStore = this.deps.getStorage()?.goalStore;
    if (!goalStore) return;
    const motebitId = this.deps.getMotebitId();
    const run = this.takeRun(now);

    try {
      goalStore.insertOutcome({
        outcome_id: run.id,
        goal_id: goal.goal_id,
        motebit_id: motebitId,
        ran_at: run.startedAt,
        status: "failed",
        summary: null,
        tool_calls_made: 0,
        memories_formed: 0,
        error_message: error,
        tokens_used: null,
        // Clear-on-error semantic. The runner's latest-outcome
        // surfacing means a failed fire that follows a successful one
        // must NOT inherit the prior artifact bytes; an absent
        // response_full alongside an absent summary is the honest
        // signal. Matches `packages/panels/src/goals/runner.ts`'s
        // symmetric clear of `last_response_full` + `last_response_preview`.
        response_full: null,
        // Symmetric clear for the signed-manifest indicator — the
        // receipt's "signed" chip must not outlive the artifact it
        // attested. `signed_manifest IS NULL` here makes the SQL
        // projection's `last_manifest_signed` resolve to NULL on the
        // card, hiding the indicator cleanly.
        signed_manifest: null,
        sensitivity: this.outcomeStamp(),
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
