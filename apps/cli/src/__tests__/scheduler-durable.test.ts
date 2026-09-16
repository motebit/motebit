/**
 * Durable unattended execution — the three interruption points.
 *
 *   1. while awaiting approval  — the decision survives the process; after a
 *      restart it applies to EXACTLY the one approved call, never a re-run;
 *   2. after external success, before local recording — the audit log has a
 *      decision row and no completion row: the run is held as uncertain;
 *   3. before invocation — no allowed call was recorded: the run resolves
 *      itself and the goal re-fires on schedule.
 *
 * The requirement under test: after interruption, recover each run without
 * silently repeating completed actions, losing pending decisions, or
 * treating an uncertain external effect as safe to retry.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createHash } from "node:crypto";
import { GoalScheduler } from "../scheduler.js";
import { createMotebitDatabase, type MotebitDatabase, type Goal } from "@motebit/persistence";
import { RiskLevel, TrustMode, BatteryMode } from "@motebit/sdk";
import type { ToolDefinition, ToolHandler } from "@motebit/sdk";
import type { MotebitRuntime, StreamChunk } from "@motebit/runtime";
import type { TurnResult } from "@motebit/ai-core";

function turnResult(): TurnResult {
  return {
    response: "",
    memoriesFormed: [],
    memoriesRetrieved: [],
    stateAfter: {
      attention: 0,
      processing: 0,
      confidence: 0,
      affect_valence: 0.5,
      affect_arousal: 0,
      social_distance: 0.5,
      curiosity: 0,
      trust_mode: TrustMode.Guarded,
      battery_mode: BatteryMode.Normal,
    },
    cues: {
      hover_distance: 0.4,
      drift_amplitude: 0.02,
      glow_intensity: 0,
      eye_dilation: 0.5,
      smile_curvature: 0,
      speaking_activity: 0,
    },
    iterations: 1,
    toolCallsSucceeded: 0,
    toolCallsBlocked: 0,
    toolCallsFailed: 0,
  };
}

interface Mock {
  runtime: MotebitRuntime;
  streams: number;
  invoked: Array<{ name: string; args: Record<string, unknown>; opts: unknown }>;
  /** Goal tools currently registered on the (mock) registry. */
  registered: Map<string, ToolHandler>;
  /** Simulate the runtime's own approval timeout firing: the paused turn is gone. */
  clearPending: () => void;
  /** Simulate another actor's approval becoming pending in the shared runtime. */
  setForeignPending: () => void;
}

/** A runtime whose first turn pauses on `shell_exec`, and which counts every stream start. */
function mockRuntime(
  opts: {
    pause?: boolean;
    invokeOk?: boolean;
    resumeThrows?: boolean;
    /** The first stream yields one chunk, then waits on this before continuing. */
    holdStream?: Promise<void>;
  } = {},
): Mock {
  let pending = false;
  let pendingId = "tc-1";
  const tools = new Map<string, ToolHandler>();
  const m: Mock = {
    runtime: null as unknown as MotebitRuntime,
    streams: 0,
    invoked: [],
    registered: tools,
    clearPending: () => {
      pending = false;
    },
    setForeignPending: () => {
      pending = true;
      pendingId = "someone-elses";
    },
  };
  m.runtime = {
    get hasPendingApproval() {
      return pending;
    },
    get pendingApprovalInfo() {
      return pending
        ? { toolName: "shell_exec", args: { command: "ls" }, toolCallId: pendingId }
        : null;
    },
    async *sendMessageStreaming(_t: string): AsyncGenerator<StreamChunk> {
      m.streams++;
      if (opts.holdStream) {
        yield { type: "text" as const, text: "working" };
        await opts.holdStream;
        yield { type: "text" as const, text: "still working" };
        yield { type: "result" as const, result: turnResult() };
        return;
      }
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
      yield { type: "result" as const, result: turnResult() };
    },
    async *resumeAfterApproval(): AsyncGenerator<StreamChunk> {
      pending = false;
      if (opts.resumeThrows === true) throw new Error("resume exploded");
      yield { type: "result" as const, result: turnResult() };
    },
    async invokeLocalTool(name: string, args: Record<string, unknown>, o: unknown) {
      m.invoked.push({ name, args, opts: o });
      return opts.invokeOk === false ? { ok: false, error: "nope" } : { ok: true, data: "ran" };
    },
    events: {
      getLatestClock: vi.fn().mockResolvedValue(0),
      append: vi.fn().mockResolvedValue(undefined),
    },
    goals: {
      created: vi.fn().mockResolvedValue(undefined),
      executed: vi.fn().mockResolvedValue(undefined),
      progress: vi.fn().mockResolvedValue(undefined),
      completed: vi.fn().mockResolvedValue(undefined),
      removed: vi.fn().mockResolvedValue(undefined),
    },
    setGoalStatusResolver: vi.fn(),
    getToolRegistry: vi.fn().mockReturnValue({
      register: vi
        .fn()
        .mockImplementation((d: ToolDefinition, h: ToolHandler) => tools.set(d.name, h)),
      replace: vi
        .fn()
        .mockImplementation((d: ToolDefinition, h: ToolHandler) => tools.set(d.name, h)),
    }),
    stop: vi.fn(),
    consolidationCycle: vi.fn().mockResolvedValue(undefined),
  } as unknown as MotebitRuntime;
  return m;
}

