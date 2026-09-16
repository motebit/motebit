import { describe, it, expect, beforeEach, vi } from "vitest";
import { GoalScheduler } from "../scheduler.js";
import { createMotebitDatabase, type MotebitDatabase, type Goal } from "@motebit/persistence";
import { RiskLevel, TrustMode, BatteryMode } from "@motebit/sdk";
import type { MotebitRuntime, StreamChunk } from "@motebit/runtime";
import type { TurnResult } from "@motebit/ai-core";

/**
 * What a completed run LEAVES BEHIND, and whether it is true.
 *
 * Six review rounds found defects in this cluster, all of the same
 * family: a record that says more, or less, than what happened. A
 * refusal stored as completed work; a signature covering the tail of a
 * run while presented as the whole; an error handler overwriting the
 * artifact it was reporting on. None of those were caught by the
 * approval-lifecycle tests, because those assert the lifecycle rather
 * than what it writes down.
 */
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

function mockRuntime(opts: { textBeforePause?: string; textAfterResume?: string } = {}) {
  let pending = false;
  const signed: string[] = [];
  const runtime = {
    motebitId: "mote-test",
    async *sendMessageStreaming(): AsyncGenerator<StreamChunk> {
      pending = true;
      if (opts.textBeforePause != null) {
        yield { type: "text" as const, text: opts.textBeforePause };
      }
      yield {
        type: "approval_request" as const,
        tool_call_id: "tc-1",
        name: "shell_exec",
        args: { command: "ls" },
        risk_level: RiskLevel.R2_WRITE,
      };
    },
    async *resumeAfterApproval(_approved: boolean): AsyncGenerator<StreamChunk> {
      pending = false;
      if (opts.textAfterResume != null) {
        yield { type: "text" as const, text: opts.textAfterResume };
      }
      yield { type: "result" as const, result: turnResult() };
    },
    get hasPendingApproval() {
      return pending;
    },
    get pendingApprovalInfo() {
      return pending ? { toolName: "shell_exec", args: {}, toolCallId: "tc-1" } : null;
    },
    /** Records what was handed to the signer, so a test can see its extent. */
    signGoalArtifact: vi.fn(async (content: string) => {
      signed.push(content);
      return { kind: "content-artifact", signature: "sig" };
    }),
    getToolRegistry: () => ({
      register: vi.fn(),
      replace: vi.fn(),
      unregister: vi.fn(),
      list: () => [],
      execute: vi.fn(),
    }),
    events: { getLatestClock: vi.fn().mockResolvedValue(0), appendWithClock: vi.fn() },
    goals: {
      executed: vi.fn(),
      completed: vi.fn(),
      progress: vi.fn(),
      failed: vi.fn(),
    },
    setGoalStatusResolver: vi.fn(),
    setGoalIdResolver: vi.fn(),
    onHalt: vi.fn(() => () => {}),
    haltInForce: () => null,
    honorHalts: vi.fn(async () => []),
    consolidationCycle: vi.fn(async () => ({})),
    presence: { canStartCycle: () => false },
    policy: { createTurnContext: vi.fn() },
  } as unknown as MotebitRuntime;
  return { runtime, signed };
}

function goal(over: Partial<Goal> = {}): Goal {
  return {
    goal_id: "goal-001",
    motebit_id: "mote-test",
    prompt: "check system health",
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
    ...over,
  };
}

function scheduler(db: MotebitDatabase, runtime: MotebitRuntime) {
  const s = new GoalScheduler(
    runtime,
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

describe("what a completed run leaves behind", () => {
  let db: MotebitDatabase;
  beforeEach(() => {
    db = createMotebitDatabase(":memory:");
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  it("a DENIED action is not recorded as completed work", async () => {
    // These rows are read back into the next run's prompt. Recorded as
    // `completed`, a refusal would teach the agent that work its owner
    // refused was work it finished.
    const { runtime } = mockRuntime({ textAfterResume: "understood, stopping" });
    db.goalStore.add(goal());
    const s = scheduler(db, runtime);
    await s.tickOnce();

    const [approval] = db.approvalStore.listAll("mote-test");
    expect(approval).toBeDefined();
    db.approvalStore.resolve(approval!.approval_id, "denied", "not this time");
    await s.tickOnce();

    const outcomes = db.goalOutcomeStore.listForGoal("goal-001", 10);
    const decided = outcomes.find((o) => o.status !== "suspended");
    expect(decided?.status).toBe("partial");
    expect(decided?.status).not.toBe("completed");
    expect(decided?.error_message).toMatch(/denied by its owner/i);
  });

  it("the signed artifact covers the WHOLE run, not just the part after the pause", async () => {
    // A resumed turn's stream carries only the continuation. Signing
    // that alone, and presenting it as the result, is a signature over
    // part of a thing offered as the thing.
    const { runtime, signed } = mockRuntime({
      textBeforePause: "Reviewed three filings. ",
      textAfterResume: "Summary complete.",
    });
    db.goalStore.add(goal());
    const s = scheduler(db, runtime);
    await s.tickOnce();

    const [approval] = db.approvalStore.listAll("mote-test");
    db.approvalStore.resolve(approval!.approval_id, "approved");
    await s.tickOnce();

    expect(signed).toHaveLength(1);
    expect(signed[0]).toBe("Reviewed three filings. Summary complete.");

    const outcomes = db.goalOutcomeStore.listForGoal("goal-001", 10);
    const completed = outcomes.find((o) => o.status === "completed");
    expect(completed?.response_full).toBe("Reviewed three filings. Summary complete.");
    expect(completed?.signed_manifest).not.toBeUndefined();
  });

  it("every outcome links to the run that produced it", async () => {
    // Live paths key the outcome by the run id and recovery paths mint a
    // fresh one, so the link has to be a field or a reader finds half.
    const { runtime } = mockRuntime({ textAfterResume: "done" });
    db.goalStore.add(goal());
    const s = scheduler(db, runtime);
    await s.tickOnce();

    const [approval] = db.approvalStore.listAll("mote-test");
    db.approvalStore.resolve(approval!.approval_id, "approved");
    await s.tickOnce();

    const [run] = db.goalRunStore.listForGoal("goal-001", 10);
    expect(run).toBeDefined();
    const byRun = db.goalOutcomeStore.listForRun(run!.run_id);
    expect(byRun.length).toBeGreaterThan(0);
    expect(byRun.every((o) => o.run_id === run!.run_id)).toBe(true);
  });

  it("an empty result is not signed", async () => {
    // A signature over zero bytes rendered as "signed" offers a proof
    // with nothing behind it.
    const { runtime, signed } = mockRuntime({});
    db.goalStore.add(goal());
    const s = scheduler(db, runtime);
    await s.tickOnce();

    const [approval] = db.approvalStore.listAll("mote-test");
    db.approvalStore.resolve(approval!.approval_id, "approved");
    await s.tickOnce();

    expect(signed).toEqual([]);
    const outcomes = db.goalOutcomeStore.listForGoal("goal-001", 10);
    const completed = outcomes.find((o) => o.status === "completed");
    expect(completed?.signed_manifest).toBeUndefined();
  });
});
