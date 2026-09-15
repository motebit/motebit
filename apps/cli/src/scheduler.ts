import { createHash } from "node:crypto";
import type { MotebitRuntime, StreamChunk } from "@motebit/runtime";
import type {
  SqliteGoalStore,
  SqliteApprovalStore,
  SqliteGoalOutcomeStore,
  SqliteGoalRunStore,
  Goal,
  GoalOutcome,
  GoalRun,
  UncertainAction,
} from "@motebit/persistence";
import { EventType, RiskLevel, PlanStatus, SensitivityLevel } from "@motebit/sdk";
import type { ToolHandler, AuditLogSink } from "@motebit/sdk";
import { findUnresolvedActions, countCompletedActions } from "@motebit/policy";
import {
  createSubGoalDefinition,
  completeGoalDefinition,
  reportProgressDefinition,
} from "@motebit/tools";
import type { PlanEngine, PlanChunk } from "@motebit/planner";
import type { PlanStoreAdapter } from "@motebit/planner";
import { embedText } from "@motebit/memory-graph";
import { parseInterval } from "./intervals.js";
import { writeLine, writeOutput } from "./terminal.js";
import { dim, warn as warnColor, error as errorColor } from "./colors.js";

// Background goal/plan ticks print while the user may be mid-keystroke at
// the prompt — every line goes through the renderer so it lands above the
// input row instead of corrupting it (#456). Same writeOutput discipline
// the streaming path already followed.
const logLine = (msg: string): void => writeLine(dim(msg));
const warnLine = (msg: string): void => writeLine(warnColor(msg));
const errorLine = (msg: string): void => writeLine(errorColor(msg));

interface SuspendedTurn {
  approvalId: string;
  goalId: string;
  /** The persisted goal run this turn belongs to (goal_runs.run_id). */
  runId: string;
  createdAt: number;
  /** The runtime gate's tool_call_id for the approval this turn suspended on.
   *  Resume/deny is BOUND to it (#462): the scheduler may only resolve the
   *  pending approval it owns, never whatever happens to be pending — in
   *  daemon-coordinated setups "whatever is pending" can be a HUMAN's money
   *  prompt from an attached surface. */
  toolCallId: string;
}

export interface GoalStreamResult {
  suspended: boolean;
  toolCallsMade: number;
  memoriesFormed: number;
  responseText: string;
}

/** Maximum tool calls across all turns in a single goal run (default 50). */
const MAX_TOOL_CALLS_PER_RUN = 50;

