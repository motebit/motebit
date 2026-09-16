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
import type { HaltRequest } from "@motebit/sdk";
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

/**
 * The abort reason a halt uses, so the goal-run catch can tell a stop
 * the human asked for from a genuine failure. A halt must not spend the
 * goal's retry budget.
 */
class HaltAbort extends Error {
  constructor(readonly haltId: string) {
    super(`halted (${haltId.slice(0, 8)})`);
    this.name = "HaltAbort";
  }
}

/**
 * Rejoin a resumed turn's continuation to what preceded the pause, so an
 * outcome and its signature cover the run rather than its tail.
 */
function withTextBeforePause(turn: SuspendedTurn, result: GoalStreamResult): GoalStreamResult {
  const before = turn.textBeforePause ?? "";
  if (before === "") return result;
  return { ...result, responseText: `${before}${result.responseText}` };
}

interface SuspendedTurn {
  approvalId: string;
  goalId: string;
  /** The persisted goal run this turn belongs to (goal_runs.run_id). */
  runId: string;
  createdAt: number;
  /**
   * What the model had already produced when this turn paused.
   *
   * A resumed turn's stream carries only the CONTINUATION, so an
   * outcome built from it alone covered the fragment after the pause —
   * and the `ContentArtifactManifest` signed over it covered that
   * fragment too, while the return view presented it as the result
   * whole. The same fragment became the summary the next run reads. A
   * signature over part of a thing, presented as the thing, is the
   * failure this arc exists to remove.
   */
  textBeforePause?: string;
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
  /** The run row in flight (fire path or live resume), so a graceful stop can close it. */
  private currentRunId: string | null = null;
  private currentAbort: AbortController | null = null;
  private foreignPendingLogged = false;
  private planEngine: PlanEngine | null = null;
  private planStore: PlanStoreAdapter | null = null;
  private tickCount = 0;

