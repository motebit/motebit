import { createHash } from "node:crypto";
import type { MotebitRuntime, StreamChunk } from "@motebit/runtime";
import type {
  SqliteGoalStore,
  SqliteApprovalStore,
  SqliteGoalOutcomeStore,
  Goal,
  GoalOutcome,
} from "@motebit/persistence";
import { EventType, RiskLevel, PlanStatus, SensitivityLevel } from "@motebit/sdk";
import type { ToolHandler } from "@motebit/sdk";
import {
  createSubGoalDefinition,
  completeGoalDefinition,
  reportProgressDefinition,
} from "@motebit/tools";
import type { PlanEngine, PlanChunk } from "@motebit/planner";
import type { PlanStoreAdapter } from "@motebit/planner";
import { embedText } from "@motebit/memory-graph";
import { parseInterval } from "./intervals.js";
import { writeOutput } from "./terminal.js";

interface SuspendedTurn {
  approvalId: string;
  goalId: string;
  createdAt: number;
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

  constructor(
    private runtime: MotebitRuntime,
    private goalStore: SqliteGoalStore,
    private approvalStore: SqliteApprovalStore,
    private goalOutcomeStore: SqliteGoalOutcomeStore,
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
    this.cleanupOrphanedApprovals();
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
    console.log("[scheduler] created system memory maintenance goal (24h interval)");
  }

