import { describe, it, expect, beforeEach, vi } from "vitest";
import { GoalScheduler } from "../scheduler.js";
import { createMotebitDatabase, type MotebitDatabase, type Goal } from "@motebit/persistence";
import { EventType, RiskLevel } from "@motebit/sdk";
import type { ToolDefinition, ToolHandler } from "@motebit/sdk";
import type { MotebitRuntime, StreamChunk } from "@motebit/runtime";

interface MockRuntimeResult {
  runtime: MotebitRuntime;
  registeredTools: Map<string, ToolHandler>;
  eventsAppended: Array<{ event_type: string; payload: Record<string, unknown> }>;
}

function createMockRuntime(opts: {
  yieldApproval?: boolean;
  approvalToolName?: string;
  approvalArgs?: Record<string, unknown>;
  onStream?: (registeredTools: Map<string, ToolHandler>) => Promise<void>;
} = {}): MockRuntimeResult {
  let _hasPending = false;
  const registeredTools = new Map<string, ToolHandler>();
  const eventsAppended: Array<{ event_type: string; payload: Record<string, unknown> }> = [];

  const runtime = {
    get hasPendingApproval() {
      return _hasPending;
    },
    get pendingApprovalInfo() {
      return _hasPending ? { toolName: opts.approvalToolName ?? "shell_exec", args: opts.approvalArgs ?? {} } : null;
    },
    async *sendMessageStreaming(_text: string): AsyncGenerator<StreamChunk> {
      if (opts.yieldApproval) {
        _hasPending = true;
        yield {
          type: "approval_request" as const,
          tool_call_id: "tc-1",
          name: opts.approvalToolName ?? "shell_exec",
          args: opts.approvalArgs ?? { command: "ls" },
          risk_level: RiskLevel.R2_WRITE,
        };
        return;
      }
      if (opts.onStream) {
        await opts.onStream(registeredTools);
      }
      yield { type: "text" as const, text: "done" };
      yield { type: "result" as const, result: { memoriesFormed: [] } as any };
    },
    async *resumeAfterApproval(approved: boolean): AsyncGenerator<StreamChunk> {
      _hasPending = false;
      if (approved) {
        yield { type: "tool_status" as const, name: "shell_exec", status: "calling" as const };
        yield { type: "tool_status" as const, name: "shell_exec", status: "done" as const, result: "output" };
      }
      yield { type: "result" as const, result: { memoriesFormed: [] } as any };
    },
    events: {
      getLatestClock: vi.fn().mockResolvedValue(0),
      append: vi.fn().mockImplementation(async (entry: any) => {
        eventsAppended.push({ event_type: entry.event_type, payload: entry.payload });
      }),
    },
    getToolRegistry: vi.fn().mockReturnValue({
      register: vi.fn().mockImplementation((def: ToolDefinition, handler: ToolHandler) => {
        registeredTools.set(def.name, handler);
      }),
    }),
    stop: vi.fn(),
    housekeeping: vi.fn().mockResolvedValue(undefined),
  } as unknown as MotebitRuntime;

  return { runtime, registeredTools, eventsAppended };
}

function makeGoal(overrides: Partial<Goal> = {}): Goal {
  return {
    goal_id: "goal-001",
    motebit_id: "mote-test",
    prompt: "check system health",
    interval_ms: 0, // always due
    last_run_at: null,
    enabled: true,
    created_at: Date.now(),
    mode: "recurring",
    status: "active",
    parent_goal_id: null,
    max_retries: 3,
    consecutive_failures: 0,
    ...overrides,
  };
}

