import { createHash } from "node:crypto";
import type { MotebitRuntime, StreamChunk } from "@motebit/runtime";
import type { SqliteGoalStore, SqliteApprovalStore, SqliteGoalOutcomeStore, Goal, GoalOutcome } from "@motebit/persistence";
import { EventType, RiskLevel, PlanStatus } from "@motebit/sdk";
import type { ToolHandler } from "@motebit/sdk";
import {
  createSubGoalDefinition,
  completeGoalDefinition,
  reportProgressDefinition,
} from "@motebit/tools";
import type { PlanEngine, PlanChunk } from "@motebit/planner";
import type { PlanStoreAdapter } from "@motebit/planner";
import { parseInterval } from "./intervals.js";

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

  constructor(
    private runtime: MotebitRuntime,
    private goalStore: SqliteGoalStore,
    private approvalStore: SqliteApprovalStore,
    private goalOutcomeStore: SqliteGoalOutcomeStore,
    private motebitId: string,
    private denyAbove: RiskLevel,
    private defaultTtlMs = 3_600_000, // 1 hour
  ) {}

  /** Attach a PlanEngine for multi-step goal execution. */
  setPlanEngine(engine: PlanEngine, store: PlanStoreAdapter): void {
    this.planEngine = engine;
    this.planStore = store;
  }

  start(tickMs = 60_000): void {
    if (this.timer) return;
    this.cleanupOrphanedApprovals();
    this.registerGoalTools();
    this.timer = setInterval(() => {
      void this.tick();
    }, tickMs);
    // Run immediately on start
    void this.tick();
  }

  /** Deny any pending approvals left over from a previous daemon run. */
  private cleanupOrphanedApprovals(): void {
    const orphans = this.approvalStore.listPending(this.motebitId);
    for (const a of orphans) {
      this.approvalStore.resolve(a.approval_id, "denied", "daemon_restart");
    }
    if (orphans.length > 0) {
      console.log(`[scheduler] cleaned up ${orphans.length} orphaned approval(s) from previous run`);
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
  }

  /** Run a single scheduler tick. Exposed for deterministic testing. */
  async tickOnce(): Promise<void> {
    return this.tick();
  }

  /** Register goal tools on the runtime's tool registry. Idempotent. */
  registerGoalTools(): void {
    const registry = this.runtime.getToolRegistry();

    const createSubGoalHandler: ToolHandler = async (args) => {
      if (!this.currentGoalId) {
        return { ok: false, error: "No active goal context — this tool can only be used during goal execution." };
      }
      const prompt = args.prompt as string;
      if (!prompt) return { ok: false, error: "Missing required parameter: prompt" };

      const intervalStr = (args.interval as string) ?? "1h";
      let intervalMs: number;
      try {
        intervalMs = parseInterval(intervalStr);
      } catch {
        return { ok: false, error: `Invalid interval: ${intervalStr}` };
      }

      const once = (args.once as boolean) ?? false;
      const goalId = crypto.randomUUID();

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
      });

      console.log(`[goal] sub-goal created: ${goalId.slice(0, 8)} — "${prompt.slice(0, 40)}"`);
      return { ok: true, data: `Sub-goal created: ${goalId.slice(0, 8)} — "${prompt}"` };
    };

    const completeGoalHandler: ToolHandler = async (args) => {
      if (!this.currentGoalId) {
        return { ok: false, error: "No active goal context — this tool can only be used during goal execution." };
      }
      const reason = args.reason as string;
      if (!reason) return { ok: false, error: "Missing required parameter: reason" };

      this.goalStore.setStatus(this.currentGoalId, "completed");

      // Log GoalCompleted event
      try {
        const clock = await this.runtime.events.getLatestClock(this.motebitId);
        await this.runtime.events.append({
          event_id: crypto.randomUUID(),
          motebit_id: this.motebitId,
          timestamp: Date.now(),
          event_type: EventType.GoalCompleted,
          payload: { goal_id: this.currentGoalId, reason },
          version_clock: clock + 1,
          tombstoned: false,
        });
      } catch {
        // Best-effort
      }

      console.log(`[goal] completed by agent: ${this.currentGoalId.slice(0, 8)} — ${reason}`);
      return { ok: true, data: `Goal marked as completed: ${reason}` };
    };

    const reportProgressHandler: ToolHandler = async (args) => {
      if (!this.currentGoalId) {
        return { ok: false, error: "No active goal context — this tool can only be used during goal execution." };
      }
      const note = args.note as string;
      if (!note) return { ok: false, error: "Missing required parameter: note" };

      // Emit as event log entry, not an outcome row.
      // Outcomes are 1-per-run; progress notes are events within a run.
      try {
        const clock = await this.runtime.events.getLatestClock(this.motebitId);
        await this.runtime.events.append({
          event_id: crypto.randomUUID(),
          motebit_id: this.motebitId,
          timestamp: Date.now(),
          event_type: EventType.GoalProgress,
          payload: { goal_id: this.currentGoalId, note },
          version_clock: clock + 1,
          tombstoned: false,
        });
      } catch {
        // Best-effort
      }

      console.log(`[goal] progress: ${note.slice(0, 60)}`);
      return { ok: true, data: `Progress recorded: ${note}` };
    };

    registry.register(createSubGoalDefinition, createSubGoalHandler);
    registry.register(completeGoalDefinition, completeGoalHandler);
    registry.register(reportProgressDefinition, reportProgressHandler);
  }

  private buildGoalContext(goal: Goal, outcomes: GoalOutcome[], subGoals: Goal[]): string {
    const lines: string[] = [];
    lines.push("You are executing a scheduled goal.");
    lines.push("");
    lines.push(`Goal: ${goal.prompt}`);

    if (outcomes.length > 0) {
      lines.push("");
      lines.push("Previous executions (most recent first):");
      for (const o of outcomes) {
        const ago = formatTimeAgo(Date.now() - o.ran_at);
        if (o.status === "failed" && o.error_message) {
          lines.push(`- ${ago}: failed — [error: ${o.error_message}]`);
        } else if (o.summary) {
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

    if (goal.mode === "once") {
      lines.push("");
      lines.push("This is a one-time goal. Use complete_goal when done.");
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

        const elapsed = goal.last_run_at ? now - goal.last_run_at : Infinity;
        if (elapsed < goal.interval_ms) continue;

        console.log(`[goal] executing: "${goal.prompt.slice(0, 60)}"`);

        // Build enriched context
        const outcomes = this.goalOutcomeStore.listForGoal(goal.goal_id, 3);
        const subGoals = this.goalStore.listChildren(goal.goal_id);
        const enrichedPrompt = this.buildGoalContext(goal, outcomes, subGoals);

        this.currentGoalId = goal.goal_id;

        // Generate a stable runId for this goal execution (= outcome_id for audit correlation)
        const runId = crypto.randomUUID();

        try {
          let result: GoalStreamResult;

          // Wall-clock limit: 10 minutes per goal run
          const GOAL_WALL_CLOCK_MS = 10 * 60 * 1000;
          const abortController = new AbortController();
          const deadlineTimer = setTimeout(() => abortController.abort(new Error("Goal exceeded 10-minute wall-clock limit")), GOAL_WALL_CLOCK_MS);

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

          // Log GoalExecuted event
          void this.logGoalEvent(EventType.GoalExecuted, goal.goal_id, {
            summary: result.responseText.slice(0, 200),
            tool_calls: result.toolCallsMade,
            memories: result.memoriesFormed,
          });

          // One-shot goal: check if completed (agent may have called complete_goal,
          // or if it's done and didn't call it, auto-complete)
          const refreshed = this.goalStore.get(goal.goal_id);
          if (goal.mode === "once" && refreshed && refreshed.status === "active") {
            this.goalStore.setStatus(goal.goal_id, "completed");
            void this.logGoalEvent(EventType.GoalCompleted, goal.goal_id, { reason: "one-shot auto-complete" });
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

          // Increment failures and auto-pause if threshold reached
          this.goalStore.incrementFailures(goal.goal_id);
          const refreshed = this.goalStore.get(goal.goal_id);
          if (refreshed && refreshed.consecutive_failures >= refreshed.max_retries) {
            this.goalStore.setStatus(goal.goal_id, "paused");
            console.warn(`[goal] auto-paused ${goal.goal_id.slice(0, 8)} after ${refreshed.consecutive_failures} consecutive failures`);
          }
        } finally {
          this.currentGoalId = null;
        }
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
      if (signal?.aborted) {
        throw signal.reason instanceof Error ? signal.reason : new Error("Goal aborted");
      }
      switch (chunk.type) {
        case "text":
          process.stdout.write(chunk.text);
          responseText += chunk.text;
          break;

        case "tool_status":
          if (chunk.status === "calling") {
            process.stdout.write(`\n  [tool] ${chunk.name}...`);
            toolCallsMade++;
            if (toolCallsMade > MAX_TOOL_CALLS_PER_RUN) {
              throw new Error(`Goal exceeded ${MAX_TOOL_CALLS_PER_RUN} tool calls — run stopped`);
            }
          } else {
            process.stdout.write(" done\n");
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

          console.log(`\n  [approval-pending] ${chunk.name} — approval_id: ${approvalId.slice(0, 8)}`);
          void this.logApprovalEvent(EventType.ApprovalRequested, goalId, approvalId, chunk.name, chunk.args);

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
          if (result.memoriesFormed) {
            memoriesFormed += result.memoriesFormed.length;
          }
          console.log("\n  [goal turn complete]");
          break;
        }
      }
    }
    return { suspended: false, toolCallsMade, memoriesFormed, responseText };
  }

  private async executePlanGoal(goal: Goal, outcomes: GoalOutcome[], runId?: string, signal?: AbortSignal): Promise<GoalStreamResult> {
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
      const created = await this.planEngine!.createPlan(goal.goal_id, this.motebitId, {
        goalPrompt: goal.prompt,
        previousOutcomes: outcomes.map((o) =>
          o.status === "failed" ? `failed: ${o.error_message ?? "unknown"}` : `${o.status}: ${o.summary ?? "no summary"}`,
        ),
        availableTools: registry.list().map((t) => t.name),
      }, loopDeps);
      plan = created.plan;
      if (created.truncatedFrom) {
        console.warn(`[plan] truncated from ${created.truncatedFrom} to ${plan.total_steps} steps (max ${plan.total_steps})`);
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
      if (signal?.aborted) {
        throw signal.reason instanceof Error ? signal.reason : new Error("Goal aborted");
      }
      switch (chunk.type) {
        case "plan_created":
          console.log(`[plan] created: "${chunk.plan.title}" (${chunk.steps.length} steps)`);
          void this.logGoalEvent(EventType.PlanCreated, goalId, {
            plan_id: chunk.plan.plan_id,
            title: chunk.plan.title,
            total_steps: chunk.steps.length,
          });
          break;

        case "plan_truncated":
          console.warn(`[plan] truncated from ${chunk.requestedSteps} to ${chunk.maxSteps} steps`);
          break;

        case "step_started":
          console.log(`[plan] step ${chunk.step.ordinal + 1}: ${chunk.step.description}`);
          void this.logGoalEvent(EventType.PlanStepStarted, goalId, {
            plan_id: chunk.step.plan_id,
            step_id: chunk.step.step_id,
            ordinal: chunk.step.ordinal,
            description: chunk.step.description,
          });
          break;

        case "step_chunk":
          // Forward inner agentic chunks
          if (chunk.chunk.type === "text") {
            process.stdout.write(chunk.chunk.text);
            responseText += chunk.chunk.text;
          } else if (chunk.chunk.type === "tool_status") {
            if (chunk.chunk.status === "calling") {
              process.stdout.write(`\n  [tool] ${chunk.chunk.name}...`);
              toolCallsMade++;
              if (toolCallsMade > MAX_TOOL_CALLS_PER_RUN) {
                throw new Error(
                  `Goal exceeded ${MAX_TOOL_CALLS_PER_RUN} tool calls — run stopped`,
                );
              }
            } else {
              process.stdout.write(" done\n");
            }
          } else if (chunk.chunk.type === "injection_warning") {
            console.warn(`\n  [warning] suspicious content in ${chunk.chunk.tool_name}`);
          } else if (chunk.chunk.type === "result") {
            if (chunk.chunk.result.memoriesFormed) {
              memoriesFormed += chunk.chunk.result.memoriesFormed.length;
            }
          }
          break;

        case "step_completed":
          console.log(`\n  [step ${chunk.step.ordinal + 1} complete]`);
          void this.logGoalEvent(EventType.PlanStepCompleted, goalId, {
            plan_id: chunk.step.plan_id,
            step_id: chunk.step.step_id,
            ordinal: chunk.step.ordinal,
            tool_calls_made: chunk.step.tool_calls_made,
          });
          break;

        case "step_failed":
          console.error(`\n  [step ${chunk.step.ordinal + 1} failed: ${chunk.error}]`);
          void this.logGoalEvent(EventType.PlanStepFailed, goalId, {
            plan_id: chunk.step.plan_id,
            step_id: chunk.step.step_id,
            ordinal: chunk.step.ordinal,
            error: chunk.error,
          });
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
          console.log(`\n  [approval-pending] ${innerChunk.name} — approval_id: ${approvalId.slice(0, 8)}`);
          void this.logApprovalEvent(EventType.ApprovalRequested, goalId, approvalId, innerChunk.name, innerChunk.args);

          return { suspended: true, toolCallsMade, memoriesFormed, responseText };
        }

        case "plan_completed":
          console.log(`[plan] completed: ${chunk.plan.title}`);
          void this.logGoalEvent(EventType.PlanCompleted, goalId, {
            plan_id: chunk.plan.plan_id,
          });
          break;

        case "plan_failed":
          console.error(`[plan] failed: ${chunk.reason}`);
          void this.logGoalEvent(EventType.PlanFailed, goalId, {
            plan_id: chunk.plan.plan_id,
            reason: chunk.reason,
          });
          break;
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
      console.log(`[approval] draining ${approved ? "approved" : "denied"}: ${approvalId.slice(0, 8)}`);

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
      void this.logApprovalEvent(eventType, turn.goalId, approvalId, item.tool_name, {}, item.denied_reason);
    }
  }

  private async consumeAndDiscard(stream: AsyncGenerator<StreamChunk>): Promise<void> {
    for await (const _chunk of stream) {
      // drain
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
          ...(deniedReason ? { denied_reason: deniedReason } : {}),
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