function goal(over: Partial<Goal> = {}): Goal {
  return {
    goal_id: "goal-001",
    motebit_id: "mote-test",
    prompt: "tidy the inbox",
    interval_ms: 0,
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
    ...over,
  };
}

function scheduler(db: MotebitDatabase, m: Mock): GoalScheduler {
  const s = new GoalScheduler(
    m.runtime,
    db.goalStore,
    db.approvalStore,
    db.goalOutcomeStore,
    db.goalRunStore,
    db.toolAuditSink,
    "mote-test",
    RiskLevel.R3_EXECUTE,
  );
  s.registerGoalTools();
  return s;
}

/** Simulate a process that died mid-run: a `running` ledger row plus the audit rows it left behind. */
function deadRun(
  db: MotebitDatabase,
  runId: string,
  rows: Array<{
    callId: string;
    allowed?: boolean;
    requiresApproval?: boolean;
    completed?: boolean;
  }>,
): void {
  db.goalRunStore.start({ run_id: runId, goal_id: "goal-001", motebit_id: "mote-test" });
  for (const r of rows) {
    const decision = { allowed: r.allowed ?? true, requiresApproval: r.requiresApproval ?? false };
    db.toolAuditSink.append({
      turnId: "turn-dead",
      runId,
      callId: r.callId,
      tool: "send_email",
      args: { to: "x" },
      decision,
      timestamp: Date.now() - 10,
    });
    if (r.completed === true) {
      db.toolAuditSink.append({
        turnId: "turn-dead",
        runId,
        callId: r.callId,
        tool: "send_email",
        args: { to: "x" },
        decision,
        result: { ok: true, durationMs: 5 },
        timestamp: Date.now() - 5,
      });
    }
  }
}