  /** Runs already logged as held this process — log the hold once, not every tick. */
  private heldLogged = new Set<string>();
  /** Un-register the halt stopper on stop(). */
  private unregisterHaltListener: (() => void) | null = null;
  /** Halt ids already logged as blocking this process. */
  private haltLogged = new Set<string>();

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
    // Register the stopper BEFORE recovery or the first tick: a halt
    // already in force when the daemon starts must be honored before any
    // goal fires, not after one slips through.
    this.unregisterHaltListener = this.runtime.onHalt((halt) => this.stopForHalt(halt));
    // Only this process holds the goal store, so only it can turn the
    // 8-char prefix a person reads off `motebit goal list` into a full
    // id. A remote halt names a goal on THIS machine; the calling
    // machine has no way to resolve it.
    this.runtime.setGoalIdResolver((prefix) => {
      const match = this.goalStore
        .list(this.motebitId)
        .find((g) => g.goal_id === prefix || g.goal_id.startsWith(prefix));
      return match?.goal_id ?? null;
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
   *     completion row: the process died somewhere between preparing the call
   *     and recording its outcome. The row proves preparation — not that
   *     dispatch occurred, and not what the effect was.
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
      // Own id, never `run.run_id`: the live paths write their outcome under
      // the run id, and a death between that write and the run-status
      // transition must not let this row REPLACE a genuine outcome.
      this.goalOutcomeStore.add({
        outcome_id: crypto.randomUUID(),
        run_id: run.run_id,
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
          `[scheduler] run ${run.run_id.slice(0, 8)} of goal ${run.goal_id.slice(0, 8)} was interrupted with ${facts.note} — goal HELD until \`motebit runs ack ${run.run_id.slice(0, 8)} --allow-fresh-run\``,
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
    this.unregisterHaltListener?.();
    this.unregisterHaltListener = null;
    // On shutdown the pending approvals STAY pending and their runs stay
    // `awaiting_approval` in the ledger — a human's decision survives the
    // process. Only the in-memory resume handles are dropped; after a
    // restart the decision is applied by `drainRecoveredApprovals`.
    this.suspended.clear();
    // A run in flight at a GRACEFUL stop is closed here, synchronously,
    // because the daemon exits right after this returns and the tick's own
    // catch may never run. Left `running`, the next start would classify it
    // as interrupted and hold the goal behind a human ack for what was an
    // orderly shutdown. It is the process that is alive to say so.
    if (this.currentRunId != null) {
      const runId = this.currentRunId;
      const run = this.runStore.get(runId);
      const goalId = run?.goal_id ?? this.currentGoalId;
      this.currentAbort?.abort(new Error("daemon stopped"));
      this.runStore.setStatus(runId, "failed", { note: "daemon stopped mid-run (graceful)" });
      if (goalId != null) {
        this.goalOutcomeStore.add({
          outcome_id: crypto.randomUUID(),
          run_id: runId,
          goal_id: goalId,
          motebit_id: this.motebitId,
          ran_at: Date.now(),
          status: "failed",
          summary: null,
          tool_calls_made: 0,
          memories_formed: 0,
          error_message: "daemon stopped mid-run (graceful)",
        });
      }
      this.currentRunId = null;
      this.currentAbort = null;
      logLine(
        `[scheduler] stopped mid-run ${runId.slice(0, 8)} — closed as failed, will re-fire on schedule`,
      );
    }
    // Best-effort memory consolidation on shutdown — unless a halt is in
    // force, whose acknowledgement promised that no further consolidation
    // would start. A promise that lapses at shutdown is not a promise.
    //
    // Guarded because this is a SYNCHRONOUS SQLite read and it is the
    // last statement in `stop()`. A busy-database throw would propagate
    // into the daemon's shutdown block and skip everything after it —
    // the socket disconnect, the runtime-host close, the database
    // close, and the private-key erase. Failing toward "halted" costs
    // one best-effort cycle; failing open costs the key still in memory.
    let haltedAtShutdown = true;
    try {
      haltedAtShutdown = this.runtime.haltInForce() != null;
    } catch {
      // Treated as halted: skip the cycle, let shutdown finish.
    }
    if (!haltedAtShutdown) {
      void this.runtime.consolidationCycle();
    }
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
    // Phase 0 runs OUTSIDE the single-flight guard, and that placement is
    // the whole point: a goal run holds `ticking` for its entire duration
    // (up to the wall-clock limit, ten minutes by default), so a halt
    // honored inside the guard could not reach the run it is meant to
    // abort until that run had already finished. A halt must be able to
    // interrupt work in progress, not queue behind it. `honorHalts` is
    // idempotent and reads one row, so running it on every interval
    // costs nothing once the work is stopped.
    // …and inside its OWN try/catch, because it is now outside the one
    // that wraps the tick body. `tick()` is invoked as `void this.tick()`
    // from the interval and the daemon registers no unhandledRejection
    // handler, so a throw here — a busy SQLite write, a malformed row, a
    // rejecting stopper — would kill the daemon rather than log a failed
    // tick. A halt that cannot be honored must not take the process down
    // with it.
    try {
      await this.runtime.honorHalts();
    } catch (err: unknown) {
      errorLine(
        `[halt] honoring failed (will retry next tick): ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Single-flight guard — prevent re-entry if previous tick is still running
    if (this.ticking) return;
    this.ticking = true;

    try {
      const halted = this.runtime.haltInForce();
      if (halted != null) {
        // Keep the approval TTL running. Freezing it would leave a
        // decidable-looking approval on the phone all night and then
        // expire a pile of them the instant the halt lifted.
        this.expireStaleApprovals();
        if (!this.haltLogged.has(halted.halt_id)) {
          this.haltLogged.add(halted.halt_id);
          warnLine(
            `[halt] unattended execution is stopped (${halted.halt_id.slice(0, 8)}, ${halted.origin}${halted.reason != null ? `: ${halted.reason}` : ""}) — \`motebit resume ${halted.halt_id.slice(0, 8)}\` to give the permission back`,
          );
        }
        return;
      }

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

        // A goal-scoped halt stops this goal and nothing else.
        const goalHalt = this.runtime.haltInForce(goal.goal_id);
        if (goalHalt != null) {
          if (!this.haltLogged.has(goalHalt.halt_id)) {
            this.haltLogged.add(goalHalt.halt_id);
            warnLine(
              `[halt] goal ${goal.goal_id.slice(0, 8)} is stopped (${goalHalt.halt_id.slice(0, 8)}) — \`motebit resume ${goalHalt.halt_id.slice(0, 8)}\` to give the permission back`,
            );
          }
          continue;
        }

        // Never start a replacement run while an existing run is unresolved:
        // paused on a human, or interrupted with side effects nobody has
        // reviewed. Re-firing would repeat what already happened.
        const blocking = this.runStore.blockingRunForGoal(goal.goal_id);
        if (blocking != null) {
          if (!this.heldLogged.has(blocking.run_id)) {
            this.heldLogged.add(blocking.run_id);
            logLine(
              `[goal] ${goal.goal_id.slice(0, 8)} held — run ${blocking.run_id.slice(0, 8)} is ${blocking.status}${blocking.status === "interrupted" ? ` (ack with \`motebit runs ack ${blocking.run_id.slice(0, 8)} --allow-fresh-run\`)` : ""}`,
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
          this.currentAbort = abortController;
          this.currentRunId = runId;
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

          // Run-status transition FIRST, then the outcome row: a death in
          // between leaves a completed run with no outcome (honest, no hold)
          // rather than a completed outcome under a `running` row that the
          // next start would reclassify as interrupted.
          this.runStore.setStatus(runId, "completed");
          const full = result.responseText;
          await this.recordCompletedOutcome(goal.goal_id, runId, result);
          this.goalStore.updateLastRun(goal.goal_id, Date.now());
          this.goalStore.resetFailures(goal.goal_id);

          // Emit goal_executed (success variant) — spec §5.2.
          void this.runtime.goals.executed({
            goal_id: goal.goal_id,
            summary: full.slice(0, 200),
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
          // A stop the human asked for is not a failure of the goal.
          // Counting it would burn the retry budget and eventually
          // auto-pause the goal, so lifting the halt would silently not
          // be enough to start it again.
          if (err instanceof HaltAbort) {
            const note = `halted (${err.haltId.slice(0, 8)})`;
            this.runStore.setStatus(runId, "failed", { note });
            // Every run leaves a wire record regardless of outcome — the
            // ledger is the semantic source of truth, and a run that was
            // stopped is still a run that happened. Only the FAILURE
            // COUNT is skipped: a stop the human asked for must not burn
            // the goal's retry budget.
            this.goalOutcomeStore.add({
              outcome_id: runId,
              goal_id: goal.goal_id,
              motebit_id: this.motebitId,
              ran_at: Date.now(),
              status: "partial",
              summary: `stopped by ${note}`,
              tool_calls_made: 0,
              memories_formed: 0,
              error_message: null,
            });
            void this.runtime.goals.executed({
              goal_id: goal.goal_id,
              error: `stopped by ${note}`,
            });
            logLine(
              `[goal] ${goal.goal_id.slice(0, 8)} stopped by halt ${err.haltId.slice(0, 8)} — not counted as a failure`,
            );
            continue;
          }
          errorLine(`[goal] error for ${goal.goal_id.slice(0, 8)}: ${msg}`);

          this.runStore.setStatus(runId, "failed", { note: msg });
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
            warnLine(
              `[goal] auto-paused ${goal.goal_id.slice(0, 8)} after ${refreshed.consecutive_failures} consecutive failures`,
            );
          }
        } finally {
          this.currentGoalId = null;
          this.currentRunId = null;
          this.currentAbort = null;
          this.unregisterGoalTools();
        }
      }
      // Phase 5: periodic memory consolidation (every 10 ticks ≈ 10 min at default 60s)
      this.tickCount++;
      if (this.tickCount % 10 === 0 && this.runtime.haltInForce() == null) {
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
            ...(responseText !== "" ? { textBeforePause: responseText } : {}),
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
            ...(runId != null ? { run_id: runId } : {}),
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
        // Before anything is dropped. Resuming with a denial is a MODEL
        // TURN whose continuation can make further, non-approval-gated
        // tool calls — unattended work starting, which a halt forbids.
        // Placed after the delete (as it first was), this "leave it
        // suspended" guard did the opposite: the map entry was already
        // gone, the run never closed, and the runtime stayed wedged on a
        // pending approval nothing could resolve once the halt lifted.
        if (this.runtime.haltInForce(turn.goalId) != null) continue;
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
          // The denied continuation runs under this run id: mark it live so
          // the recovered-approval drain leaves it alone, and close it when
          // the continuation ends.
          this.runStore.setStatus(turn.runId, "running", {
            note: "approval expired; continuing after denial",
          });
          // Consumed, not discarded: this is a THIRD path that reaches
          // `completed`, and it wrote no outcome row at all — so a run
          // that produced work after an approval lapsed reported "the
          // run did not reach an outcome row", with nothing signed. The
          // drift gate stayed green because it matches the signing call
          // once per file, which is the aperture blindness this whole
          // increment set out to correct, found for the second time
          // inside the increment itself.
          const resumeStream = this.runtime.resumeAfterApproval(false);
          const expiredGoalId = turn.goalId;
          const expiredRunId = turn.runId;
          // The goal tools fail closed on a null `currentGoalId`, so
          // without these a continuation that calls `complete_goal` or
          // `progress` silently refuses — while this path nonetheless
          // records the run as having reached an outcome. The sibling
          // resume path sets both for the same reason.
          this.currentGoalId = expiredGoalId;
          this.currentRunId = expiredRunId;
          void this.consumeDaemonStream(resumeStream, expiredGoalId, expiredRunId)
            .then(async (result) => {
              // `!result.suspended`, like the sibling path. A denied
              // continuation can make ANOTHER approval-gated call, and
              // then the stream returns suspended with a fresh pending
              // approval and the run already re-marked
              // `awaiting_approval`. Closing it here anyway recorded a
              // run as completed while a human decision was still
              // queued against it — it vanished from the list of runs
              // holding their goal, and its outcome said the action did
              // not run while a second one waited.
              if (result.suspended) return;
              this.runStore.setStatus(expiredRunId, "completed", {
                note: "approval expired; the turn continued after the denial",
              });
              // `partial`, never `completed`: the action the human never
              // decided did not run, so this is not the goal's work
              // finished.
              await this.recordCompletedOutcome(
                expiredGoalId,
                expiredRunId,
                withTextBeforePause(turn, result),
                {
                  status: "partial",
                  errorMessage:
                    "the approval expired before it was decided; the action did not run",
                },
              );
            })
            .finally(() => {
              this.currentGoalId = null;
              this.currentRunId = null;
            })
            .catch((err: unknown) => {
              // Every `running` transition needs a failure transition.
              // The drain this replaced never rejected, so the close
              // always ran; consuming for a result can throw (the
              // single-writer guard, a tool-call ceiling), and logging
              // alone left the run `running` with its suspended entry
              // already gone — nothing would ever close it, and the goal
              // stayed blocked until a restart reclassified it as
              // interrupted and asked a human to acknowledge it.
              const msg = err instanceof Error ? err.message : String(err);
              errorLine(`[approval] expired-continuation of ${id.slice(0, 8)} failed: ${msg}`);
              this.runStore.setStatus(expiredRunId, "failed", {
                note: `expired-approval continuation failed: ${msg}`,
              });
              this.goalOutcomeStore.add({
                outcome_id: crypto.randomUUID(),
                run_id: expiredRunId,
                goal_id: expiredGoalId,
                motebit_id: this.motebitId,
                ran_at: Date.now(),
                status: "failed",
                summary: null,
                tool_calls_made: 0,
                memories_formed: 0,
                error_message: `expired-approval continuation failed: ${msg}`,
              });
            });
        } else {
          if (pending != null) {
            logLine(
              `[approval] expired ${id.slice(0, 8)} but the runtime's pending approval belongs to another actor (${pending.toolName}) — leaving it untouched`,
            );
          }
          // The paused turn is gone (voided or timed out in the runtime);
          // nothing will ever resume it. Close its run so it neither holds
          // the goal nor gets picked up by the recovered-approval drain.
          this.closeVoidedRun(
            turn,
            `approval for ${item?.tool_name ?? "a tool"} expired; not executed`,
          );
        }
      }
    }
  }

