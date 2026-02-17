import type { MotebitRuntime, StreamChunk } from "@motebit/runtime";
import type { SqliteGoalStore, SqliteApprovalStore } from "@motebit/persistence";
import { EventType, RiskLevel } from "@motebit/sdk";

interface SuspendedTurn {
  approvalId: string;
  goalId: string;
  createdAt: number;
}

export class GoalScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  private suspended = new Map<string, SuspendedTurn>();

  constructor(
    private runtime: MotebitRuntime,
    private goalStore: SqliteGoalStore,
    private approvalStore: SqliteApprovalStore,
    private motebitId: string,
    private denyAbove: RiskLevel,
    private defaultTtlMs = 3_600_000, // 1 hour
  ) {}

  start(tickMs = 60_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, tickMs);
    // Run immediately on start
    void this.tick();
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
        if (!goal.enabled) continue;

        const elapsed = goal.last_run_at ? now - goal.last_run_at : Infinity;
        if (elapsed < goal.interval_ms) continue;

        console.log(`[goal] executing: "${goal.prompt.slice(0, 60)}"`);

        try {
          const stream = this.runtime.sendMessageStreaming(goal.prompt);
          const suspended = await this.consumeDaemonStream(stream, goal.goal_id);
          if (suspended) {
            // Turn is suspended waiting for approval — don't update last_run_at,
            // don't run more goals. The next tick will drain the approval.
            return;
          }
          this.goalStore.updateLastRun(goal.goal_id, Date.now());
          console.log(`[goal] completed: ${goal.goal_id.slice(0, 8)}`);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[goal] error for ${goal.goal_id.slice(0, 8)}: ${msg}`);
        }
      }
    } finally {
      this.ticking = false;
    }
  }

  // Returns true if the stream was suspended for approval
  private async consumeDaemonStream(
    stream: AsyncGenerator<StreamChunk>,
    goalId: string,
  ): Promise<boolean> {
    for await (const chunk of stream) {
      switch (chunk.type) {
        case "text":
          process.stdout.write(chunk.text);
          break;

        case "tool_status":
          if (chunk.status === "calling") {
            process.stdout.write(`\n  [tool] ${chunk.name}...`);
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

          // Don't resume, don't deny — return suspended.
          // The turn stays suspended in the runtime until operator resolves.
          return true;
        }

        case "injection_warning":
          console.warn(`\n  [warning] suspicious content in ${chunk.tool_name}`);
          break;

        case "result":
          console.log("\n  [goal turn complete]");
          break;
      }
    }
    return false;
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
        const resumeStream = this.runtime.resumeAfterApproval(approved);
        const reSuspended = await this.consumeDaemonStream(resumeStream, turn.goalId);
        if (approved && !reSuspended) {
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
}

function hashArgs(argsJson: string): string {
  // Synchronous SHA-256 using Node.js crypto
  const { createHash } = require("node:crypto") as typeof import("node:crypto");
  return createHash("sha256").update(argsJson).digest("hex");
}