describe("durable execution — interruption while awaiting approval", () => {
  let db: MotebitDatabase;
  beforeEach(() => {
    db = createMotebitDatabase(":memory:");
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  it("the pause persists the full args and the run; a new process holds the goal and keeps the approval pending", async () => {
    db.goalStore.add(goal());
    const first = mockRuntime({ pause: true });
    const s1 = scheduler(db, first);
    await s1.tickOnce();
    s1.stop();

    const [approval] = db.approvalStore.listAll("mote-test");
    expect(approval!.status).toBe("pending");
    expect(JSON.parse(approval!.args_json!)).toEqual({ command: "ls", cwd: "/tmp" });
    const run = db.goalRunStore.getByApproval(approval!.approval_id)!;
    expect(run.status).toBe("awaiting_approval");

    // --- restart ---
    const second = mockRuntime();
    const s2 = scheduler(db, second);
    s2.recoverInterruptedRuns();
    await s2.tickOnce();
    await s2.tickOnce();

    expect(db.approvalStore.get(approval!.approval_id)!.status).toBe("pending"); // not denied
    expect(second.streams).toBe(0); // goal NOT re-fired while its run is unresolved
    expect(db.goalRunStore.get(run.run_id)!.status).toBe("awaiting_approval");
  });

  it("approving after the restart executes EXACTLY the approved call once, then closes the run", async () => {
    // Hourly cadence: a closed run moves last_run_at, so the goal waits for
    // its next due time instead of firing again in the same tick.
    db.goalStore.add(goal({ interval_ms: 3_600_000 }));
    const first = mockRuntime({ pause: true });
    const s1 = scheduler(db, first);
    await s1.tickOnce();
    s1.stop();
    const [approval] = db.approvalStore.listAll("mote-test");
    db.approvalStore.resolve(approval!.approval_id, "approved");
    const run0 = db.goalRunStore.getByApproval(approval!.approval_id)!;

    const second = mockRuntime();
    const s2 = scheduler(db, second);
    s2.recoverInterruptedRuns();
    await s2.tickOnce();

    expect(second.invoked).toHaveLength(1);
    expect(second.invoked[0]!.name).toBe("shell_exec");
    expect(second.invoked[0]!.args).toEqual({ command: "ls", cwd: "/tmp" });
    expect(second.invoked[0]!.opts).toEqual({
      invocationOrigin: "scheduled",
      humanApproved: true,
      runId: run0.run_id,
    });
    expect(second.streams).toBe(0); // the paused turn is NOT re-run

    const run = db.goalRunStore.getByApproval(approval!.approval_id)!;
    // The one approved call finishing is NOT the goal finishing — structurally.
    expect(run.status).toBe("partial");
    const outcomes = db.goalOutcomeStore.listForGoal("goal-001");
    expect(outcomes.some((o) => o.status === "completed")).toBe(false);
    const recovered = outcomes.find((o) => o.status === "partial");
    expect(recovered).toBeDefined();
    expect(recovered!.summary).toContain("shell_exec");
    expect(recovered!.summary).toContain("remaining work was not resumed");
    expect(db.goalStore.get("goal-001")!.last_run_at).not.toBeNull();

    // A later tick does not execute it again.
    await s2.tickOnce();
    expect(second.invoked).toHaveLength(1);
  });

  it("denying after the restart executes nothing and closes the run with the denial noted", async () => {
    db.goalStore.add(goal({ interval_ms: 3_600_000 }));
    const first = mockRuntime({ pause: true });
    const s1 = scheduler(db, first);
    await s1.tickOnce();
    s1.stop();
    const [approval] = db.approvalStore.listAll("mote-test");
    db.approvalStore.resolve(approval!.approval_id, "denied", "not today");

    const second = mockRuntime();
    const s2 = scheduler(db, second);
    s2.recoverInterruptedRuns();
    await s2.tickOnce();

    expect(second.invoked).toHaveLength(0);
    expect(second.streams).toBe(0);
    const run = db.goalRunStore.getByApproval(approval!.approval_id)!;
    expect(run.status).toBe("partial"); // nothing ran, and the goal did not finish
    expect(run.note).toContain("denied");
    expect(db.goalOutcomeStore.listForGoal("goal-001").some((o) => o.status === "completed")).toBe(
      false,
    );
  });

  it("an R4 money approval is never executed from a recovered run", async () => {
    db.goalStore.add(goal());
    const now = Date.now();
    db.goalRunStore.start({ run_id: "run-money", goal_id: "goal-001", motebit_id: "mote-test" });
    db.goalRunStore.setStatus("run-money", "awaiting_approval", { approval_id: "ap-money" });
    db.approvalStore.add({
      approval_id: "ap-money",
      motebit_id: "mote-test",
      goal_id: "goal-001",
      tool_name: "pay_invoice",
      args_preview: "{}",
      args_hash: "x",
      risk_level: RiskLevel.R4_MONEY,
      status: "approved",
      created_at: now,
      expires_at: now + 1000,
      resolved_at: now,
      denied_reason: null,
      args_json: "{}",
    });
    const m = mockRuntime();
    const s = scheduler(db, m);
    s.recoverInterruptedRuns();
    await s.tickOnce();
    expect(m.invoked).toHaveLength(0);
    expect(db.goalRunStore.get("run-money")!.status).toBe("failed");
    expect(db.goalRunStore.get("run-money")!.note).toContain("money");
  });

  it("an approval whose persisted args no longer hash to what was approved is refused", async () => {
    db.goalStore.add(goal());
    const now = Date.now();
    db.goalRunStore.start({ run_id: "run-tamper", goal_id: "goal-001", motebit_id: "mote-test" });
    db.goalRunStore.setStatus("run-tamper", "awaiting_approval", { approval_id: "ap-tamper" });
    db.approvalStore.add({
      approval_id: "ap-tamper",
      motebit_id: "mote-test",
      goal_id: "goal-001",
      tool_name: "shell_exec",
      args_preview: "{}",
      args_hash: "does-not-match",
      risk_level: RiskLevel.R3_EXECUTE,
      status: "approved",
      created_at: now,
      expires_at: now + 1000,
      resolved_at: now,
      denied_reason: null,
      args_json: JSON.stringify({ command: "rm -rf /" }),
    });
    const m = mockRuntime();
    const s = scheduler(db, m);
    s.recoverInterruptedRuns();
    await s.tickOnce();
    expect(m.invoked).toHaveLength(0);
    expect(db.goalRunStore.get("run-tamper")!.status).toBe("failed");
  });

  it("an approval that expired while the daemon was down fails the run and releases the goal", async () => {
    db.goalStore.add(goal());
    const now = Date.now();
    db.goalRunStore.start({ run_id: "run-exp", goal_id: "goal-001", motebit_id: "mote-test" });
    db.goalRunStore.setStatus("run-exp", "awaiting_approval", { approval_id: "ap-exp" });
    db.approvalStore.add({
      approval_id: "ap-exp",
      motebit_id: "mote-test",
      goal_id: "goal-001",
      tool_name: "shell_exec",
      args_preview: "{}",
      args_hash: "x",
      risk_level: RiskLevel.R3_EXECUTE,
      status: "pending",
      created_at: now - 7_200_000,
      expires_at: now - 3_600_000,
      resolved_at: null,
      denied_reason: null,
      args_json: "{}",
    });
    const m = mockRuntime();
    const s = scheduler(db, m);
    s.recoverInterruptedRuns();
    await s.tickOnce(); // expires + drains; the goal fires only on the NEXT tick (last_run_at just moved)
    expect(db.goalRunStore.get("run-exp")!.status).toBe("failed");
    expect(db.goalRunStore.get("run-exp")!.note).toContain("expired");
    expect(m.invoked).toHaveLength(0);
    expect(db.goalRunStore.blockingRunForGoal("goal-001")).toBeNull();
  });
});

describe("durable execution — interruption during recovery", () => {
  let db: MotebitDatabase;
  beforeEach(() => {
    db = createMotebitDatabase(":memory:");
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  async function pauseApproveAndStop(): Promise<{ approvalId: string; runId: string }> {
    db.goalStore.add(goal({ interval_ms: 3_600_000 }));
    const first = mockRuntime({ pause: true });
    const s1 = scheduler(db, first);
    await s1.tickOnce();
    s1.stop();
    const [approval] = db.approvalStore.listAll("mote-test");
    db.approvalStore.resolve(approval!.approval_id, "approved");
    return {
      approvalId: approval!.approval_id,
      runId: db.goalRunStore.getByApproval(approval!.approval_id)!.run_id,
    };
  }

  it("the run leaves awaiting_approval BEFORE the recovered call executes", async () => {
    const { runId } = await pauseApproveAndStop();
    const second = mockRuntime();
    let statusDuringCall: string | undefined;
    (second.runtime as unknown as { invokeLocalTool: unknown }).invokeLocalTool = async (
      name: string,
      args: Record<string, unknown>,
      o: unknown,
    ) => {
      statusDuringCall = db.goalRunStore.get(runId)!.status;
      second.invoked.push({ name, args, opts: o });
      return { ok: true, data: "ran" };
    };
    const s2 = scheduler(db, second);
    s2.recoverInterruptedRuns();
    await s2.tickOnce();
    expect(second.invoked).toHaveLength(1);
    expect(statusDuringCall).toBe("running");
  });

  it("dying after the recovered call returned but before its outcome landed holds it as unknown — the approval is NOT executed again", async () => {
    const { runId } = await pauseApproveAndStop();

    // Second process: the gate wrote the decision row under run_id, the tool
    // returned, and the process died before recordResult / the run's outcome
    // landed. Reproduce exactly that on-disk state: a `running` run, an
    // `approved` approval, one decision row with no completion row.
    const dying = mockRuntime();
    (dying.runtime as unknown as { invokeLocalTool: unknown }).invokeLocalTool = async (
      _n: string,
      _a: Record<string, unknown>,
      o: { runId?: string },
    ) => {
      // What the real invokeLocalTool leaves behind: the gate's paused
      // decision row, then the approval-satisfied row, then nothing.
      for (const decision of [
        { allowed: true, requiresApproval: true },
        { allowed: true, requiresApproval: false, reason: "approval_satisfied:human-approved" },
      ]) {
        db.toolAuditSink.append({
          turnId: "turn-recovery",
          runId: o.runId,
          callId: "call-recovery",
          tool: "shell_exec",
          args: { command: "ls", cwd: "/tmp" },
          decision,
          timestamp: Date.now(),
        });
      }
      throw new Error("SIGKILL");
    };
    const s2 = scheduler(db, dying);
    s2.recoverInterruptedRuns();
    await s2.tickOnce();
    // The scheduler caught the throw and wrote a failure; a real death writes
    // nothing after the call. Roll its post-call bookkeeping back to the
    // pre-outcome state the ledger would actually hold.
    db.goalRunStore.setStatus(runId, "running");

    // Third process.
    const third = mockRuntime();
    const s3 = scheduler(db, third);
    s3.recoverInterruptedRuns();
    await s3.tickOnce();
    await s3.tickOnce();

    expect(third.invoked).toHaveLength(0); // not executed a second time
    expect(third.streams).toBe(0); // goal held
    const run = db.goalRunStore.get(runId)!;
    expect(run.status).toBe("interrupted");
    expect(run.reviewed_at).toBeNull();
    expect(run.uncertain_actions?.map((u) => u.call_id)).toEqual(["call-recovery"]);
  });
});

describe("durable execution — live approval drain", () => {
  let db: MotebitDatabase;
  beforeEach(() => {
    db = createMotebitDatabase(":memory:");
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  it("the run leaves awaiting_approval BEFORE the paused turn resumes, and completes after", async () => {
    db.goalStore.add(goal({ interval_ms: 3_600_000 }));
    const m = mockRuntime({ pause: true });
    const s = scheduler(db, m);
    await s.tickOnce();
    const [approval] = db.approvalStore.listAll("mote-test");
    const runId = db.goalRunStore.getByApproval(approval!.approval_id)!.run_id;
    let statusDuringResume: string | undefined;
    const original = m.runtime.resumeAfterApproval.bind(m.runtime);
    (m.runtime as unknown as { resumeAfterApproval: unknown }).resumeAfterApproval = (
      approved: boolean,
    ) => {
      statusDuringResume = db.goalRunStore.get(runId)!.status;
      return original(approved);
    };
    db.approvalStore.resolve(approval!.approval_id, "approved");
    await s.tickOnce();
    expect(statusDuringResume).toBe("running");
    expect(db.goalRunStore.get(runId)!.status).toBe("completed");
  });
});

describe("durable execution — interruption mid-run", () => {
  let db: MotebitDatabase;
  beforeEach(() => {
    db = createMotebitDatabase(":memory:");
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  it("after external success but before local recording: held as uncertain, goal not re-fired", async () => {
    db.goalStore.add(goal());
    deadRun(db, "run-crash", [{ callId: "c1", completed: false }]);

    const m = mockRuntime();
    const s = scheduler(db, m);
    s.recoverInterruptedRuns();

    const run = db.goalRunStore.get("run-crash")!;
    expect(run.status).toBe("interrupted");
    expect(run.completed_actions).toBe(0);
    expect(run.uncertain_actions).toEqual([
      { call_id: "c1", tool: "send_email", intended_at: expect.any(Number) as number },
    ]);
    expect(run.reviewed_at).toBeNull();

    await s.tickOnce();
    await s.tickOnce();
    expect(m.streams).toBe(0); // never silently retried
    const outcome = db.goalOutcomeStore.listForGoal("goal-001")[0]!;
    expect(outcome.status).toBe("failed");
    expect(outcome.error_message).toContain("unknown outcome");
  });

  it("completed actions also hold the goal (re-firing would repeat them) until a human acks", async () => {
    db.goalStore.add(goal());
    deadRun(db, "run-done", [
      { callId: "c1", completed: true },
      { callId: "c2", completed: true },
    ]);

    const m = mockRuntime();
    const s = scheduler(db, m);
    s.recoverInterruptedRuns();
    const run = db.goalRunStore.get("run-done")!;
    expect(run.completed_actions).toBe(2);
    expect(run.uncertain_actions).toEqual([]);
    await s.tickOnce();
    expect(m.streams).toBe(0);

    expect(db.goalRunStore.ack("run-done")).toBe(true);
    await s.tickOnce();
    expect(m.streams).toBe(1); // released by a human, fires on schedule
  });

  it("before invocation: no allowed call recorded, so the run resolves itself and the goal re-fires", async () => {
    db.goalStore.add(goal());
    deadRun(db, "run-early", [{ callId: "d1", allowed: false }]);

    const m = mockRuntime();
    const s = scheduler(db, m);
    s.recoverInterruptedRuns();
    const run = db.goalRunStore.get("run-early")!;
    expect(run.status).toBe("interrupted");
    expect(run.completed_actions).toBe(0);
    expect(run.uncertain_actions).toEqual([]);
    expect(run.reviewed_at).not.toBeNull();

    await s.tickOnce();
    expect(m.streams).toBe(1);
  });

  it("a live run is a ledger row from before the first model call, closed on completion", async () => {
    db.goalStore.add(goal());
    const m = mockRuntime();
    const s = scheduler(db, m);
    await s.tickOnce();
    const runs = db.goalRunStore.listForGoal("goal-001");
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe("completed");
    expect(runs[0]!.run_id).toBe(db.goalOutcomeStore.listForGoal("goal-001")[0]!.outcome_id);
  });
});

describe("durable execution — review round: every running transition has a failure transition", () => {
  let db: MotebitDatabase;
  beforeEach(() => {
    db = createMotebitDatabase(":memory:");
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  function waitingRun(over: {
    runId: string;
    approvalId: string;
    risk?: number;
    expiresAt?: number;
    resolvedAt?: number | null;
    status?: "pending" | "approved" | "denied";
  }): void {
    const now = Date.now();
    db.goalRunStore.start({ run_id: over.runId, goal_id: "goal-001", motebit_id: "mote-test" });
    db.goalRunStore.setStatus(over.runId, "awaiting_approval", { approval_id: over.approvalId });
    const argsJson = JSON.stringify({ command: "ls" });
    db.approvalStore.add({
      approval_id: over.approvalId,
      motebit_id: "mote-test",
      goal_id: "goal-001",
      tool_name: "shell_exec",
      args_preview: argsJson,
      args_hash: hashArgsForTest(argsJson),
      risk_level: over.risk ?? RiskLevel.R3_EXECUTE,
      status: over.status ?? "approved",
      created_at: now - 10,
      expires_at: over.expiresAt ?? now + 3_600_000,
      resolved_at: over.resolvedAt === undefined ? now : over.resolvedAt,
      denied_reason: null,
      args_json: argsJson,
    });
  }

  it("a live resume that THROWS closes the run as failed — the goal is not held behind an un-ackable running row", async () => {
    db.goalStore.add(goal({ interval_ms: 3_600_000 }));
    const m = mockRuntime({ pause: true, resumeThrows: true });
    const s = scheduler(db, m);
    await s.tickOnce();
    const [approval] = db.approvalStore.listAll("mote-test");
    const runId = db.goalRunStore.getByApproval(approval!.approval_id)!.run_id;
    db.approvalStore.resolve(approval!.approval_id, "approved");

    await s.tickOnce();
    const run = db.goalRunStore.get(runId)!;
    expect(run.status).toBe("failed");
    expect(run.note).toContain("resume failed");
    expect(db.goalRunStore.blockingRunForGoal("goal-001")).toBeNull();
    expect(db.goalOutcomeStore.listForGoal("goal-001").some((o) => o.status === "failed")).toBe(
      true,
    );
  });

  it("an approval resolved after the runtime timed the paused turn out closes the run and is NOT executed out of band", async () => {
    db.goalStore.add(goal({ interval_ms: 3_600_000 }));
    const m = mockRuntime({ pause: true });
    const s = scheduler(db, m);
    await s.tickOnce();
    const [approval] = db.approvalStore.listAll("mote-test");
    const runId = db.goalRunStore.getByApproval(approval!.approval_id)!.run_id;
    m.clearPending(); // the runtime's own timeout fired; the model was told the call failed
    db.approvalStore.resolve(approval!.approval_id, "approved");

    await s.tickOnce();
    await s.tickOnce();
    expect(m.invoked).toHaveLength(0);
    const run = db.goalRunStore.get(runId)!;
    expect(run.status).toBe("failed");
    expect(run.note).toContain("not executed");
  });

  it("an approval granted AFTER its expiry (daemon was down, nothing swept it) is never executed", async () => {
    db.goalStore.add(goal({ interval_ms: 3_600_000 }));
    const now = Date.now();
    waitingRun({
      runId: "run-stale",
      approvalId: "ap-stale",
      expiresAt: now - 2 * 86_400_000,
      resolvedAt: now - 1000,
    });
    const m = mockRuntime();
    const s = scheduler(db, m);
    s.recoverInterruptedRuns();
    await s.tickOnce();
    expect(m.invoked).toHaveLength(0);
    const run = db.goalRunStore.get("run-stale")!;
    expect(run.status).toBe("failed");
    expect(run.note).toContain("expired");
  });

  it("a recovered approval waits while another actor's approval is pending in the shared runtime", async () => {
    db.goalStore.add(goal({ interval_ms: 3_600_000 }));
    waitingRun({ runId: "run-wait", approvalId: "ap-wait" });
    const m = mockRuntime();
    m.setForeignPending();
    const s = scheduler(db, m);
    s.recoverInterruptedRuns();
    await s.tickOnce();
    expect(m.invoked).toHaveLength(0);
    expect(db.goalRunStore.get("run-wait")!.status).toBe("awaiting_approval");
    // Once the foreign prompt is gone, the decision applies.
    m.clearPending();
    await s.tickOnce();
    expect(m.invoked).toHaveLength(1);
    expect(db.goalRunStore.get("run-wait")!.status).toBe("partial");
  });

  it("goal-scoped tools are registered while a recovered approval executes", async () => {
    db.goalStore.add(goal({ interval_ms: 3_600_000 }));
    waitingRun({ runId: "run-tools", approvalId: "ap-tools" });
    const m = mockRuntime();
    let sawGoalTools = false;
    (m.runtime as unknown as { invokeLocalTool: unknown }).invokeLocalTool = async () => {
      sawGoalTools = m.registered.has("report_progress");
      return { ok: true, data: "ran" };
    };
    const s = scheduler(db, m);
    s.recoverInterruptedRuns();
    await s.tickOnce();
    expect(sawGoalTools).toBe(true);
  });

  it("restart recovery never overwrites an outcome the live path already wrote", () => {
    db.goalStore.add(goal());
    db.goalRunStore.start({ run_id: "run-keep", goal_id: "goal-001", motebit_id: "mote-test" });
    db.goalOutcomeStore.add({
      outcome_id: "run-keep",
      goal_id: "goal-001",
      motebit_id: "mote-test",
      ran_at: Date.now(),
      status: "completed",
      summary: "the real result",
      tool_calls_made: 2,
      memories_formed: 1,
      error_message: null,
    });
    const s = scheduler(db, mockRuntime());
    s.recoverInterruptedRuns();
    const outcomes = db.goalOutcomeStore.listForGoal("goal-001");
    expect(outcomes.find((o) => o.outcome_id === "run-keep")?.summary).toBe("the real result");
    expect(outcomes).toHaveLength(2);
  });

  it("a graceful stop() mid-run closes the run as failed — it does not become a held interrupted run on restart", async () => {
    db.goalStore.add(goal({ interval_ms: 3_600_000 }));
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    const m = mockRuntime({ holdStream: hold });
    const s = scheduler(db, m);
    const tick = s.tickOnce();
    // Wait until the stream is in flight.
    const deadline = Date.now() + 5000;
    while (db.goalRunStore.listByStatus("mote-test", "running").length === 0) {
      if (Date.now() > deadline) throw new Error("run never started");
      await new Promise((r) => setTimeout(r, 5));
    }
    const [run] = db.goalRunStore.listByStatus("mote-test", "running");
    s.stop();
    expect(db.goalRunStore.get(run!.run_id)!.status).toBe("failed");
    expect(db.goalRunStore.get(run!.run_id)!.note).toContain("stopped");
    release();
    await tick;
    // Still failed after the aborted tick unwinds; nothing blocks the goal.
    expect(db.goalRunStore.get(run!.run_id)!.status).toBe("failed");
    expect(db.goalRunStore.blockingRunForGoal("goal-001")).toBeNull();
    const s2 = scheduler(db, mockRuntime());
    s2.recoverInterruptedRuns();
    expect(db.goalRunStore.get(run!.run_id)!.status).toBe("failed");
  });
});

function hashArgsForTest(argsJson: string): string {
  return createHash("sha256").update(argsJson).digest("hex");
}