  private async drainResolvedApprovals(): Promise<void> {
    for (const [approvalId, turn] of this.suspended) {
      // A halt covering this goal outranks the verdict: resuming would
      // execute the approved call. The suspended turn is left in place,
      // so lifting the halt resumes it rather than losing it.
      if (this.runtime.haltInForce(turn.goalId) != null) continue;
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
        this.currentRunId = turn.runId;
        // Leave `awaiting_approval` BEFORE resuming (same reason as the
        // recovered path): a death after the approved call executes must
        // land on a `running` row the next start classifies from the audit
        // log — never on an `approved` approval still "awaiting", which
        // would execute it again.
        this.runStore.setStatus(turn.runId, "running", {
          note: approved ? "resuming after approval" : "resuming after denial",
        });
        try {
          const resumeStream = this.runtime.resumeAfterApproval(approved);
          const result = await this.consumeDaemonStream(resumeStream, turn.goalId, turn.runId);
          if (!result.suspended) {
            // The resumed turn ran to its end (a second pause would have
            // re-marked the run awaiting_approval itself).
            this.runStore.setStatus(turn.runId, "completed", {
              note: approved ? "resumed after approval" : "resumed after denial",
            });
            // Write the outcome, sign it, keep it whole — the same three
            // things the ordinary completion path does.
            //
            // This path wrote NO outcome row at all, so a goal run that
            // paused for a human's yes and then ran to its end produced
            // no result, nothing signed, and `runs show` reporting "the
            // run did not reach an outcome row". The signing gate stayed
            // green because it matches the call once per file: the
            // aperture blindness this increment was written to correct,
            // reproduced one level down inside the fix for it.
            // `approved`, not unconditionally. A refusal is not a
            // completion, and writing one as `completed` — signed, no
            // less — put a denial into `goal_outcomes`, which
            // `buildGoalContext` reads back into the NEXT run's prompt.
            // The agent would have learned that work a human refused was
            // finished work.
            await this.recordCompletedOutcome(
              turn.goalId,
              turn.runId,
              withTextBeforePause(turn, result),
              {
                status: approved ? "completed" : "partial",
                errorMessage: approved ? null : "the approved action was denied by its owner",
              },
            );
            if (approved) {
              this.goalStore.updateLastRun(turn.goalId, Date.now());
            }
          }
        } catch (err: unknown) {
          // Every `running` transition needs a failure transition, or the
          // goal is held behind a row nobody can ack ("running, not
          // interrupted") until the next restart.
          const msg = err instanceof Error ? err.message : String(err);
          errorLine(`[approval] resume of ${approvalId.slice(0, 8)} failed: ${msg}`);
          this.runStore.setStatus(turn.runId, "failed", { note: `resume failed: ${msg}` });
          this.goalOutcomeStore.add({
            // Fresh id, as the recovery writers use, because this runs
            // in a catch: if `recordCompletedOutcome` already wrote a
            // genuine result and a later statement threw, keying this
            // row by the run would REPLACE that result and destroy the
            // signed artifact with it. `run_id` is what makes it
            // findable; the id only has to be unique.
            outcome_id: crypto.randomUUID(),
            run_id: turn.runId,
            goal_id: turn.goalId,
            motebit_id: this.motebitId,
            ran_at: Date.now(),
            status: "failed",
            summary: null,
            tool_calls_made: 0,
            memories_formed: 0,
            error_message: `resume failed: ${msg}`,
          });
          this.goalStore.updateLastRun(turn.goalId, Date.now());
        } finally {
          this.currentGoalId = null;
          this.currentRunId = null;
        }
      } else {
        // Two "nothing to resume" cases. Either way the paused turn no
        // longer exists, so the stored verdict cannot be applied to it —
        // and it must NOT fall through to the recovered-approval drain,
        // which would execute the call out of band, possibly long after the
        // conversation already recorded it as timed out.
        if (pending != null) {
          logLine(
            `[approval] ${approvalId.slice(0, 8)} resolved, but the runtime's pending approval belongs to another actor (${pending.toolName}) — this turn was already voided; not resuming`,
          );
          this.closeVoidedRun(
            turn,
            `${item.tool_name} approval resolved after the paused turn was voided by another actor's approval — not executed`,
          );
        } else {
          logLine(
            `[approval] ${approvalId.slice(0, 8)} resolved, but its suspended turn is gone (voided or expired) — nothing to resume`,
          );
          this.closeVoidedRun(
            turn,
            `${item.tool_name} approval resolved after the paused turn expired in the runtime — not executed; the conversation already recorded the call as failed`,
          );
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
    // A halt outranks an approval. The human granted permission for one
    // action and then withdrew permission to act unattended at all; the
    // later word wins. The approval stays `approved` — nothing is
    // executed, and nothing is thrown away.
    if (this.runtime.haltInForce() != null) return;
    const waiting = this.runStore.listByStatus(this.motebitId, "awaiting_approval");
    for (const run of waiting) {
      // …and a GOAL-scoped halt outranks that goal's approval. Checking
      // only the motebit-wide halt above would execute the one call the
      // narrower halt existed to prevent.
      if (this.runtime.haltInForce(run.goal_id) != null) continue;
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
      // The TTL is a bound on the DECISION, not on the sweep: an approval
      // granted after its expiry (the daemon was down, so no tick expired the
      // row) is a stale decision and is never executed.
      const decidedAt = item.resolved_at ?? Date.now();
      if (decidedAt > item.expires_at) {
        this.finishRecoveredRun(run, {
          ok: false,
          summary: `${item.tool_name} was approved ${formatMsAgo(decidedAt - item.expires_at)} after its approval expired — not executed`,
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
      // Never execute anything while another actor's approval is pending in
      // the shared runtime (a human's live prompt from an attached surface);
      // wait for the next tick instead.
      if (this.runtime.hasPendingApproval) {
        if (!this.foreignPendingLogged) {
          this.foreignPendingLogged = true;
          logLine(
            `[approval] ${item.approval_id.slice(0, 8)} approved, but another approval is pending in the runtime — waiting`,
          );
        }
        continue;
      }
      this.foreignPendingLogged = false;
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
      // Hash the stored bytes, exactly what was persisted at pause time.
      const argsHash = hashArgs(item.args_json);
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
      // Leave `awaiting_approval` BEFORE the call, not after: if the process
      // dies between the tool returning and the outcome landing, the next
      // start must find this run `running` (→ interrupted, classified from
      // the audit row this call writes under run_id) — never still
      // `awaiting_approval` with an `approved` row, which would execute the
      // approval a second time.
      this.runStore.setStatus(run.run_id, "running", {
        note: `executing ${item.tool_name} approved after restart`,
      });
      this.currentGoalId = run.goal_id;
      this.currentRunId = run.run_id;
      // Goal-scoped tools (create_sub_goal / complete_goal / report_progress)
      // are registered per fire and unregistered after; an approved call to
      // one of them must find it registered here too.
      this.registerGoalTools();
      let result: { ok: boolean; data?: unknown; error?: string };
      try {
        result = await this.runtime.invokeLocalTool(item.tool_name, args, {
          invocationOrigin: "scheduled",
          humanApproved: true,
          runId: run.run_id,
        });
      } catch (err: unknown) {
        result = { ok: false, error: err instanceof Error ? err.message : String(err) };
      } finally {
        this.currentGoalId = null;
        this.currentRunId = null;
        this.unregisterGoalTools();
      }
      const shown = result.ok
        ? JSON.stringify(result.data ?? null).slice(0, 500)
        : (result.error ?? "failed");
      this.finishRecoveredRun(run, {
        ok: result.ok,
        summary: result.ok
          ? `${item.tool_name} executed after approval (recovered run); the goal's remaining work was not resumed: ${shown}`
          : `${item.tool_name} failed after approval (recovered run); the goal's remaining work was not resumed: ${shown}`,
        countAsFailure: !result.ok,
        toolCallsMade: 1,
      });
    }
  }

  /**
   * Stop what this scheduler owns, and say what stopping entailed. The
   * runtime calls this from `honorHalts`; the returned text becomes the
   * halt's acknowledgement, which is the only honest record that the
   * motebit actually stopped rather than merely being asked to.
   *
   * A goal-scoped halt aborts the in-flight run only when that run
   * belongs to the halted goal — halting one goal must not kill another
   * goal's work mid-call.
   */
  private stopForHalt(halt: HaltRequest): string {
    const stopped: string[] = [];
    const runId = this.currentRunId;
    if (runId != null) {
      const run = this.runStore.get(runId);
      const coversThisRun = halt.goal_id == null || run?.goal_id === halt.goal_id;
      if (coversThisRun) {
        // Report what was DONE, never what was attempted. `currentRunId`
        // is set by three paths but `currentAbort` by only one (the goal
        // fire) — both approval drains execute with no abort channel at
        // all. Deriving the sentence from the run id claimed a signal
        // was sent while a recovered call ran to completion: this arc's
        // recurring failure wearing one more disguise. The controller's
        // presence is the fact, so it is what the sentence reads from.
        const abort = this.currentAbort;
        if (abort != null) {
          abort.abort(new HaltAbort(halt.halt_id));
          // "signalled", not "aborted": the signal is observed between
          // stream chunks, so a tool call already in flight runs to its
          // end.
          stopped.push(
            `signalled abort of run ${runId.slice(0, 8)} (a tool call already in flight finishes)`,
          );
        } else {
          stopped.push(
            `run ${runId.slice(0, 8)} is executing an approved call and cannot be interrupted — it will finish`,
          );
        }
      }
    }
    stopped.push(
      halt.goal_id == null
        ? "no further goal runs, recovered approvals, or consolidation will start"
        : `goal ${halt.goal_id.slice(0, 8)} will not fire`,
    );
    return stopped.join("; ");
  }

  /**
   * A suspended turn that no longer exists in the runtime (voided by another
   * actor's approval, or timed out) cannot receive its verdict. Close the run
   * so the goal is released on cadence and the recovered-approval drain does
   * not execute the call out of band. No-op unless the run is still waiting.
   */
  private closeVoidedRun(turn: SuspendedTurn, summary: string): void {
    const run = this.runStore.get(turn.runId);
    if (run == null || run.status !== "awaiting_approval") return;
    this.finishRecoveredRun(run, { ok: false, summary, countAsFailure: false });
  }

  /**
   * Close a recovered run. A decision applied after a restart never
   * finishes the GOAL — at most it finishes the one action the human saw —
   * so the honest terminal states are `partial` (action ran or was refused;
   * remaining work not resumed) and `failed`. Never `completed`: a
   * projection that counts completed runs as goal success must not count
   * these.
   */
  private finishRecoveredRun(
    run: GoalRun,
    verdict: { ok: boolean; summary: string; countAsFailure: boolean; toolCallsMade?: number },
  ): void {
    const status = verdict.ok ? "partial" : "failed";
    this.runStore.setStatus(run.run_id, status, { note: verdict.summary });
    this.goalOutcomeStore.add({
      outcome_id: crypto.randomUUID(),
      run_id: run.run_id,
      goal_id: run.goal_id,
      motebit_id: this.motebitId,
      ran_at: Date.now(),
      status,
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
    logLine(`[goal] recovered run ${run.run_id.slice(0, 8)} → ${status}`);
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
  /**
   * The ONE place a completed goal run becomes a record.
   *
   * Two paths reach completion — an ordinary fire, and a run that paused
   * for a human's yes and then finished — and only the first of them
   * wrote an outcome at all. So a goal that needed approval produced no
   * result, nothing signed, and `runs show` reporting that the run never
   * reached an outcome row. The signing drift gate stayed green because
   * it matches the call once per FILE, which is the same aperture
   * blindness this increment set out to correct, one level down.
   *
   * Fixing the second call site would have been the second fix. There is
   * one writer instead, so a third path inherits signing and whole-result
   * retention rather than having to remember them.
   *
   * `signGoalArtifact` returns null when no identity is loaded, and that
   * stays null: an unsigned result recorded honestly is a record; a
   * placeholder signature is a lie with a checksum.
   */
  private async recordCompletedOutcome(
    goalId: string,
    runId: string,
    result: GoalStreamResult,
    opts: { status?: GoalOutcome["status"]; errorMessage?: string | null } = {},
  ): Promise<void> {
    const full = result.responseText;
    let signedManifest: string | null = null;
    // Nothing to sign is not something to sign. Signing an empty result
    // produced a manifest over zero bytes, which `runs show` then
    // rendered as "empty." immediately followed by "signed" — a
    // signature presented as backing an artifact that does not exist.
    try {
      const manifest =
        full === "" ? null : await this.runtime.signGoalArtifact(full, { goalId, runId });
      signedManifest = manifest == null ? null : JSON.stringify(manifest);
    } catch (err: unknown) {
      logLine(
        `[scheduler] goal artifact could not be signed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    // runId = outcome_id, so the run, its outcome and its tool-audit rows
    // all join on one id.
    this.goalOutcomeStore.add({
      outcome_id: runId,
      run_id: runId,
      goal_id: goalId,
      motebit_id: this.motebitId,
      ran_at: Date.now(),
      status: opts.status ?? "completed",
      summary: full.slice(0, 500) || null,
      tool_calls_made: result.toolCallsMade,
      memories_formed: result.memoriesFormed,
      error_message: opts.errorMessage ?? null,
      ...(full !== "" ? { response_full: full } : {}),
      ...(signedManifest != null ? { signed_manifest: signedManifest } : {}),
    });
  }

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

function formatMsAgo(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h`;
  return `${Math.round(ms / 86_400_000)}d`;
}