  /** Deny any pending approvals left over from a previous daemon run. */
  private cleanupOrphanedApprovals(): void {
    const orphans = this.approvalStore.listPending(this.motebitId);
    for (const a of orphans) {
      this.approvalStore.resolve(a.approval_id, "denied", "daemon_restart");
    }
    if (orphans.length > 0) {
      console.log(
        `[scheduler] cleaned up ${orphans.length} orphaned approval(s) from previous run`,
      );
    }
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // On shutdown: expire all pending approvals
    for (const [id] of this.suspended) {
      this.approvalStore.resolve(id, "denied", "daemon_shutdown");
    }
    this.suspended.clear();
    // Best-effort memory housekeeping on shutdown
    void this.runtime.housekeeping();
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

      console.log(`[goal] sub-goal created: ${goalId.slice(0, 8)} — "${prompt.slice(0, 40)}"`);
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

      console.log(`[goal] completed by agent: ${goalIdAtComplete.slice(0, 8)} — ${reason}`);
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

      console.log(`[goal] progress: ${note.slice(0, 60)}`);
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

      // Phase 2: drain resolved approvals
      await this.drainResolvedApprovals();

      // Phase 3: skip goal scheduling if runtime has a pending approval
      if (this.runtime.hasPendingApproval) return;

      // Phase 4: schedule/run due goals
      const goals = this.goalStore.list(this.motebitId);
      const now = Date.now();

      for (const goal of goals) {
        if (!goal.enabled || goal.status !== "active") continue;

        const elapsed = goal.last_run_at != null ? now - goal.last_run_at : Infinity;
        if (elapsed < goal.interval_ms) continue;

        console.log(`[goal] executing: "${goal.prompt.slice(0, 60)}"`);

        // Build enriched context
        const outcomes = this.goalOutcomeStore.listForGoal(goal.goal_id, 3);
        const subGoals = this.goalStore.listChildren(goal.goal_id);
        const enrichedPrompt = this.buildGoalContext(goal, outcomes, subGoals);

        this.currentGoalId = goal.goal_id;
        this.registerGoalTools();

        // Generate a stable runId for this goal execution (= outcome_id for audit correlation)
        const runId = crypto.randomUUID();

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
              result = await this.consumeDaemonStream(stream, goal.goal_id, abortController.signal);
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

          console.log(`[goal] completed: ${goal.goal_id.slice(0, 8)}`);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[goal] error for ${goal.goal_id.slice(0, 8)}: ${msg}`);

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

          // Emit goal_executed (failure variant) — spec §5.2. Every run
          // leaves a wire record regardless of outcome; §1's "ledger is
          // the semantic source of truth" demands it.
          void this.runtime.goals.executed({ goal_id: goal.goal_id, error: msg });

          // Increment failures and auto-pause if threshold reached
          this.goalStore.incrementFailures(goal.goal_id);
          const refreshed = this.goalStore.get(goal.goal_id);
          if (refreshed && refreshed.consecutive_failures >= refreshed.max_retries) {
            this.goalStore.setStatus(goal.goal_id, "paused");
            console.warn(
              `[goal] auto-paused ${goal.goal_id.slice(0, 8)} after ${refreshed.consecutive_failures} consecutive failures`,
            );
          }
        } finally {
          this.currentGoalId = null;
          this.unregisterGoalTools();
        }
      }
      // Phase 5: periodic memory housekeeping (every 10 ticks ≈ 10 min at default 60s)
      this.tickCount++;
      if (this.tickCount % 10 === 0) {
        void this.runtime.housekeeping();
      }
    } catch (err: unknown) {
      console.error("[scheduler] tick failed", err);
    } finally {
      this.ticking = false;
    }
  }

  private async consumeDaemonStream(
    stream: AsyncGenerator<StreamChunk>,
    goalId: string,
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

          // Persist to SQLite
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
          });

          // Track in-memory (runtime holds the actual suspended state)
          this.suspended.set(approvalId, { approvalId, goalId, createdAt: now });

          console.log(
            `\n  [approval-pending] ${chunk.name} — approval_id: ${approvalId.slice(0, 8)}`,
          );
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
          console.warn(`\n  [warning] suspicious content in ${chunk.tool_name}`);
          break;

        case "result": {
          const result = chunk.result;
          if (result.memoriesFormed != null) {
            memoriesFormed += result.memoriesFormed.length;
          }
          console.log("\n  [goal turn complete]");
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
      console.log(`[plan] resuming: ${plan.title} (${plan.plan_id.slice(0, 8)})`);
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
        console.warn(
          `[plan] truncated from ${created.truncatedFrom} to ${plan.total_steps} steps (max ${plan.total_steps})`,
        );
      }
      planStream = this.planEngine!.executePlan(plan.plan_id, loopDeps, undefined, runId);
    }

    return this.consumePlanStream(planStream, goal.goal_id, signal);
  }

  private async consumePlanStream(
    stream: AsyncGenerator<PlanChunk>,
    goalId: string,
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
          console.log(`[plan] created: "${chunk.plan.title}" (${chunk.steps.length} steps)`);
          break;

        case "plan_truncated":
          console.warn(`[plan] truncated from ${chunk.requestedSteps} to ${chunk.maxSteps} steps`);
          break;

        case "step_started":
          console.log(`[plan] step ${chunk.step.ordinal + 1}: ${chunk.step.description}`);
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
            console.warn(`\n  [warning] suspicious content in ${chunk.chunk.tool_name}`);
          } else if (chunk.chunk.type === "result") {
            if (chunk.chunk.result.memoriesFormed != null) {
              memoriesFormed += chunk.chunk.result.memoriesFormed.length;
            }
          }
          break;

        case "step_completed":
          console.log(`\n  [step ${chunk.step.ordinal + 1} complete]`);
          break;

        case "step_failed":
          console.error(`\n  [step ${chunk.step.ordinal + 1} failed: ${chunk.error}]`);
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
          });

          this.suspended.set(approvalId, { approvalId, goalId, createdAt: now });
          console.log(
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
          console.log(`[plan] completed: ${chunk.plan.title}`);
          break;

        case "plan_failed":
          console.error(`[plan] failed: ${chunk.reason}`);
          break;

        case "reflection": {
          console.log(`[plan] reflection: ${chunk.result.summary}`);
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
      console.log(`[approvals] expired ${expiredCount} stale approval(s)`);
    }

    // Clean up in-memory map for expired items and release runtime
    for (const [id, turn] of this.suspended) {
      const item = this.approvalStore.get(id);
      if (!item || item.status === "expired") {
        this.suspended.delete(id);
        void this.logApprovalEvent(EventType.ApprovalExpired, turn.goalId, id, "", {});
        // If runtime is holding this suspended turn, deny to release
        if (this.runtime.hasPendingApproval) {
          const resumeStream = this.runtime.resumeAfterApproval(false);
          void this.consumeAndDiscard(resumeStream);
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
      console.log(
        `[approval] draining ${approved ? "approved" : "denied"}: ${approvalId.slice(0, 8)}`,
      );

      if (this.runtime.hasPendingApproval) {
        this.currentGoalId = turn.goalId;
        const resumeStream = this.runtime.resumeAfterApproval(approved);
        const result = await this.consumeDaemonStream(resumeStream, turn.goalId);
        this.currentGoalId = null;
        if (approved && !result.suspended) {
          this.goalStore.updateLastRun(turn.goalId, Date.now());
        }
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

  private async consumeAndDiscard(stream: AsyncGenerator<StreamChunk>): Promise<void> {
    for await (const _chunk of stream) {
      // drain
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
          },
          embedding,
        );
        stored++;
      } catch {
        // Memory formation is best-effort
      }
    }
    if (stored > 0) {
      console.log(`[plan] stored ${stored} learning memor${stored === 1 ? "y" : "ies"}`);
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
