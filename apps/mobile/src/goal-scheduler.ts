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
            await this.finishGoalSuccess(
              goal,
              result.summary,
              now,
              result.tokensUsed,
              result.responseFull,
            );
          } else {
            // Fallback: single-turn streaming
            const result = await this.executeSingleTurnGoal(goal, outcomes, now);
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
    goal: { goal_id: string; prompt: string; mode: string; budget_tokens?: number | null },
    outcomes: Array<{
      ran_at: number;
      status: string;
      summary: string | null;
      error_message: string | null;
    }>,
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
    goal: { goal_id: string; prompt: string; mode: string; budget_tokens?: number | null },
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
    goal: { goal_id: string; prompt: string; mode: string; budget_tokens?: number | null },
    outcomes: Array<{
      ran_at: number;
      status: string;
      summary: string | null;
      error_message: string | null;
    }>,
    now: number,
  ): Promise<{
    suspended: boolean;
    summary: string;
    responseFull: string;
    tokensUsed: number | null;
  }> {
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
    let tokensUsed: number | null = null;
    for await (const chunk of runtime.sendMessageStreaming(context)) {
      if (chunk.type === "text") {
        accumulated += chunk.text;
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
          summary: accumulated.slice(0, 500),
          responseFull: accumulated,
          tokensUsed,
        };
      }
    }

    return {
      suspended: false,
      summary: accumulated.slice(0, 500),
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
    const outcomeId = crypto.randomUUID();
    const signedManifestJson =
      responseFull != null
        ? await this.signArtifactManifestJson(responseFull, goal.goal_id, outcomeId)
        : null;

    goalStore.insertOutcome({
      outcome_id: outcomeId,
      goal_id: goal.goal_id,
      motebit_id: motebitId,
      ran_at: now,
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

  private finishGoalFailure(
    goal: { goal_id: string; prompt: string; mode: string; budget_tokens?: number | null },
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
