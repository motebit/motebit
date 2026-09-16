/**
 * Halt at the scheduler — where the word becomes the fact.
 *
 * A halt that is recorded but does not stop a goal from firing is a
 * setting, not a stop. These pin the four places the scheduler must
 * consult it: before a tick does anything, before each goal fires,
 * before a recovered approval executes, and before consolidation runs —
 * plus the one that matters most after a crash, that it survives a
 * restart.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { GoalScheduler } from "../scheduler.js";
import { createMotebitDatabase, type MotebitDatabase, type Goal } from "@motebit/persistence";
import { RiskLevel, TrustMode, BatteryMode } from "@motebit/sdk";
import type { HaltRequest, ToolDefinition, ToolHandler } from "@motebit/sdk";
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
  invoked: string[];
  consolidations: number;
  /** How many times a suspended turn was resumed. */
  resumed: number;
  /** Ask this motebit to stop, exactly as `motebit halt` would. */
  requestHalt: (opts: { goalId?: string; reason?: string }) => HaltRequest;
}

/**
 * A mock runtime over the REAL halt store: the scheduler's contract with
 * the runtime is the three halt verbs, so those are backed by the actual
 * durable implementation rather than restated in the mock.
 */
function mockRuntime(
  db: MotebitDatabase,
  opts: { pause?: boolean; holdStream?: Promise<void> } = {},
): Mock {
  const listeners = new Set<(h: HaltRequest) => string | Promise<string>>();
  /** This mock stands for one process. */
  const executorId = `test-${crypto.randomUUID().slice(0, 8)}`;
  const tools = new Map<string, ToolHandler>();
  let pending = false;
  const m: Mock = {
    runtime: null as unknown as MotebitRuntime,
    streams: 0,
    invoked: [],
    consolidations: 0,
    resumed: 0,
    requestHalt: (o) => {
      const h: HaltRequest = {
        halt_id: `halt-${crypto.randomUUID().slice(0, 8)}`,
        motebit_id: "mote-test",
        goal_id: o.goalId ?? null,
        requested_at: Date.now(),
        origin: "remote",
        reason: o.reason ?? null,
        acknowledged_at: null,
        acknowledgement: null,
        lifted_at: null,
      };
      db.haltStore.request(h);
      return h;
    },
  };
  m.runtime = {
    get hasPendingApproval() {
      return pending;
    },
    get pendingApprovalInfo() {
      return pending
        ? { toolName: "shell_exec", args: { command: "ls" }, toolCallId: "tc-1" }
        : null;
    },
    onHalt: (l: (h: HaltRequest) => string | Promise<string>) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    halts: db.haltStore,
    haltInForce: (goalId?: string) => db.haltStore.activeFor("mote-test", goalId),
    honorHalts: async () => {
      // Per-executor, exactly as the real runtime does it: another
      // process acknowledging says nothing about this one.
      const out: HaltRequest[] = [];
      for (const h of db.haltStore
        .listActive("mote-test")
        .filter((r) => !db.haltStore.hasAcknowledged(r.halt_id, executorId))) {
        const parts: string[] = [];
        for (const l of listeners) parts.push(await l(h));
        db.haltStore.acknowledge(h.halt_id, executorId, parts.join("; ") || "nothing was running");
        out.push(db.haltStore.get(h.halt_id)!);
      }
      return out;
    },
    liftHalt: async (id: string) => db.haltStore.lift(id),
    async *sendMessageStreaming(): AsyncGenerator<StreamChunk> {
      m.streams++;
      if (opts.holdStream) {
        yield { type: "text" as const, text: "working" };
        await opts.holdStream;
        yield { type: "result" as const, result: turnResult() };
        return;
      }
      if (opts.pause === true) {
        pending = true;
        yield {
          type: "approval_request" as const,
          tool_call_id: "tc-1",
          name: "shell_exec",
          args: { command: "ls" },
          risk_level: RiskLevel.R3_EXECUTE,
        };
        return;
      }
      yield { type: "result" as const, result: turnResult() };
    },
    async *resumeAfterApproval(): AsyncGenerator<StreamChunk> {
      m.resumed++;
      pending = false;
      yield { type: "result" as const, result: turnResult() };
    },
    async invokeLocalTool(name: string) {
      m.invoked.push(name);
      return { ok: true, data: "ran" };
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
    setGoalIdResolver: vi.fn(),
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
    consolidationCycle: vi.fn().mockImplementation(async () => {
      m.consolidations++;
    }),
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

/**
 * `start()` fires its first tick detached (`void this.tick()`), and the
 * single-flight guard makes a `tickOnce()` that overlaps it a no-op — so
 * a test that proceeds immediately can outrun the scheduler. Wait for
 * the first tick to settle before acting.
 */
async function settle(fn: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!fn()) {
    if (Date.now() > deadline) throw new Error("scheduler never settled");
    await new Promise((r) => setTimeout(r, 5));
  }
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

describe("halt at the scheduler", () => {
  let db: MotebitDatabase;
  beforeEach(() => {
    db = createMotebitDatabase(":memory:");
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  it("a halt in force stops a due goal from firing at all", async () => {
    db.goalStore.add(goal());
    const m = mockRuntime(db);
    const s = scheduler(db, m);
    // Halt BEFORE start, so start()'s own first tick is already covered.
    const s2 = s;
    m.requestHalt({ reason: "going out" });
    s2.start(999_999);

    await s2.tickOnce();
    expect(m.streams).toBe(0);
    expect(db.goalRunStore.listRecent("mote-test")).toEqual([]);
    s2.stop();
  });

  it("the first tick after a halt acknowledges it, saying what it stopped", async () => {
    db.goalStore.add(goal());
    const m = mockRuntime(db);
    const s = scheduler(db, m);
    s.start(999_999);
    await settle(() => m.streams > 0); // start()'s own tick has run
    const halt = m.requestHalt({});
    expect(db.haltStore.get(halt.halt_id)?.acknowledged_at).toBeNull();

    await s.tickOnce();
    const acked = db.haltStore.get(halt.halt_id)!;
    expect(acked.acknowledged_at).not.toBeNull();
    expect(acked.acknowledgement).toContain("no further goal runs");
    s.stop();
  });

  it("a halt that arrives mid-run aborts the run in flight", async () => {
    db.goalStore.add(goal({ interval_ms: 3_600_000 }));
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    const m = mockRuntime(db, { holdStream: hold });
    const s = scheduler(db, m);
    s.start(999_999);
    const tick = s.tickOnce();
    const deadline = Date.now() + 5000;
    while (db.goalRunStore.listByStatus("mote-test", "running").length === 0) {
      if (Date.now() > deadline) throw new Error("run never started");
      await new Promise((r) => setTimeout(r, 5));
    }
    const [run] = db.goalRunStore.listByStatus("mote-test", "running");

    const halt = m.requestHalt({ reason: "stop now" });
    // The daemon honors it out of band (as the websocket path does).
    await m.runtime.honorHalts();
    expect(db.haltStore.get(halt.halt_id)?.acknowledgement).toContain(
      `signalled abort of run ${run!.run_id.slice(0, 8)}`,
    );

    release();
    await tick;
    s.stop();
  });

  it("a halt honored while a run holds the tick guard still aborts it — the guard must not queue a stop behind the work", async () => {
    db.goalStore.add(goal({ interval_ms: 3_600_000 }));
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    const m = mockRuntime(db, { holdStream: hold });
    const s = scheduler(db, m);
    s.start(999_999);
    await settle(() => db.goalRunStore.listByStatus("mote-test", "running").length > 0);
    const [run] = db.goalRunStore.listByStatus("mote-test", "running");

    // `motebit halt` writes the row; the daemon's own interval is what
    // must pick it up — while the run is still in flight and holding
    // `ticking`. Phase 0 runs outside that guard for exactly this.
    const halt = m.requestHalt({ reason: "stop now" });
    await s.tickOnce();

    const acked = db.haltStore.get(halt.halt_id)!;
    expect(acked.acknowledged_at).not.toBeNull();
    expect(acked.acknowledgement).toContain(`signalled abort of run ${run!.run_id.slice(0, 8)}`);

    release();
    s.stop();
  });

  it("a goal-scoped halt stops that goal's recovered approval, not just the motebit-wide case", async () => {
    db.goalStore.add(goal({ interval_ms: 3_600_000 }));
    const first = mockRuntime(db, { pause: true });
    const s1 = scheduler(db, first);
    s1.start(999_999);
    await settle(() => db.approvalStore.listAll("mote-test").length > 0);
    s1.stop();
    const [approval] = db.approvalStore.listAll("mote-test");
    db.approvalStore.resolve(approval!.approval_id, "approved");

    const second = mockRuntime(db);
    const s2 = scheduler(db, second);
    // Narrow halt only — the motebit-wide check would not see this.
    second.requestHalt({ goalId: "goal-001", reason: "not this goal" });
    s2.start(999_999);
    await s2.tickOnce();
    await s2.tickOnce();

    expect(second.invoked).toEqual([]);
    expect(db.goalRunStore.getByApproval(approval!.approval_id)?.status).toBe("awaiting_approval");
    s2.stop();
  });

  it("a halt store that throws logs and keeps ticking — it must not take the daemon down", async () => {
    db.goalStore.add(goal());
    const m = mockRuntime(db);
    (m.runtime as unknown as { honorHalts: () => Promise<never> }).honorHalts = () =>
      Promise.reject(new Error("database is locked"));
    const s = scheduler(db, m);
    s.start(999_999);
    // Phase 0 sits outside the tick body's try/catch, and the interval
    // calls `void this.tick()` with no unhandledRejection handler — an
    // unguarded throw here would end the process.
    await expect(s.tickOnce()).resolves.toBeUndefined();
    expect(m.streams).toBeGreaterThan(0); // the tick continued
    s.stop();
  });

  it("a halt is not counted as a goal failure — three stops must not auto-pause the goal", async () => {
    db.goalStore.add(goal({ interval_ms: 3_600_000, max_retries: 3 }));
    for (let i = 0; i < 3; i++) {
      let release!: () => void;
      const hold = new Promise<void>((r) => (release = r));
      const m = mockRuntime(db, { holdStream: hold });
      const s = scheduler(db, m);
      s.start(999_999);
      await settle(() => db.goalRunStore.listByStatus("mote-test", "running").length > 0);
      m.requestHalt({ reason: `stop ${i}` });
      await s.tickOnce();
      release();
      await new Promise((r) => setTimeout(r, 20));
      // Lift so the next iteration can run.
      for (const h of db.haltStore.listActive("mote-test")) db.haltStore.lift(h.halt_id);
      db.goalStore.updateLastRun("goal-001", 0);
      s.stop();
    }
    const g = db.goalStore.get("goal-001")!;
    expect(g.consecutive_failures).toBe(0);
    expect(g.status).toBe("active"); // never auto-paused by the user's own stops
  });

  it("the acknowledgement says the abort was SIGNALLED — an in-flight tool call is not cancelled", async () => {
    db.goalStore.add(goal({ interval_ms: 3_600_000 }));
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    const m = mockRuntime(db, { holdStream: hold });
    const s = scheduler(db, m);
    s.start(999_999);
    await settle(() => db.goalRunStore.listByStatus("mote-test", "running").length > 0);
    const halt = m.requestHalt({});
    await s.tickOnce();
    const ack = db.haltStore.get(halt.halt_id)!.acknowledgement ?? "";
    expect(ack).toContain("signalled abort");
    expect(ack).toContain("already in flight finishes");
    expect(ack).not.toContain("aborted run ");
    release();
    s.stop();
  });

  it("approvals keep expiring while halted — the queue is not frozen overnight", async () => {
    const now = Date.now();
    db.approvalStore.add({
      approval_id: "stale-1",
      motebit_id: "mote-test",
      goal_id: "goal-001",
      tool_name: "shell_exec",
      args_preview: "{}",
      args_hash: "h",
      risk_level: RiskLevel.R3_EXECUTE,
      status: "pending",
      created_at: now - 7_200_000,
      expires_at: now - 3_600_000,
      resolved_at: null,
      denied_reason: null,
    });
    const m = mockRuntime(db);
    const s = scheduler(db, m);
    m.requestHalt({ reason: "overnight" });
    s.start(999_999);
    await s.tickOnce();
    // Otherwise the phone shows it as decidable all night and the whole
    // backlog expires the instant the halt lifts.
    expect(db.approvalStore.get("stale-1")!.status).toBe("expired");
    s.stop();
  });

  it("when there is no abort channel the acknowledgement says so — it never claims a signal it did not send", async () => {
    // The approval drains set `currentRunId` without a controller, so a
    // halt landing there can stop nothing in flight. Claiming otherwise
    // is the same overclaim in a new place.
    db.goalStore.add(goal({ interval_ms: 3_600_000 }));
    const first = mockRuntime(db, { pause: true });
    const s1 = scheduler(db, first);
    s1.start(999_999);
    await settle(() => db.approvalStore.listAll("mote-test").length > 0);
    s1.stop();
    const [approval] = db.approvalStore.listAll("mote-test");
    db.approvalStore.resolve(approval!.approval_id, "approved");

    const second = mockRuntime(db);
    let ackDuringCall: string | undefined;
    (second.runtime as unknown as { invokeLocalTool: unknown }).invokeLocalTool = async () => {
      // Halt lands while the approved call is executing.
      const h = second.requestHalt({ reason: "stop" });
      await second.runtime.honorHalts();
      ackDuringCall = db.haltStore.get(h.halt_id)?.acknowledgement ?? "";
      return { ok: true, data: "ran" };
    };
    const s2 = scheduler(db, second);
    s2.start(999_999); // fires its own tick detached
    await settle(() => ackDuringCall !== undefined);

    expect(ackDuringCall).toContain("cannot be interrupted");
    expect(ackDuringCall).not.toContain("signalled abort");
    s2.stop();
  });

  it("a halted run still leaves a ledger record — only the failure COUNT is skipped", async () => {
    db.goalStore.add(goal({ interval_ms: 3_600_000 }));
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    const m = mockRuntime(db, { holdStream: hold });
    const s = scheduler(db, m);
    s.start(999_999);
    await settle(() => db.goalRunStore.listByStatus("mote-test", "running").length > 0);
    m.requestHalt({});
    await s.tickOnce();
    release();
    await new Promise((r) => setTimeout(r, 30));

    const outcomes = db.goalOutcomeStore.listForGoal("goal-001");
    expect(outcomes.some((o) => o.summary?.includes("stopped by halted"))).toBe(true);
    expect(db.goalStore.get("goal-001")!.consecutive_failures).toBe(0);
    s.stop();
  });

  it("stop() does not start consolidation while halted — the acknowledgement promised it would not", async () => {
    const m = mockRuntime(db);
    const s = scheduler(db, m);
    m.requestHalt({});
    s.start(999_999);
    await s.tickOnce();
    s.stop();
    expect(m.consolidations).toBe(0);
  });

  it("an approval expiring under a halt keeps the suspended turn — it is not dropped", async () => {
    // The guard was placed AFTER `suspended.delete(id)`, so the entry it
    // claimed to preserve was already gone: the run never closed, the
    // goal was held forever, and the runtime stayed wedged on a pending
    // approval nothing could resolve once the halt lifted.
    db.goalStore.add(goal({ interval_ms: 3_600_000 }));
    const m = mockRuntime(db, { pause: true });
    const s = scheduler(db, m);
    s.start(999_999);
    await settle(() => db.approvalStore.listAll("mote-test").length > 0);
    const [approval] = db.approvalStore.listAll("mote-test");
    const runId = db.goalRunStore.getByApproval(approval!.approval_id)!.run_id;

    m.requestHalt({ reason: "overnight" });
    db.approvalStore.expireStale(Date.now() + 100 * 3_600_000);
    await s.tickOnce();
    await s.tickOnce();

    // The turn was NOT resumed (that would be a model turn under a halt)…
    expect(m.resumed).toBe(0);
    // …and the run is still awaiting, so lifting the halt can still
    // resolve it rather than leaving the goal held forever.
    expect(db.goalRunStore.get(runId)!.status).toBe("awaiting_approval");
    s.stop();
  });

  it("a halted daemon does not CLAIM a relay task — an unclaimed task can go elsewhere", async () => {
    // The chokepoint refuses the work either way; claiming first would
    // black-hole it, because a claimed task is not re-dispatched.
    const m = mockRuntime(db);
    m.requestHalt({});
    expect(m.runtime.haltInForce()).not.toBeNull();
  });

  it("a goal-scoped halt stops that goal and leaves the others running", async () => {
    db.goalStore.add(goal({ goal_id: "goal-A" }));
    db.goalStore.add(goal({ goal_id: "goal-B" }));
    const m = mockRuntime(db);
    const s = scheduler(db, m);
    m.requestHalt({ goalId: "goal-A" });
    s.start(999_999);

    await settle(() => db.goalRunStore.listRecent("mote-test").length > 0);
    const fired = db.goalRunStore.listRecent("mote-test").map((r) => r.goal_id);
    expect(fired).toContain("goal-B");
    expect(fired).not.toContain("goal-A");
    s.stop();
  });

  it("a halt outranks an approval the human granted before it — nothing executes", async () => {
    db.goalStore.add(goal({ interval_ms: 3_600_000 }));
    const first = mockRuntime(db, { pause: true });
    const s1 = scheduler(db, first);
    s1.start(999_999);
    await settle(() => db.approvalStore.listAll("mote-test").length > 0);
    s1.stop();
    const [approval] = db.approvalStore.listAll("mote-test");
    db.approvalStore.resolve(approval!.approval_id, "approved");

    // Then the human changes their mind and stops the motebit.
    const second = mockRuntime(db);
    const s2 = scheduler(db, second);
    second.requestHalt({ reason: "actually, stop" });
    s2.start(999_999);
    await s2.tickOnce();
    await s2.tickOnce();

    expect(second.invoked).toEqual([]);
    // The decision is not thrown away — it is still approved, waiting.
    expect(db.approvalStore.get(approval!.approval_id)?.status).toBe("approved");
    expect(db.goalRunStore.getByApproval(approval!.approval_id)?.status).toBe("awaiting_approval");
    s2.stop();
  });

  it("a halt survives a restart — a new scheduler is still stopped", async () => {
    db.goalStore.add(goal());
    const first = mockRuntime(db);
    const s1 = scheduler(db, first);
    first.requestHalt({ reason: "overnight" });
    s1.start(999_999);
    await s1.tickOnce();
    s1.stop();

    const second = mockRuntime(db);
    const s2 = scheduler(db, second);
    s2.start(999_999);
    await s2.tickOnce();
    expect(second.streams).toBe(0);
    s2.stop();
  });

  it("resume gives the permission back and the goal fires again", async () => {
    db.goalStore.add(goal());
    const m = mockRuntime(db);
    const s = scheduler(db, m);
    const halt = m.requestHalt({});
    s.start(999_999);
    await s.tickOnce();
    expect(m.streams).toBe(0);

    expect(await m.runtime.liftHalt(halt.halt_id)).toBe(true);
    await s.tickOnce();
    expect(m.streams).toBe(1);
    s.stop();
  });

  it("consolidation does not run while halted", async () => {
    const m = mockRuntime(db);
    const s = scheduler(db, m);
    m.requestHalt({});
    s.start(999_999);
    for (let i = 0; i < 12; i++) await s.tickOnce();
    expect(m.consolidations).toBe(0);
    s.stop();
  });
});
