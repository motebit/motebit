import type { MotebitRuntime, StreamChunk } from "@motebit/runtime";
import type { SqliteGoalStore } from "@motebit/persistence";
import { EventType, RiskLevel } from "@motebit/sdk";

export class GoalScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;

  constructor(
    private runtime: MotebitRuntime,
    private goalStore: SqliteGoalStore,
    private motebitId: string,
    private denyAbove: RiskLevel,
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
  }

  private async tick(): Promise<void> {
    // Single-flight guard — prevent re-entry if previous tick is still running
    if (this.ticking) return;
    this.ticking = true;

    try {
      const goals = this.goalStore.list(this.motebitId);
      const now = Date.now();

      for (const goal of goals) {
        if (!goal.enabled) continue;

        const elapsed = goal.last_run_at ? now - goal.last_run_at : Infinity;
        if (elapsed < goal.interval_ms) continue;

        console.log(`[goal] executing: "${goal.prompt.slice(0, 60)}"`);

        try {
          const stream = this.runtime.sendMessageStreaming(goal.prompt);
          await this.consumeDaemonStream(stream, goal.goal_id);
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

  private async consumeDaemonStream(
    stream: AsyncGenerator<StreamChunk>,
    goalId: string,
  ): Promise<void> {
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
          // PolicyGate already classified this tool and determined it needs approval.
          // In daemon mode: auto-deny and log as a skipped approval event.
          // The approval queue (persist + drain later) is a v0.2 feature.
          console.warn(`\n  [approval-skipped] ${chunk.name} — requires human approval, denied in daemon mode`);
          void this.logApprovalSkipped(goalId, chunk.name, chunk.args);

          const resumeStream = this.runtime.resumeAfterApproval(false);
          await this.consumeDaemonStream(resumeStream, goalId);
          return;
        }

        case "injection_warning":
          console.warn(`\n  [warning] suspicious content in ${chunk.tool_name}`);
          break;

        case "result":
          console.log("\n  [goal turn complete]");
          break;
      }
    }
  }

  private async logApprovalSkipped(
    goalId: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<void> {
    try {
      const clock = await this.runtime.events.getLatestClock(this.motebitId);
      await this.runtime.events.append({
        event_id: crypto.randomUUID(),
        motebit_id: this.motebitId,
        timestamp: Date.now(),
        event_type: EventType.GoalExecuted,
        payload: {
          status: "approval_skipped",
          goal_id: goalId,
          tool: toolName,
          args_preview: JSON.stringify(args).slice(0, 200),
          deny_above: RiskLevel[this.denyAbove],
        },
        version_clock: clock + 1,
        tombstoned: false,
      });
    } catch {
      // Best-effort event logging
    }
  }
}