describe("GoalScheduler — approval lifecycle", () => {
  let moteDb: MotebitDatabase;

  beforeEach(() => {
    moteDb = createMotebitDatabase(":memory:");
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  it("persists approval and suspends instead of denying", async () => {
    const { runtime } = createMockRuntime({ yieldApproval: true });
    moteDb.goalStore.add(makeGoal());

    const scheduler = new GoalScheduler(
      runtime, moteDb.goalStore, moteDb.approvalStore, moteDb.goalOutcomeStore,
      "mote-test", RiskLevel.R3_EXECUTE,
    );
    scheduler.registerGoalTools();
    await scheduler.tickOnce();

    // Approval should be persisted
    const all = moteDb.approvalStore.listAll("mote-test");
    expect(all).toHaveLength(1);
    expect(all[0]!.tool_name).toBe("shell_exec");
    expect(all[0]!.risk_level).toBe(RiskLevel.R2_WRITE);

    // Goal's last_run_at should NOT be updated (turn was suspended)
    const goals = moteDb.goalStore.list("mote-test");
    expect(goals[0]!.last_run_at).toBeNull();
  });

  it("stop() marks pending approvals as denied with daemon_shutdown", async () => {
    const { runtime } = createMockRuntime({ yieldApproval: true });
    moteDb.goalStore.add(makeGoal());

    const scheduler = new GoalScheduler(
      runtime, moteDb.goalStore, moteDb.approvalStore, moteDb.goalOutcomeStore,
      "mote-test", RiskLevel.R3_EXECUTE,
    );
    scheduler.registerGoalTools();
    await scheduler.tickOnce();

    // Should have a pending approval
    const all = moteDb.approvalStore.listAll("mote-test");
    expect(all).toHaveLength(1);
    const approvalId = all[0]!.approval_id;

    scheduler.stop();

    const item = moteDb.approvalStore.get(approvalId);
    expect(item!.status).toBe("denied");
    expect(item!.denied_reason).toBe("daemon_shutdown");
  });

  it("expireStale expires old approvals via store", () => {
    const now = Date.now();
    moteDb.approvalStore.add({
      approval_id: "old-1",
      motebit_id: "mote-test",
      goal_id: "goal-001",
      tool_name: "shell_exec",
      args_preview: "{}",
      args_hash: "abc",
      risk_level: 3,
      status: "pending",
      created_at: now - 7_200_000,
      expires_at: now - 3_600_000,
      resolved_at: null,
      denied_reason: null,
    });

    const count = moteDb.approvalStore.expireStale(now);
    expect(count).toBe(1);

    const item = moteDb.approvalStore.get("old-1");
    expect(item!.status).toBe("expired");
  });

  it("approval store persists args_hash for deterministic fingerprinting", () => {
    const now = Date.now();
    const expectedHash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    moteDb.approvalStore.add({
      approval_id: "hash-test",
      motebit_id: "mote-test",
      goal_id: "goal-001",
      tool_name: "write_file",
      args_preview: '{"path":"/tmp/test"}',
      args_hash: expectedHash,
      risk_level: 2,
      status: "pending",
      created_at: now,
      expires_at: now + 3_600_000,
      resolved_at: null,
      denied_reason: null,
    });

    const item = moteDb.approvalStore.get("hash-test");
    expect(item!.args_hash).toBe(expectedHash);
  });

  it("completes goals without approval when no approval_request", async () => {
    const { runtime } = createMockRuntime({ yieldApproval: false });
    moteDb.goalStore.add(makeGoal());

    const scheduler = new GoalScheduler(
      runtime, moteDb.goalStore, moteDb.approvalStore, moteDb.goalOutcomeStore,
      "mote-test", RiskLevel.R3_EXECUTE,
    );
    scheduler.registerGoalTools();
    await scheduler.tickOnce();

    // No approvals should be created
    const approvals = moteDb.approvalStore.listAll("mote-test");
    expect(approvals).toHaveLength(0);

    // Goal should have last_run_at updated
    const goals = moteDb.goalStore.list("mote-test");
    expect(goals[0]!.last_run_at).not.toBeNull();
  });
});

describe("GoalScheduler — report_progress invariant", () => {
  let moteDb: MotebitDatabase;

  beforeEach(() => {
    moteDb = createMotebitDatabase(":memory:");
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  it("report_progress rejects when no goal active and does not mutate outcomes", async () => {
    const { runtime, registeredTools } = createMockRuntime();
    moteDb.goalStore.add(makeGoal());

    const scheduler = new GoalScheduler(
      runtime, moteDb.goalStore, moteDb.approvalStore, moteDb.goalOutcomeStore,
      "mote-test", RiskLevel.R3_EXECUTE,
    );

    // Register tools, then tick to run the goal and create a baseline outcome
    scheduler.registerGoalTools();
    await scheduler.tickOnce();

    const baselineOutcomes = moteDb.goalOutcomeStore.listForGoal("goal-001").length;
    expect(baselineOutcomes).toBe(1);

    // Call report_progress outside of goal execution — should be guarded
    const reportProgress = registeredTools.get("report_progress")!;
    expect(reportProgress).toBeDefined();

    const guardResult = await reportProgress({ note: "test note" });
    expect(guardResult.ok).toBe(false);
    expect(guardResult.error).toContain("No active goal context");

    // Outcome count unchanged
    const afterOutcomes = moteDb.goalOutcomeStore.listForGoal("goal-001").length;
    expect(afterOutcomes).toBe(baselineOutcomes);
  });

  it("report_progress emits GoalProgress event during execution, not an outcome row", async () => {
    // Mock runtime that calls report_progress mid-stream (simulating agent tool call)
    const { runtime, eventsAppended } = createMockRuntime({
      onStream: async (tools) => {
        const handler = tools.get("report_progress");
        if (handler) {
          await handler({ note: "Found 3 new emails" });
        }
      },
    });

    moteDb.goalStore.add(makeGoal());

    const scheduler = new GoalScheduler(
      runtime, moteDb.goalStore, moteDb.approvalStore, moteDb.goalOutcomeStore,
      "mote-test", RiskLevel.R3_EXECUTE,
    );
    scheduler.registerGoalTools();
    await scheduler.tickOnce();

    // GoalProgress event was emitted to the event log
    const progressEvents = eventsAppended.filter((e) => e.event_type === EventType.GoalProgress);
    expect(progressEvents).toHaveLength(1);
    expect(progressEvents[0]!.payload.note).toBe("Found 3 new emails");
    expect(progressEvents[0]!.payload.goal_id).toBe("goal-001");

    // goal_outcomes has exactly 1 row — the run completion, not the progress note
    const outcomes = moteDb.goalOutcomeStore.listForGoal("goal-001");
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.status).toBe("completed");
  });
});

describe("GoalScheduler — orphan approval cleanup on start", () => {
  let moteDb: MotebitDatabase;

  beforeEach(() => {
    moteDb = createMotebitDatabase(":memory:");
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  it("start() denies pending approvals left over from a previous run", () => {
    const now = Date.now();
    moteDb.approvalStore.add({
      approval_id: "orphan-1",
      motebit_id: "mote-test",
      goal_id: "goal-001",
      tool_name: "shell_exec",
      args_preview: "{}",
      args_hash: "abc",
      risk_level: 3,
      status: "pending",
      created_at: now - 120_000,
      expires_at: now + 3_600_000,
      resolved_at: null,
      denied_reason: null,
    });
    moteDb.approvalStore.add({
      approval_id: "orphan-2",
      motebit_id: "mote-test",
      goal_id: "goal-002",
      tool_name: "write_file",
      args_preview: "{}",
      args_hash: "def",
      risk_level: 2,
      status: "pending",
      created_at: now - 60_000,
      expires_at: now + 3_600_000,
      resolved_at: null,
      denied_reason: null,
    });

    const { runtime } = createMockRuntime();
    const scheduler = new GoalScheduler(
      runtime, moteDb.goalStore, moteDb.approvalStore, moteDb.goalOutcomeStore,
      "mote-test", RiskLevel.R3_EXECUTE,
    );
    // start() triggers cleanup before first tick
    scheduler.start(999_999); // long interval so tick doesn't re-fire
    scheduler.stop();

    const a1 = moteDb.approvalStore.get("orphan-1");
    expect(a1!.status).toBe("denied");
    expect(a1!.denied_reason).toBe("daemon_restart");

    const a2 = moteDb.approvalStore.get("orphan-2");
    expect(a2!.status).toBe("denied");
    expect(a2!.denied_reason).toBe("daemon_restart");
  });

  it("start() leaves already-resolved approvals untouched", () => {
    const now = Date.now();
    moteDb.approvalStore.add({
      approval_id: "resolved-1",
      motebit_id: "mote-test",
      goal_id: "goal-001",
      tool_name: "shell_exec",
      args_preview: "{}",
      args_hash: "abc",
      risk_level: 3,
      status: "approved",
      created_at: now - 120_000,
      expires_at: now + 3_600_000,
      resolved_at: now - 60_000,
      denied_reason: null,
    });

    const { runtime } = createMockRuntime();
    const scheduler = new GoalScheduler(
      runtime, moteDb.goalStore, moteDb.approvalStore, moteDb.goalOutcomeStore,
      "mote-test", RiskLevel.R3_EXECUTE,
    );
    scheduler.start(999_999);
    scheduler.stop();

    const a = moteDb.approvalStore.get("resolved-1");
    expect(a!.status).toBe("approved");
  });
});
