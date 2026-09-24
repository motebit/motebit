/**
 * Child process for the real-crash durability test (scheduler-crash.test.ts).
 *
 * Phase 1: a goal pauses on an approval; the daemon "stops". The human
 * approves. Phase 2: a new scheduler applies the approval — the mocked
 * external call leaves behind exactly what the real policy gate would
 * (paused decision row + approval-satisfied row under run_id), touches a
 * marker file to say "the external effect happened", then HANGS. The parent
 * SIGKILLs this process at that point: after the effect, before the
 * completion row and the run's outcome are recorded.
 *
 * argv: <dbPath> <markerPath>
 */
import { writeFileSync } from "node:fs";
import { createMotebitDatabase } from "@motebit/persistence";
import { RiskLevel } from "@motebit/sdk";
import type { MotebitRuntime, StreamChunk } from "@motebit/runtime";
import { GoalScheduler } from "../../scheduler.js";

const [dbPathArg, markerPathArg] = process.argv.slice(2);
if (!dbPathArg || !markerPathArg) throw new Error("usage: crash-child <dbPath> <markerPath>");
const dbPath: string = dbPathArg;
const markerPath: string = markerPathArg;

const db = createMotebitDatabase(dbPath);
const noop = async (): Promise<void> => undefined;

function mockRuntime(opts: {
  pause?: boolean;
  onInvoke?: (runId: string | undefined) => Promise<never>;
}): MotebitRuntime {
  let pending = false;
  return {
    get hasPendingApproval() {
      return pending;
    },
    get pendingApprovalInfo() {
      return pending
        ? { toolName: "shell_exec", args: { command: "ls" }, toolCallId: "tc-1" }
        : null;
    },
    async *sendMessageStreaming(): AsyncGenerator<StreamChunk> {
      if (opts.pause === true) {
        pending = true;
        yield {
          type: "approval_request" as const,
          tool_call_id: "tc-1",
          name: "shell_exec",
          args: { command: "ls", cwd: "/tmp" },
          risk_level: RiskLevel.R3_EXECUTE,
        };
        return;
      }
      yield { type: "text" as const, text: "done" };
    },
    async *resumeAfterApproval(): AsyncGenerator<StreamChunk> {
      pending = false;
    },
    async invokeLocalTool(_n: string, _a: Record<string, unknown>, o: { runId?: string }) {
      if (!opts.onInvoke) return { ok: true, data: "ran" };
      return opts.onInvoke(o.runId);
    },
    events: { getLatestClock: async () => 0, append: noop },
    goals: { created: noop, executed: noop, progress: noop, completed: noop, removed: noop },
    // Halt contract (increment 2) — never halted in this fixture.
    onHalt: () => () => undefined,
    halts: null,
    haltInForce: () => null,
    honorHalts: async () => [],
    liftHalt: async () => false,
    setGoalIdResolver: () => undefined,
    setGoalStatusResolver: () => undefined,
    getToolRegistry: () => ({ register: () => undefined, replace: () => undefined }),
    stop: () => undefined,
    consolidationCycle: noop,
  } as unknown as MotebitRuntime;
}

function scheduler(rt: MotebitRuntime): GoalScheduler {
  const s = new GoalScheduler(
    rt,
    db.goalStore,
    db.approvalStore,
    db.goalOutcomeStore,
    db.goalRunStore,
    db.toolAuditSink,
    "mote-crash",
    RiskLevel.R3_EXECUTE,
  );
  s.registerGoalTools();
  return s;
}

async function main(): Promise<void> {
  // Phase 1 — pause on approval, "stop" the daemon, human approves.
  db.goalStore.add({
    goal_id: "goal-crash",
    motebit_id: "mote-crash",
    prompt: "tidy the inbox",
    interval_ms: 3_600_000,
    last_run_at: null,
    enabled: true,
    created_at: Date.now(),
    mode: "recurring",
    status: "active",
    parent_goal_id: null,
    max_retries: 3,
    consecutive_failures: 0,
    wall_clock_ms: null,
    project_id: null,
  });
  const s1 = scheduler(mockRuntime({ pause: true }));
  await s1.tickOnce();
  s1.stop();
  const [approval] = db.approvalStore.listAll("mote-crash");
  if (!approval) throw new Error("no approval persisted");
  db.approvalStore.resolve(approval.approval_id, "approved");

  // Phase 2 — a new process applies the approval; the effect happens; we hang.
  const s2 = scheduler(
    mockRuntime({
      onInvoke: async (runId) => {
        for (const decision of [
          { allowed: true, requiresApproval: true },
          { allowed: true, requiresApproval: false, reason: "approval_satisfied:human-approved" },
        ]) {
          db.toolAuditSink.append({
            turnId: "turn-crash",
            runId,
            callId: "call-crash",
            tool: "shell_exec",
            args: { command: "ls", cwd: "/tmp" },
            decision,
            timestamp: Date.now(),
          });
        }
        writeFileSync(markerPath, "effect happened\n");
        // The external effect is done. The completion row and the run's
        // outcome have NOT been written. Hang here until SIGKILL — with a
        // live handle, or Node would drain the loop and exit cleanly, which
        // is exactly the graceful death this test must NOT model.
        setInterval(() => undefined, 1000);
        return new Promise<never>(() => undefined);
      },
    }),
  );
  s2.recoverInterruptedRuns();
  await s2.tickOnce();
  throw new Error("unreachable — the parent should have killed us while hung");
}

main().catch((err) => {
  process.stderr.write(`crash-child: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(2);
});