export class GoalScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  private suspended = new Map<string, SuspendedTurn>();
  private currentGoalId: string | null = null;
  private planEngine: PlanEngine | null = null;
  private planStore: PlanStoreAdapter | null = null;
  private tickCount = 0;

  /** Runs already logged as held this process — log the hold once, not every tick. */
  private heldLogged = new Set<string>();

  constructor(
    private runtime: MotebitRuntime,
    private goalStore: SqliteGoalStore,
    private approvalStore: SqliteApprovalStore,
    private goalOutcomeStore: SqliteGoalOutcomeStore,
    /**
     * Durable execution ledger — every run is a persisted row from before
     * its first model call, so a process death leaves a record, and the
     * next start recovers instead of re-firing (see `recoverInterruptedRuns`).
     */
    private runStore: SqliteGoalRunStore,
    /**
     * The tool audit log the policy gate writes decision rows into BEFORE
     * execution and completion rows into after. Restart recovery reads it
     * by run id to tell "did anything external happen" — and holds the
     * goal when the answer is yes or unknown.
     */
    private auditSink: AuditLogSink,
    private motebitId: string,
    private denyAbove: RiskLevel,
    private defaultTtlMs = 3_600_000, // 1 hour
    private goalWallClockMs = 10 * 60 * 1000, // configurable default wall-clock per goal run
  ) {}

  /** Attach a PlanEngine for multi-step goal execution. */
  setPlanEngine(engine: PlanEngine, store: PlanStoreAdapter): void {
    this.planEngine = engine;
    this.planStore = store;
  }

  private static readonly MAINTENANCE_PREFIX = "[system:memory_maintenance]";

  start(tickMs = 60_000): void {
    if (this.timer) return;
    // Wire the terminal-state guard on the shared goals primitive — spec
    // goal-lifecycle-v1 §3.4 requires post-terminal emission to be
    // suppressed. The resolver reads from our SQLite goal store.
    this.runtime.setGoalStatusResolver((goalId) => {
      const g = this.goalStore.get(goalId);
      return g == null ? null : g.status;
    });
    this.recoverInterruptedRuns();
    this.ensureMaintenanceGoal();
    this.timer = setInterval(() => {
      void this.tick();
    }, tickMs);
    // Run immediately on start
    void this.tick();
  }

  /**
   * Ensure a system memory-maintenance goal exists. Idempotent — checks
   * for existing goal by prompt prefix before creating.
   */
  private ensureMaintenanceGoal(): void {
    const goals = this.goalStore.list(this.motebitId);
    const existing = goals.find((g) => g.prompt.startsWith(GoalScheduler.MAINTENANCE_PREFIX));
    if (existing) return;

    this.goalStore.add({
      goal_id: crypto.randomUUID(),
      motebit_id: this.motebitId,
      prompt: `${GoalScheduler.MAINTENANCE_PREFIX} Review fading memories and ask the user to confirm or update them.`,
      interval_ms: 24 * 60 * 60 * 1000, // 24 hours
      last_run_at: null,
      enabled: true,
      created_at: Date.now(),
      mode: "recurring",
      status: "active",
      parent_goal_id: null,
      max_retries: 3,
      consecutive_failures: 0,
      wall_clock_ms: 5 * 60 * 1000, // 5 min wall-clock
      project_id: null,
    });
    logLine("[scheduler] created system memory maintenance goal (24h interval)");
  }

  /**
   * Restart recovery. Runs the previous process died inside are still
   * `running` in the ledger; each becomes `interrupted` with the honest
   * facts read from the tool audit log:
   *
   *   - completed_actions — allowed tool calls that DID record a completion
   *     (re-running the goal would repeat them);
   *   - uncertain_actions — allowed tool calls with a decision row but no
   *     completion row: the process died between dispatch and recording.
   *     The intent row proves preparation, never that the call happened.
   *
   * Any side effect, known or unknown, HOLDS the goal until a human runs
   * `motebit runs ack <run_id>`. A run with no allowed tool calls at all
   * resolves itself — re-running it repeats nothing. Pending approvals are
   * left pending (they were a human's decision to make, and still are);
   * `awaiting_approval` runs are drained by `drainRecoveredApprovals` once
   * the human decides.
   */
  recoverInterruptedRuns(): void {
    const stale = this.runStore.listByStatus(this.motebitId, "running");
    for (const run of stale) {
      const facts = this.classifyInterruptedRun(run);
      this.runStore.markInterrupted(run.run_id, facts);
      const held = facts.completed_actions > 0 || facts.uncertain_actions.length > 0;
      this.goalOutcomeStore.add({
        outcome_id: run.run_id,
        goal_id: run.goal_id,
        motebit_id: this.motebitId,
        ran_at: Date.now(),
        status: "failed",
        summary: null,
        tool_calls_made: facts.completed_actions + facts.uncertain_actions.length,
        memories_formed: 0,
        error_message: `interrupted: ${facts.note}`,
      });
      void this.runtime.goals.executed({
        goal_id: run.goal_id,
        error: `interrupted: ${facts.note}`,
      });
      if (held) {
        warnLine(
          `[scheduler] run ${run.run_id.slice(0, 8)} of goal ${run.goal_id.slice(0, 8)} was interrupted with ${facts.note} — goal HELD until \`motebit runs ack ${run.run_id.slice(0, 8)}\``,
        );
      } else {
        logLine(
          `[scheduler] run ${run.run_id.slice(0, 8)} was interrupted before any external action — will re-fire on schedule`,
        );
      }
    }
  }

  private classifyInterruptedRun(run: GoalRun): {
    completed_actions: number;
    uncertain_actions: UncertainAction[];
    note: string;
  } {
    if (typeof this.auditSink.queryByRunId !== "function") {
      // The sink cannot answer by run — side effects are UNKNOWN, which is
      // the held case, not the safe case. A sentinel uncertain action keeps
      // the hold honest in content: "something may have happened".
      return {
        completed_actions: 0,
        uncertain_actions: [{ call_id: "unknown", tool: "unknown", intended_at: run.started_at }],
        note: "audit log cannot be queried by run — side effects unknown",
      };
    }
    const entries = this.auditSink.queryByRunId(run.run_id);
    const uncertain = findUnresolvedActions(entries).map((e) => ({
      call_id: e.callId,
      tool: e.tool,
      intended_at: e.timestamp,
    }));
    const completed = countCompletedActions(entries);
    const note =
      completed === 0 && uncertain.length === 0
        ? "no external actions recorded"
        : `${completed} completed action(s), ${uncertain.length} with unknown outcome`;
    return { completed_actions: completed, uncertain_actions: uncertain, note };
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // On shutdown the pending approvals STAY pending and their runs stay
    // `awaiting_approval` in the ledger — a human's decision survives the
    // process. Only the in-memory resume handles are dropped; after a
    // restart the decision is applied by `drainRecoveredApprovals`.
    this.suspended.clear();
    // Best-effort memory consolidation on shutdown
    void this.runtime.consolidationCycle();
  }

  /** Run a single scheduler tick. Exposed for deterministic testing. */
  async tickOnce(): Promise<void> {
    return this.tick();
  }

  /** Register goal tools on the runtime's tool registry. Idempotent. */
  registerGoalTools(): void {
    const registry = this.runtime.getToolRegistry();

    const createSubGoalHandler: ToolHandler = (args) => {
      if (this.currentGoalId == null || this.currentGoalId === "") {
        return Promise.resolve({
          ok: false,
          error: "No active goal context — this tool can only be used during goal execution.",
        });
      }
      const prompt = args.prompt as string;
      if (prompt == null || prompt === "")
        return Promise.resolve({ ok: false, error: "Missing required parameter: prompt" });

      const intervalStr = (args.interval as string) ?? "1h";
      let intervalMs: number;
      try {
        intervalMs = parseInterval(intervalStr);
      } catch {
        return Promise.resolve({ ok: false, error: `Invalid interval: ${intervalStr}` });
      }

      const once = (args.once as boolean) ?? false;
      const goalId = crypto.randomUUID();

      const wallClockMs = typeof args.wall_clock_ms === "number" ? args.wall_clock_ms : null;
      const projectId =
        typeof args.project_id === "string" && args.project_id !== "" ? args.project_id : null;

      this.goalStore.add({
        goal_id: goalId,
        motebit_id: this.motebitId,
        prompt,
        interval_ms: intervalMs,
        last_run_at: null,
        enabled: true,
        created_at: Date.now(),
        mode: once ? "once" : "recurring",
        status: "active",
        parent_goal_id: this.currentGoalId,
        max_retries: 3,
        consecutive_failures: 0,
        wall_clock_ms: wallClockMs,
        project_id: projectId,
      });

      logLine(`[goal] sub-goal created: ${goalId.slice(0, 8)} — "${prompt.slice(0, 40)}"`);
      return Promise.resolve({
        ok: true,
        data: `Sub-goal created: ${goalId.slice(0, 8)} — "${prompt}"`,
      });
    };

    const completeGoalHandler: ToolHandler = async (args) => {
      if (this.currentGoalId == null || this.currentGoalId === "") {
        return {
          ok: false,
          error: "No active goal context — this tool can only be used during goal execution.",
        };
      }
      const reason = args.reason as string;
      if (!reason) return { ok: false, error: "Missing required parameter: reason" };

      const goalIdAtComplete = this.currentGoalId;
      // Emit goal_completed BEFORE flipping status — the terminal-state
      // guard in `runtime.goals` would suppress the event otherwise
      // (spec §3.4 says no emission AFTER terminal).
      await this.runtime.goals.completed({ goal_id: goalIdAtComplete, reason });
      this.goalStore.setStatus(goalIdAtComplete, "completed");

      logLine(`[goal] completed by agent: ${goalIdAtComplete.slice(0, 8)} — ${reason}`);
      return { ok: true, data: `Goal marked as completed: ${reason}` };
    };

    const reportProgressHandler: ToolHandler = async (args) => {
      if (this.currentGoalId == null || this.currentGoalId === "") {
        return {
          ok: false,
          error: "No active goal context — this tool can only be used during goal execution.",
        };
      }
      const note = args.note as string;
      if (!note) return { ok: false, error: "Missing required parameter: note" };

      // Emit as event log entry, not an outcome row.
      // Outcomes are 1-per-run; progress notes are events within a run.
      await this.runtime.goals.progress({ goal_id: this.currentGoalId, note });

      logLine(`[goal] progress: ${note.slice(0, 60)}`);
      return { ok: true, data: `Progress recorded: ${note}` };
    };

    // Register goal tools with full implementations.
    // These are only visible to the model during active goal execution.
    registry.replace(createSubGoalDefinition, createSubGoalHandler);
    registry.replace(completeGoalDefinition, completeGoalHandler);
    registry.replace(reportProgressDefinition, reportProgressHandler);
  }

  private unregisterGoalTools(): void {
    const registry = this.runtime.getToolRegistry();
    registry.unregister?.("create_sub_goal");
    registry.unregister?.("complete_goal");
    registry.unregister?.("report_progress");
  }

  private buildGoalContext(goal: Goal, outcomes: GoalOutcome[], subGoals: Goal[]): string {
    // Memory maintenance goals get special context with curiosity targets
    if (goal.prompt.startsWith(GoalScheduler.MAINTENANCE_PREFIX)) {
      return this.buildMaintenanceContext(outcomes);
    }

    const lines: string[] = [];
    lines.push("You are executing a scheduled goal.");
    // Local time-of-day context — lets the agent reason about whether
    // a deferred action ("email the team lead tomorrow morning") is
    // ripe, or whether cadence-sensitive behavior ("daily digest") is
    // on its expected window. Absent, the agent has to guess from run
    // timestamps alone, which is lossy.
    const now = new Date();
    lines.push(
      `Current local time: ${now.toLocaleString(undefined, { weekday: "long", year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true })}`,
    );
    lines.push("");
    lines.push(`Goal: ${goal.prompt}`);

    if (outcomes.length > 0) {
      lines.push("");
      lines.push("Previous executions (most recent first):");
      for (const o of outcomes) {
        const ago = formatTimeAgo(Date.now() - o.ran_at);
        if (o.status === "failed" && o.error_message != null && o.error_message !== "") {
          lines.push(`- ${ago}: failed — [error: ${o.error_message}]`);
        } else if (o.summary != null && o.summary !== "") {
          lines.push(`- ${ago}: ${o.status} — "${o.summary.slice(0, 100)}"`);
        } else {
          lines.push(`- ${ago}: ${o.status}`);
        }
      }
    }

    if (subGoals.length > 0) {
      lines.push("");
      lines.push("Sub-goals:");
      for (const sg of subGoals) {
        const interval = formatMs(sg.interval_ms);
        lines.push(`- "${sg.prompt.slice(0, 60)}" (${sg.status}, every ${interval})`);
      }
    }

    // Parent context: if this goal has a parent, show the parent's prompt and recent outcomes
    if (goal.parent_goal_id) {
      const parent = this.goalStore.get(goal.parent_goal_id);
      if (parent) {
        lines.push("");
        lines.push(`Parent goal: "${parent.prompt.slice(0, 100)}"`);
        const parentOutcomes = this.goalOutcomeStore.listForGoal(parent.goal_id, 2);
        if (parentOutcomes.length > 0) {
          lines.push("Parent's recent results:");
          for (const po of parentOutcomes) {
            const ago = formatTimeAgo(Date.now() - po.ran_at);
            if (po.summary != null && po.summary !== "") {
              lines.push(`  - ${ago}: ${po.summary.slice(0, 100)}`);
            } else {
              lines.push(`  - ${ago}: ${po.status}`);
            }
          }
        }

        // Sibling context: other active children of the same parent
        const siblings = this.goalStore
          .listChildren(goal.parent_goal_id)
          .filter((sg) => sg.goal_id !== goal.goal_id && sg.status === "active")
          .slice(0, 5);
        if (siblings.length > 0) {
          lines.push("");
          lines.push("Sibling goals (related work under same parent):");
          for (const sib of siblings) {
            const sibOutcomes = this.goalOutcomeStore.listForGoal(sib.goal_id, 1);
            const lastResult = sibOutcomes[0];
            if (lastResult?.summary != null && lastResult.summary !== "") {
              lines.push(`  - "${sib.prompt.slice(0, 60)}": ${lastResult.summary.slice(0, 80)}`);
            } else {
              lines.push(`  - "${sib.prompt.slice(0, 60)}": no results yet`);
            }
          }
        }
      }
    }

    // Project context: other active goals with the same project_id
    if (goal.project_id) {
      const projectGoals = this.goalStore
        .listByProject(goal.project_id, this.motebitId)
        .filter((pg) => pg.goal_id !== goal.goal_id && pg.status === "active")
        .slice(0, 5);
      if (projectGoals.length > 0) {
        lines.push("");
        lines.push(`Project "${goal.project_id}" — related goals:`);
        for (const pg of projectGoals) {
          const pgOutcomes = this.goalOutcomeStore.listForGoal(pg.goal_id, 1);
          const lastResult = pgOutcomes[0];
          if (lastResult?.summary != null && lastResult.summary !== "") {
            lines.push(`  - "${pg.prompt.slice(0, 60)}": ${lastResult.summary.slice(0, 80)}`);
          } else {
            lines.push(`  - "${pg.prompt.slice(0, 60)}": no results yet`);
          }
        }
      }
    }

    if (goal.mode === "once") {
      lines.push("");
      lines.push("This is a one-time goal. Use complete_goal when done.");
    }

    return lines.join("\n");
  }

  private buildMaintenanceContext(outcomes: GoalOutcome[]): string {
    const targets = this.runtime.getCuriosityTargets();
    const lines: string[] = [];
    lines.push("You are running a memory maintenance check.");
    lines.push("");

    if (targets.length === 0) {
      lines.push("All memories are healthy — no fading memories need attention.");
      lines.push("Just note that maintenance ran and no action was needed, then return.");
      return lines.join("\n");
    }

    lines.push("Some things you remember are getting stale. Here's what you're unsure about:");
    lines.push("");

    const DAY = 86_400_000;
    for (const t of targets) {
      const ageDays = Math.round((Date.now() - t.node.created_at) / DAY);
      const lastTouchedDays = Math.round((Date.now() - t.node.last_accessed) / DAY);
      lines.push(`- "${t.node.content}"`);
      lines.push(
        `  (learned ${ageDays}d ago, last came up ${lastTouchedDays}d ago — getting fuzzy)`,
      );
    }

    lines.push("");
    lines.push("Pick 1-2 that seem most worth checking and ask the user naturally.");
    lines.push('Frame it as your own uncertainty — "I remember X, is that still the case?"');
    lines.push("Do NOT mention confidence scores, decay, half-life, or maintenance.");
    lines.push(
      "Do NOT list multiple items — pick the most useful one or two and ask conversationally.",
    );
    lines.push("If the user confirms or corrects, that's all you need. Keep it brief.");

    if (outcomes.length > 0) {
      lines.push("");
      lines.push("Previous check-ins:");
      for (const o of outcomes.slice(0, 3)) {
        const ago = formatTimeAgo(Date.now() - o.ran_at);
        if (o.summary) {
          lines.push(`  - ${ago}: ${o.summary.slice(0, 100)}`);
        }
      }
    }

    return lines.join("\n");
  }

  private async tick(): Promise<void> {
    // Single-flight guard — prevent re-entry if previous tick is still running
    if (this.ticking) return;
    this.ticking = true;

    try {
      // Phase 1: expire stale approvals
      this.expireStaleApprovals();

      // Phase 2: drain resolved approvals — live turns first, then the ones
      // whose paused turn died with a previous process.
      await this.drainResolvedApprovals();
      await this.drainRecoveredApprovals();

      // Phase 3: skip goal scheduling if runtime has a pending approval
      if (this.runtime.hasPendingApproval) return;

      // Phase 4: schedule/run due goals
      const goals = this.goalStore.list(this.motebitId);
      const now = Date.now();

      for (const goal of goals) {
        if (!goal.enabled || goal.status !== "active") continue;

        const elapsed = goal.last_run_at != null ? now - goal.last_run_at : Infinity;
        if (elapsed < goal.interval_ms) continue;

        // Never start a replacement run while an existing run is unresolved:
        // paused on a human, or interrupted with side effects nobody has
        // reviewed. Re-firing would repeat what already happened.
        const blocking = this.runStore.blockingRunForGoal(goal.goal_id);
        if (blocking != null) {
          if (!this.heldLogged.has(blocking.run_id)) {
            this.heldLogged.add(blocking.run_id);
            logLine(
              `[goal] ${goal.goal_id.slice(0, 8)} held — run ${blocking.run_id.slice(0, 8)} is ${blocking.status}${blocking.status === "interrupted" ? ` (ack with \`motebit runs ack ${blocking.run_id.slice(0, 8)}\`)` : ""}`,
            );
          }
          continue;
        }

        logLine(`[goal] executing: "${goal.prompt.slice(0, 60)}"`);

        // Build enriched context
        const outcomes = this.goalOutcomeStore.listForGoal(goal.goal_id, 3);
        const subGoals = this.goalStore.listChildren(goal.goal_id);
        const enrichedPrompt = this.buildGoalContext(goal, outcomes, subGoals);

        this.currentGoalId = goal.goal_id;
        this.registerGoalTools();

        // Generate a stable runId for this goal execution (= outcome_id for audit correlation)
        const runId = crypto.randomUUID();
        // Ledger row BEFORE the first model call: a death from here on
        // leaves a `running` row that restart recovery classifies.
        this.runStore.start({ run_id: runId, goal_id: goal.goal_id, motebit_id: this.motebitId });

        try {
          let result: GoalStreamResult;

          // Wall-clock limit: per-goal override → scheduler default
          const wallClock = goal.wall_clock_ms ?? this.goalWallClockMs;
          const abortController = new AbortController();
          const deadlineTimer = setTimeout(
            () =>
              abortController.abort(
                new Error(
                  `Goal exceeded ${Math.round(wallClock / 60_000)}-minute wall-clock limit`,
                ),
              ),
            wallClock,
          );

          try {
            if (this.planEngine && this.planStore) {
              result = await this.executePlanGoal(goal, outcomes, runId, abortController.signal);
            } else {
              const stream = this.runtime.sendMessageStreaming(enrichedPrompt, runId);
              result = await this.consumeDaemonStream(
                stream,
                goal.goal_id,
                runId,
                abortController.signal,
              );
            }
          } finally {
            clearTimeout(deadlineTimer);
          }

          if (result.suspended) {
            // Turn is suspended waiting for approval — don't update last_run_at,
            // don't run more goals. The next tick will drain the approval.
            this.currentGoalId = null;
            return;
          }

          // Record outcome (runId = outcome_id for audit correlation)
          this.goalOutcomeStore.add({
            outcome_id: runId,
            goal_id: goal.goal_id,
            motebit_id: this.motebitId,
            ran_at: Date.now(),
            status: "completed",
            summary: result.responseText.slice(0, 500) || null,
            tool_calls_made: result.toolCallsMade,
            memories_formed: result.memoriesFormed,
            error_message: null,
          });

          this.runStore.setStatus(runId, "completed");
          this.goalStore.updateLastRun(goal.goal_id, Date.now());
          this.goalStore.resetFailures(goal.goal_id);

          // Emit goal_executed (success variant) — spec §5.2.
          void this.runtime.goals.executed({
            goal_id: goal.goal_id,
            summary: result.responseText.slice(0, 200),
            tool_calls: result.toolCallsMade,
            memories: result.memoriesFormed,
          });

          // Form a memory from the goal outcome so the agent learns from its work
          await this.formGoalOutcomeMemory(goal, result);

          // One-shot goal: check if completed (agent may have called complete_goal,
          // or if it's done and didn't call it, auto-complete). Emit BEFORE
          // setStatus so the terminal-state guard doesn't suppress the event.
          const refreshed = this.goalStore.get(goal.goal_id);
          if (goal.mode === "once" && refreshed && refreshed.status === "active") {
            void this.runtime.goals.completed({
              goal_id: goal.goal_id,
              reason: "one-shot auto-complete",
            });
            this.goalStore.setStatus(goal.goal_id, "completed");
          }

          logLine(`[goal] completed: ${goal.goal_id.slice(0, 8)}`);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          errorLine(`[goal] error for ${goal.goal_id.slice(0, 8)}: ${msg}`);

          // Record failed outcome (runId = outcome_id for audit correlation)
          this.goalOutcomeStore.add({
            outcome_id: runId,
            goal_id: goal.goal_id,
            motebit_id: this.motebitId,
            ran_at: Date.now(),
            status: "failed",
            summary: null,
            tool_calls_made: 0,
            memories_formed: 0,
            error_message: msg,
          });

          this.runStore.setStatus(runId, "failed", { note: msg });

          // Emit goal_executed (failure variant) — spec §5.2. Every run
          // leaves a wire record regardless of outcome; §1's "ledger is
          // the semantic source of truth" demands it.
          void this.runtime.goals.executed({ goal_id: goal.goal_id, error: msg });

          // Increment failures and auto-pause if threshold reached
          this.goalStore.incrementFailures(goal.goal_id);
          const refreshed = this.goalStore.get(goal.goal_id);
          if (refreshed && refreshed.consecutive_failures >= refreshed.max_retries) {
            this.goalStore.setStatus(goal.goal_id, "paused");
            warnLine(
              `[goal] auto-paused ${goal.goal_id.slice(0, 8)} after ${refreshed.consecutive_failures} consecutive failures`,
            );
          }
        } finally {
          this.currentGoalId = null;
          this.unregisterGoalTools();
        }
      }
      // Phase 5: periodic memory consolidation (every 10 ticks ≈ 10 min at default 60s)
      this.tickCount++;
      if (this.tickCount % 10 === 0) {
        void this.runtime.consolidationCycle();
      }
    } catch (err: unknown) {
      errorLine(`[scheduler] tick failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.ticking = false;
    }
  }

  private async consumeDaemonStream(
    stream: AsyncGenerator<StreamChunk>,
    goalId: string,
    runId: string,
    signal?: AbortSignal,
  ): Promise<GoalStreamResult> {
    let toolCallsMade = 0;
    let memoriesFormed = 0;
    let responseText = "";

    for await (const chunk of stream) {
      if (signal?.aborted === true) {
        throw signal.reason instanceof Error ? signal.reason : new Error("Goal aborted");
      }
      switch (chunk.type) {
        case "text":
          writeOutput(chunk.text);
          responseText += chunk.text;
          break;

        case "tool_status":
          if (chunk.status === "calling") {
            writeOutput(`\n  [tool] ${chunk.name}...`);
            toolCallsMade++;
            if (toolCallsMade > MAX_TOOL_CALLS_PER_RUN) {
              throw new Error(`Goal exceeded ${MAX_TOOL_CALLS_PER_RUN} tool calls — run stopped`);
            }
          } else {
            writeOutput(" done\n");
          }
          break;

        case "approval_request": {
          const approvalId = crypto.randomUUID();
          const argsJson = JSON.stringify(chunk.args);
          const argsHash = hashArgs(argsJson);
          const now = Date.now();

          // Persist to SQLite — the FULL args, so a decision made after a
          // restart can execute exactly what was shown, never a guess.
          this.approvalStore.add({
            approval_id: approvalId,
            motebit_id: this.motebitId,
            goal_id: goalId,
            tool_name: chunk.name,
            args_preview: argsJson.slice(0, 500),
            args_hash: argsHash,
            risk_level: chunk.risk_level ?? -1,
            status: "pending",
            created_at: now,
            expires_at: now + this.defaultTtlMs,
            resolved_at: null,
            denied_reason: null,
            args_json: argsJson,
          });
          this.runStore.setStatus(runId, "awaiting_approval", { approval_id: approvalId });

          // Track in-memory (runtime holds the actual suspended state)
          this.suspended.set(approvalId, {
            approvalId,
            goalId,
            runId,
            createdAt: now,
            toolCallId: chunk.tool_call_id,
          });

          logLine(`\n  [approval-pending] ${chunk.name} — approval_id: ${approvalId.slice(0, 8)}`);
          void this.logApprovalEvent(
            EventType.ApprovalRequested,
            goalId,
            approvalId,
            chunk.name,
            chunk.args,
          );

          // Record suspended outcome
          this.goalOutcomeStore.add({
            outcome_id: crypto.randomUUID(),
            goal_id: goalId,
            motebit_id: this.motebitId,
            ran_at: now,
            status: "suspended",
            summary: `Suspended for approval: ${chunk.name}`,
            tool_calls_made: toolCallsMade,
            memories_formed: memoriesFormed,
            error_message: null,
          });

          return { suspended: true, toolCallsMade, memoriesFormed, responseText };
        }

        case "injection_warning":
          warnLine(`\n  [warning] suspicious content in ${chunk.tool_name}`);
          break;

        case "result": {
          const result = chunk.result;
          if (result.memoriesFormed != null) {
            memoriesFormed += result.memoriesFormed.length;
          }
          logLine("\n  [goal turn complete]");
          break;
        }
      }
    }
    return { suspended: false, toolCallsMade, memoriesFormed, responseText };
  }

  private async executePlanGoal(
    goal: Goal,
    outcomes: GoalOutcome[],
    runId?: string,
    signal?: AbortSignal,
  ): Promise<GoalStreamResult> {
    const loopDeps = this.runtime.getLoopDeps();
    if (!loopDeps) throw new Error("AI not initialized — no loop deps available");

    const registry = this.runtime.getToolRegistry();

    // Check for existing active plan (resume interrupted plan)
    let plan = this.planStore!.getPlanForGoal(goal.goal_id);
    let planStream: AsyncGenerator<PlanChunk>;

    if (plan && plan.status === PlanStatus.Active) {
      logLine(`[plan] resuming: ${plan.title} (${plan.plan_id.slice(0, 8)})`);
      planStream = this.planEngine!.resumePlan(plan.plan_id, loopDeps, undefined, runId);
    } else {
      // Retrieve relevant memories to inform plan decomposition
      const relevantMemories = await this.retrieveRelevantMemories(goal.prompt);

      const created = await this.planEngine!.createPlan(
        goal.goal_id,
        this.motebitId,
        {
          goalPrompt: goal.prompt,
          previousOutcomes: outcomes.map((o) =>
            o.status === "failed"
              ? `failed: ${o.error_message ?? "unknown"}`
              : `${o.status}: ${o.summary ?? "no summary"}`,
          ),
          availableTools: registry.list().map((t) => t.name),
          relevantMemories: relevantMemories.length > 0 ? relevantMemories : undefined,
        },
        loopDeps,
      );
      plan = created.plan;
      if (created.truncatedFrom != null) {
        warnLine(
          `[plan] truncated from ${created.truncatedFrom} to ${plan.total_steps} steps (max ${plan.total_steps})`,
        );
      }
      planStream = this.planEngine!.executePlan(plan.plan_id, loopDeps, undefined, runId);
    }

    return this.consumePlanStream(planStream, goal.goal_id, runId, signal);
  }

  private async consumePlanStream(
    stream: AsyncGenerator<PlanChunk>,
    goalId: string,
    runId: string | undefined,
    signal?: AbortSignal,
  ): Promise<GoalStreamResult> {
    let toolCallsMade = 0;
    let memoriesFormed = 0;
    let responseText = "";

    for await (const chunk of stream) {
      if (signal?.aborted === true) {
        throw signal.reason instanceof Error ? signal.reason : new Error("Goal aborted");
      }
      switch (chunk.type) {
        case "plan_created":
          logLine(`[plan] created: "${chunk.plan.title}" (${chunk.steps.length} steps)`);
          break;

        case "plan_truncated":
          warnLine(`[plan] truncated from ${chunk.requestedSteps} to ${chunk.maxSteps} steps`);
          break;

        case "step_started":
          logLine(`[plan] step ${chunk.step.ordinal + 1}: ${chunk.step.description}`);
          break;

        case "step_chunk":
          // Forward inner agentic chunks
          if (chunk.chunk.type === "text") {
            writeOutput(chunk.chunk.text);
            responseText += chunk.chunk.text;
          } else if (chunk.chunk.type === "tool_status") {
            if (chunk.chunk.status === "calling") {
              writeOutput(`\n  [tool] ${chunk.chunk.name}...`);
              toolCallsMade++;
              if (toolCallsMade > MAX_TOOL_CALLS_PER_RUN) {
                throw new Error(`Goal exceeded ${MAX_TOOL_CALLS_PER_RUN} tool calls — run stopped`);
              }
            } else {
              writeOutput(" done\n");
            }
          } else if (chunk.chunk.type === "injection_warning") {
            warnLine(`\n  [warning] suspicious content in ${chunk.chunk.tool_name}`);
          } else if (chunk.chunk.type === "result") {
            if (chunk.chunk.result.memoriesFormed != null) {
              memoriesFormed += chunk.chunk.result.memoriesFormed.length;
            }
          }
          break;

        case "step_completed":
          logLine(`\n  [step ${chunk.step.ordinal + 1} complete]`);
          break;

        case "step_failed":
          errorLine(`\n  [step ${chunk.step.ordinal + 1} failed: ${chunk.error}]`);
          break;

        case "approval_request": {
          // Forward to the standard approval queue
          const approvalId = crypto.randomUUID();
          const innerChunk = chunk.chunk;
          if (innerChunk.type !== "approval_request") break;
          const argsJson = JSON.stringify(innerChunk.args);
          const argsHash = hashArgs(argsJson);
          const now = Date.now();

          this.approvalStore.add({
            approval_id: approvalId,
            motebit_id: this.motebitId,
            goal_id: goalId,
            tool_name: innerChunk.name,
            args_preview: argsJson.slice(0, 500),
            args_hash: argsHash,
            risk_level: innerChunk.risk_level ?? -1,
            status: "pending",
            created_at: now,
            expires_at: now + this.defaultTtlMs,
            resolved_at: null,
            denied_reason: null,
            args_json: argsJson,
          });
          if (runId != null) {
            this.runStore.setStatus(runId, "awaiting_approval", { approval_id: approvalId });
          }

          this.suspended.set(approvalId, {
            approvalId,
            goalId,
            runId: runId ?? approvalId,
            createdAt: now,
            toolCallId: innerChunk.tool_call_id,
          });
          logLine(
            `\n  [approval-pending] ${innerChunk.name} — approval_id: ${approvalId.slice(0, 8)}`,
          );
          void this.logApprovalEvent(
            EventType.ApprovalRequested,
            goalId,
            approvalId,
            innerChunk.name,
            innerChunk.args,
          );

          return { suspended: true, toolCallsMade, memoriesFormed, responseText };
        }

        case "plan_completed":
          logLine(`[plan] completed: ${chunk.plan.title}`);
          break;

        case "plan_failed":
          errorLine(`[plan] failed: ${chunk.reason}`);
          break;

        case "reflection": {
          logLine(`[plan] reflection: ${chunk.result.summary}`);
          const stored = await this.persistReflectionMemories(
            chunk.result.memoryCandidates,
            goalId,
          );
          memoriesFormed += stored;
          void this.logGoalEvent(EventType.ReflectionCompleted, goalId, {
            source: "plan_reflection",
            summary: chunk.result.summary,
            memories_stored: stored,
          });
          break;
        }
      }
    }

    return { suspended: false, toolCallsMade, memoriesFormed, responseText };
  }

  private expireStaleApprovals(): void {
    const now = Date.now();
    const expiredCount = this.approvalStore.expireStale(now);
    if (expiredCount > 0) {
      logLine(`[approvals] expired ${expiredCount} stale approval(s)`);
    }

    // Clean up in-memory map for expired items and release runtime
    for (const [id, turn] of this.suspended) {
      const item = this.approvalStore.get(id);
      if (!item || item.status === "expired") {
        this.suspended.delete(id);
        void this.logApprovalEvent(EventType.ApprovalExpired, turn.goalId, id, "", {});
        // Deny-release the runtime ONLY when the pending approval is the one
        // this suspended turn owns (#462): guarding on bare
        // `hasPendingApproval` would let the scheduler deny a HUMAN's pending
        // money prompt in daemon-coordinated setups. And never silently — the
        // old path discarded the resume stream with zero output.
        const pending = this.runtime.pendingApprovalInfo;
        if (pending != null && pending.toolCallId === turn.toolCallId) {
          logLine(
            `[approval] expired → denying suspended turn ${id.slice(0, 8)} (${pending.toolName}) to release the runtime`,
          );
          const resumeStream = this.runtime.resumeAfterApproval(false);
          void this.consumeAndDiscard(resumeStream);
        } else if (pending != null) {
          logLine(
            `[approval] expired ${id.slice(0, 8)} but the runtime's pending approval belongs to another actor (${pending.toolName}) — leaving it untouched`,
          );
        }
      }
    }
  }

  private async drainResolvedApprovals(): Promise<void> {
    for (const [approvalId, turn] of this.suspended) {
      const item = this.approvalStore.get(approvalId);
      if (!item) continue;
      if (item.status !== "approved" && item.status !== "denied") continue;

      const approved = item.status === "approved";
      logLine(`[approval] draining ${approved ? "approved" : "denied"}: ${approvalId.slice(0, 8)}`);

      // Resume ONLY the approval this suspended turn owns (#462). If the
      // runtime's pending approval is a different one (another actor's — in
      // daemon-coordinated setups possibly a human's live money prompt), the
      // scheduler's suspended turn was already voided; resuming would
      // approve/deny SOMEONE ELSE's decision with the stored verdict.
      const pending = this.runtime.pendingApprovalInfo;
      if (pending != null && pending.toolCallId === turn.toolCallId) {
        this.currentGoalId = turn.goalId;
        const resumeStream = this.runtime.resumeAfterApproval(approved);
        const result = await this.consumeDaemonStream(resumeStream, turn.goalId, turn.runId);
        this.currentGoalId = null;
        if (!result.suspended) {
          // The resumed turn ran to its end (a second pause would have
          // re-marked the run awaiting_approval itself).
          this.runStore.setStatus(turn.runId, "completed", {
            note: approved ? "resumed after approval" : "resumed after denial",
          });
          if (approved) {
            this.goalStore.updateLastRun(turn.goalId, Date.now());
          }
        }
      } else if (pending != null) {
        logLine(
          `[approval] ${approvalId.slice(0, 8)} resolved, but the runtime's pending approval belongs to another actor (${pending.toolName}) — this turn was already voided; not resuming`,
        );
      } else {
        logLine(
          `[approval] ${approvalId.slice(0, 8)} resolved, but its suspended turn is gone (voided or expired) — nothing to resume`,
        );
      }

      this.suspended.delete(approvalId);
      const eventType = approved ? EventType.ApprovalApproved : EventType.ApprovalDenied;
      void this.logApprovalEvent(
        eventType,
        turn.goalId,
        approvalId,
        item.tool_name,
        {},
        item.denied_reason,
      );
    }
  }

  /**
   * Apply human decisions to runs whose paused turn no longer exists (the
   * process that paused them is gone). The paused turn cannot be resumed —
   * its stream died with the process — so the decision is applied to the
   * ONE action the human saw:
   *
   *   approved → execute exactly the persisted call through
   *              `invokeLocalTool` (the same policy gate, `humanApproved`
   *              satisfying the approval band the way a tap does; a hard
   *              deny still denies; R4_MONEY is never executed here — the
   *              recovered path holds no verified grant);
   *   denied   → nothing runs; the run completes with the denial noted.
   *
   * The rest of the goal's turn is NOT re-run. That would re-execute the
   * pre-pause tool calls, which already happened. The goal fires again on
   * its own cadence.
   */
  private async drainRecoveredApprovals(): Promise<void> {
    const waiting = this.runStore.listByStatus(this.motebitId, "awaiting_approval");
    for (const run of waiting) {
      if (run.approval_id == null) continue;
      if (this.suspended.has(run.approval_id)) continue; // live — handled above
      const item = this.approvalStore.get(run.approval_id);
      if (!item) continue;
      if (item.status === "expired") {
        this.finishRecoveredRun(run, {
          ok: false,
          summary: `approval for ${item.tool_name} expired before a decision`,
          countAsFailure: false,
        });
        continue;
      }
      if (item.status !== "approved" && item.status !== "denied") continue;

      const approved = item.status === "approved";
      void this.logApprovalEvent(
        approved ? EventType.ApprovalApproved : EventType.ApprovalDenied,
        run.goal_id,
        item.approval_id,
        item.tool_name,
        {},
        item.denied_reason,
      );

      if (!approved) {
        this.finishRecoveredRun(run, {
          ok: true,
          summary: `${item.tool_name} denied by the human after a restart — action not taken; turn not resumed`,
          countAsFailure: false,
        });
        continue;
      }
      if (item.args_json == null) {
        this.finishRecoveredRun(run, {
          ok: false,
          summary: `${item.tool_name} was approved after a restart but its full arguments were not persisted — not executed`,
          countAsFailure: false,
        });
        continue;
      }
      // `risk_level` is the persisted numeric tier (-1 when unknown).
      const moneyTier: number = RiskLevel.R4_MONEY;
      if (item.risk_level >= moneyTier) {
        this.finishRecoveredRun(run, {
          ok: false,
          summary: `${item.tool_name} is a money action — never executed from a recovered run (no verified grant in reach)`,
          countAsFailure: false,
        });
        continue;
      }

      let args: Record<string, unknown>;
      try {
        args = JSON.parse(item.args_json) as Record<string, unknown>;
      } catch {
        this.finishRecoveredRun(run, {
          ok: false,
          summary: `${item.tool_name} approved after a restart but its persisted arguments are unreadable — not executed`,
          countAsFailure: false,
        });
        continue;
      }
      const argsHash = hashArgs(JSON.stringify(args));
      if (argsHash !== item.args_hash) {
        this.finishRecoveredRun(run, {
          ok: false,
          summary: `${item.tool_name} approved after a restart but the persisted arguments no longer match what was approved — not executed`,
          countAsFailure: false,
        });
        continue;
      }

      logLine(
        `[approval] ${item.approval_id.slice(0, 8)} approved after restart — executing ${item.tool_name} exactly as approved`,
      );
      this.currentGoalId = run.goal_id;
      let result: { ok: boolean; data?: unknown; error?: string };
      try {
        result = await this.runtime.invokeLocalTool(item.tool_name, args, {
          invocationOrigin: "scheduled",
          humanApproved: true,
        });
      } catch (err: unknown) {
        result = { ok: false, error: err instanceof Error ? err.message : String(err) };
      } finally {
        this.currentGoalId = null;
      }
      const shown = result.ok
        ? JSON.stringify(result.data ?? null).slice(0, 500)
        : (result.error ?? "failed");
      this.finishRecoveredRun(run, {
        ok: result.ok,
        summary: result.ok
          ? `${item.tool_name} executed after approval (recovered run): ${shown}`
          : `${item.tool_name} failed after approval (recovered run): ${shown}`,
        countAsFailure: !result.ok,
        toolCallsMade: 1,
      });
    }
  }

  private finishRecoveredRun(
    run: GoalRun,
    verdict: { ok: boolean; summary: string; countAsFailure: boolean; toolCallsMade?: number },
  ): void {
    this.runStore.setStatus(run.run_id, verdict.ok ? "completed" : "failed", {
      note: verdict.summary,
    });
    this.goalOutcomeStore.add({
      outcome_id: crypto.randomUUID(),
      goal_id: run.goal_id,
      motebit_id: this.motebitId,
      ran_at: Date.now(),
      status: verdict.ok ? "completed" : "failed",
      summary: verdict.ok ? verdict.summary : null,
      tool_calls_made: verdict.toolCallsMade ?? 0,
      memories_formed: 0,
      error_message: verdict.ok ? null : verdict.summary,
    });
    // The goal's own cadence resumes from now either way — the human's
    // decision closed this run; it is not silently re-fired.
    this.goalStore.updateLastRun(run.goal_id, Date.now());
    if (verdict.countAsFailure) {
      this.goalStore.incrementFailures(run.goal_id);
    } else if (verdict.ok) {
      this.goalStore.resetFailures(run.goal_id);
    }
    void this.runtime.goals.executed(
      verdict.ok
        ? {
            goal_id: run.goal_id,
            summary: verdict.summary.slice(0, 200),
            tool_calls: verdict.toolCallsMade ?? 0,
            memories: 0,
          }
        : { goal_id: run.goal_id, error: verdict.summary },
    );
    logLine(
      `[goal] recovered run ${run.run_id.slice(0, 8)} → ${verdict.ok ? "completed" : "failed"}`,
    );
  }

  private async consumeAndDiscard(stream: AsyncGenerator<StreamChunk>): Promise<void> {
    // Never let a drain reject escape — callers fire-and-forget (`void ...`),
    // so a throw here (e.g. resumeAfterApproval's single-writer "Already
    // processing" guard, #462, when a human turn is mid-flight on the shared
    // runtime) would be an unhandled rejection. Log and retry next tick.
    try {
      for await (const _chunk of stream) {
        // drain
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      errorLine(`[approval] release drain failed (will retry next tick): ${msg}`);
    }
  }

  /**
   * Persist memory candidates from plan reflection into the memory graph.
   * Returns the number of memories successfully formed.
   */
  private async persistReflectionMemories(candidates: string[], _goalId: string): Promise<number> {
    let stored = 0;
    for (const text of candidates) {
      try {
        const embedding = await embedText(`[goal_learning] ${text}`);
        await this.runtime.memory.formMemory(
          {
            content: `[goal_learning] ${text}`,
            confidence: 0.7,
            sensitivity: SensitivityLevel.None,
            // Plan-reflection learnings are agent-synthesized, not user statements.
            source: "agent_inferred",
          },
          embedding,
        );
        stored++;
      } catch {
        // Memory formation is best-effort
      }
    }
    if (stored > 0) {
      logLine(`[plan] stored ${stored} learning memor${stored === 1 ? "y" : "ies"}`);
    }
    return stored;
  }

  /**
   * Form a memory from a completed goal outcome so the agent learns from its work.
   */
  private async formGoalOutcomeMemory(goal: Goal, result: GoalStreamResult): Promise<void> {
    if (!result.responseText) return;
    try {
      const summary = result.responseText.slice(0, 200);
      const content = `[goal_outcome] Goal "${goal.prompt.slice(0, 60)}" completed: ${summary}`;
      const embedding = await embedText(content);
      await this.runtime.memory.formMemory(
        {
          content,
          confidence: 0.6,
          sensitivity: SensitivityLevel.None,
          // Goal-outcome summaries are agent-synthesized, not user statements.
          source: "agent_inferred",
        },
        embedding,
      );
    } catch {
      // Memory formation is best-effort
    }
  }

  /**
   * Retrieve memories relevant to a goal prompt for informing plan decomposition.
   */
  private async retrieveRelevantMemories(goalPrompt: string): Promise<string[]> {
    try {
      const goalEmbedding = await embedText(goalPrompt);
      const nodes = await this.runtime.memory.recallRelevant(goalEmbedding, { limit: 5 });
      return nodes.map((n) => n.content);
    } catch {
      return [];
    }
  }

  private async logApprovalEvent(
    eventType: EventType,
    goalId: string,
    approvalId: string,
    toolName: string,
    args: Record<string, unknown>,
    deniedReason?: string | null,
  ): Promise<void> {
    try {
      const clock = await this.runtime.events.getLatestClock(this.motebitId);
      await this.runtime.events.append({
        event_id: crypto.randomUUID(),
        motebit_id: this.motebitId,
        timestamp: Date.now(),
        event_type: eventType,
        payload: {
          goal_id: goalId,
          approval_id: approvalId,
          tool: toolName,
          args_preview: JSON.stringify(args).slice(0, 200),
          deny_above: RiskLevel[this.denyAbove],
          ...(deniedReason != null && deniedReason !== "" ? { denied_reason: deniedReason } : {}),
        },
        version_clock: clock + 1,
        tombstoned: false,
      });
    } catch {
      // Best-effort event logging
    }
  }

  private async logGoalEvent(
    eventType: EventType,
    goalId: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    try {
      const clock = await this.runtime.events.getLatestClock(this.motebitId);
      await this.runtime.events.append({
        event_id: crypto.randomUUID(),
        motebit_id: this.motebitId,
        timestamp: Date.now(),
        event_type: eventType,
        payload: { goal_id: goalId, ...payload },
        version_clock: clock + 1,
        tombstoned: false,
      });
    } catch {
      // Best-effort event logging
    }
  }
}

function hashArgs(argsJson: string): string {
  return createHash("sha256").update(argsJson).digest("hex");
}

function formatTimeAgo(ms: number): string {
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
  return `${Math.round(ms / 86_400_000)}d ago`;
}

function formatMs(ms: number): string {
  if (ms >= 86_400_000) return `${ms / 86_400_000}d`;
  if (ms >= 3_600_000) return `${ms / 3_600_000}h`;
  return `${ms / 60_000}m`;
}
