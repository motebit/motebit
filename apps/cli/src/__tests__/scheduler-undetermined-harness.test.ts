/**
 * #890 harness — the CLI goal scheduler never re-fires a goal into a second
 * paid attempt while the first attempt's outcome is unknown.
 *
 * Exhaustive over:
 *
 *   mode            TURN — the goal's model hires through `delegate_to_agent`;
 *                   the outcome lands in the durable paid-intent ledger (#874).
 *                   PLAN — a plan step is delegated through the plan engine.
 *   first outcome   success | failure | undetermined | crash mid-submit
 *                   (PLAN adds: crash with / without the task id persisted)
 *   resolution      the unknown outcome is resolved from a durable fact —
 *                   TURN: the owner retrieves the signed result (`/result`);
 *                   PLAN: the relay's receipt becomes readable (completed or
 *                   failed) — before tick 2, 3, 4, or never
 *   restart mask    a new process (fresh scheduler, engine, ledger session,
 *                   restart recovery) before any tick
 *
 * Four ticks per case, the goal due on every tick. The oracle:
 *
 *   SAFETY    no hire / submission while an earlier one's outcome is unknown;
 *   COUNTING  an unknown outcome never counts toward `consecutive_failures`
 *             and never auto-pauses the goal;
 *   LIVENESS  once the outcome is resolved, the goal runs again (TURN: a new
 *             hire on the next tick; PLAN: the held step settles from the
 *             receipt on the next tick, without a new submission).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@motebit/memory-graph", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@motebit/memory-graph")>();
  return { ...actual, embedText: vi.fn().mockRejectedValue(new Error("no embedder in tests")) };
});

import { GoalScheduler } from "../scheduler.js";
import { createMotebitDatabase, type MotebitDatabase } from "@motebit/persistence";
import { RiskLevel } from "@motebit/sdk";
import type {
  DelegatedStepResult,
  ExecutionReceipt,
  PlanStep,
  MotebitId,
  DeviceId,
  ToolDefinition,
  ToolHandler,
} from "@motebit/sdk";
import { PaidIntentLedger, InMemoryPaidIntentStore } from "@motebit/runtime";
import type { MotebitRuntime, StreamChunk } from "@motebit/runtime";
import { PlanEngine, DelegationUndeterminedError, PlanDriverLocks } from "@motebit/planner";
import type { StepDelegationAdapter } from "@motebit/planner";

const MOTE = "mote-890";
const GOAL = "goal-890";
const TICKS = 4;

type TurnOutcome = "success" | "failure" | "undetermined" | "crash";
type PlanOutcome = "success" | "failure" | "undetermined" | "crash_task" | "crash_no_task";
type Truth = "completes" | "fails";

/** A hire/submission, and whether the delegator knows how it ended. */
interface Hire {
  id: string;
  known: boolean;
}

interface World {
  db: MotebitDatabase;
  store: InMemoryPaidIntentStore;
  hires: Hire[];
  violations: string[];
  tick: number;
  /** A crash is in progress: the current process must be abandoned. */
  crashed: boolean;
  /** Settles when the current process crashes. */
  crash: Promise<void>;
  signalCrash: () => void;
}

function armCrash(w: World): void {
  w.crashed = false;
  w.crash = new Promise<void>((r) => {
    w.signalCrash = () => {
      w.crashed = true;
      r();
    };
  });
}

function checkSafety(w: World): void {
  const unknown = w.hires.filter((h) => !h.known);
  if (unknown.length > 0) {
    w.violations.push(
      `tick ${w.tick}: hired again while ${unknown.map((h) => h.id).join(",")} unknown`,
    );
  }
}

function receipt(taskId: string, status: "completed" | "failed"): ExecutionReceipt {
  return {
    task_id: taskId,
    motebit_id: "worker" as MotebitId,
    device_id: "dev" as DeviceId,
    submitted_at: 1,
    completed_at: 2,
    status,
    result: status === "completed" ? "the work" : "could not do it",
    tools_used: [],
    memories_formed: 0,
    prompt_hash: "p",
    result_hash: "r",
    suite: "motebit-jcs-ed25519-b64-v1",
    signature: "sig",
  };
}

/** One process's runtime. `turn` is what the goal's model does on a turn. */
function mockRuntime(
  ledger: PaidIntentLedger,
  turn: () => AsyncGenerator<StreamChunk>,
): MotebitRuntime {
  const tools = new Map<string, ToolHandler>();
  return {
    hasPendingApproval: false,
    pendingApprovalInfo: null,
    sendMessageStreaming: () => turn(),
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
    onHalt: () => () => undefined,
    halts: null,
    haltInForce: () => null,
    honorHalts: async () => [],
    liftHalt: async () => false,
    setGoalIdResolver: vi.fn(),
    setGoalStatusResolver: vi.fn(),
    signGoalArtifact: vi.fn().mockResolvedValue(null),
    outstandingPaidResults: () => ledger.outstanding(),
    getLoopDeps: () => ({
      provider: {
        generate: vi.fn().mockResolvedValue({
          text: JSON.stringify({
            title: "Hire for it",
            steps: [
              {
                description: "remote work",
                prompt: "do it",
                required_capabilities: ["stdio_mcp"],
              },
            ],
          }),
        }),
      },
    }),
    getToolRegistry: vi.fn().mockReturnValue({
      register: (d: ToolDefinition, h: ToolHandler) => tools.set(d.name, h),
      replace: (d: ToolDefinition, h: ToolHandler) => tools.set(d.name, h),
      unregister: (name: string) => tools.delete(name),
      list: () => [],
    }),
    stop: vi.fn(),
    consolidationCycle: vi.fn().mockResolvedValue(undefined),
  } as unknown as MotebitRuntime;
}

function newScheduler(w: World, runtime: MotebitRuntime): GoalScheduler {
  const s = new GoalScheduler(
    runtime,
    w.db.goalStore,
    w.db.approvalStore,
    w.db.goalOutcomeStore,
    w.db.goalRunStore,
    w.db.toolAuditSink,
    MOTE,
    RiskLevel.R3_EXECUTE,
  );
  s.recoverInterruptedRuns();
  return s;
}

function newWorld(): World {
  const db = createMotebitDatabase(":memory:");
  db.goalStore.add({
    goal_id: GOAL,
    motebit_id: MOTE,
    prompt: "buy the report",
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
  });
  const w: World = {
    db,
    store: new InMemoryPaidIntentStore(),
    hires: [],
    violations: [],
    tick: 0,
    crashed: false,
    crash: Promise.resolve(),
    signalCrash: () => undefined,
  };
  armCrash(w);
  return w;
}

/**
 * Run one tick; a crash abandons the tick with its process (the tick's
 * promise never settles), as a SIGKILL would.
 */
async function runTick(w: World, s: GoalScheduler): Promise<void> {
  await Promise.race([s.tickOnce(), w.crash]);
}

function runStatuses(w: World): string[] {
  return w.db.goalRunStore
    .listForGoal(GOAL, 50)
    .sort((a, b) => a.started_at - b.started_at)
    .map((r) => r.status);
}

interface CaseResult {
  violations: string[];
  failures: number;
  status: string;
  hires: number;
  firedTicks: number[];
  settledAt: number | null;
  /** The goal's run statuses, oldest first. */
  runs: string[];
}

async function runTurnCase(
  first: TurnOutcome,
  resolveAt: number | null,
  restartMask: number,
): Promise<CaseResult> {
  const w = newWorld();
  const firedTicks: number[] = [];
  let ledger = new PaidIntentLedger(w.store, MOTE);
  const turn = async function* (): AsyncGenerator<StreamChunk> {
    firedTicks.push(w.tick);
    checkSafety(w);
    const n = w.hires.length;
    const id = `task-${n}`;
    const hire: Hire = { id, known: false };
    w.hires.push(hire);
    const entry = {
      workerMotebitId: n === 0 ? "worker-a" : "worker-b",
      capability: "research",
      taskId: id,
      txHash: `tx-${n}`,
      paidMicro: 1000,
      feeMicro: 50,
      recordedAt: Date.now(),
    };
    const kind: TurnOutcome = n === 0 ? first : "success";
    if (kind === "success") {
      ledger.recordInFlight(entry);
      ledger.resolve(id);
      hire.known = true;
    } else if (kind === "failure") {
      hire.known = true; // refused before payment, or a signed failed receipt came back
    } else if (kind === "undetermined") {
      ledger.recordSettledUnretrieved(entry);
    } else {
      ledger.recordInFlight(entry);
      w.signalCrash();
      await new Promise<void>(() => {});
    }
    yield { type: "text" as const, text: "done" };
  };
  let s = newScheduler(w, mockRuntime(ledger, turn));

  for (let t = 1; t <= TICKS; t++) {
    w.tick = t;
    const restart = w.crashed || (t > 1 && (restartMask & (1 << (t - 2))) !== 0);
    if (restart) {
      armCrash(w);
      ledger = new PaidIntentLedger(w.store, MOTE);
      s = newScheduler(w, mockRuntime(ledger, turn));
    }
    // The owner retrieves the signed result (`/result`) before this tick.
    if (resolveAt != null && t >= resolveAt) {
      for (const h of w.hires) {
        if (!h.known) {
          ledger.resolve(h.id);
          h.known = true;
        }
      }
    }
    await runTick(w, s);
  }
  const g = w.db.goalStore.get(GOAL)!;
  return {
    violations: w.violations,
    failures: g.consecutive_failures,
    status: g.status,
    hires: w.hires.length,
    firedTicks,
    settledAt: null,
    runs: runStatuses(w),
  };
}

class FakeRelay implements StepDelegationAdapter {
  constructor(
    private readonly w: World,
    private readonly first: PlanOutcome,
    private readonly truth: Truth,
    private readonly resolveAt: number | null,
  ) {}
  settledAt: number | null = null;

  delegateStep(
    step: PlanStep,
    _t: number,
    onTaskSubmitted?: (taskId: string) => void,
  ): Promise<DelegatedStepResult> {
    checkSafety(this.w);
    const n = this.w.hires.length;
    const id = `task-${n}`;
    const hire: Hire = { id, known: false };
    this.w.hires.push(hire);
    const kind: PlanOutcome = n === 0 ? this.first : "success";
    const ok = (): DelegatedStepResult => ({
      step_id: step.step_id,
      task_id: id,
      receipt: receipt(id, "completed"),
      result_text: "the work",
    });
    switch (kind) {
      case "success":
        onTaskSubmitted?.(id);
        hire.known = true;
        return Promise.resolve(ok());
      case "failure":
        onTaskSubmitted?.(id);
        hire.known = true;
        return Promise.reject(new Error("Delegated step failed: could not do it"));
      case "undetermined":
        onTaskSubmitted?.(id);
        return Promise.reject(new DelegationUndeterminedError(step.description));
      case "crash_task":
        onTaskSubmitted?.(id);
        this.w.signalCrash();
        return new Promise(() => {});
      case "crash_no_task":
        this.w.signalCrash();
        return new Promise(() => {});
    }
  }

  pollTaskResult(taskId: string, stepId: string): Promise<DelegatedStepResult | null> {
    const hire = this.w.hires.find((h) => h.id === taskId);
    if (hire == null) return Promise.resolve(null);
    if (!hire.known && (this.resolveAt == null || this.w.tick < this.resolveAt)) {
      return Promise.resolve(null);
    }
    if (!hire.known) this.settledAt = this.w.tick;
    hire.known = true;
    const status = this.truth === "completes" ? "completed" : "failed";
    return Promise.resolve({
      step_id: stepId,
      task_id: taskId,
      receipt: receipt(taskId, status),
      result_text: receipt(taskId, status).result,
    });
  }
}

async function runPlanCase(
  first: PlanOutcome,
  truth: Truth,
  resolveAt: number | null,
  restartMask: number,
): Promise<CaseResult> {
  const w = newWorld();
  const relay = new FakeRelay(w, first, truth, resolveAt);
  const noTurn = async function* (): AsyncGenerator<StreamChunk> {
    yield { type: "text" as const, text: "unused" };
  };
  const boot = (): GoalScheduler => {
    const s = newScheduler(
      w,
      mockRuntime(new PaidIntentLedger(w.store, MOTE), () => noTurn()),
    );
    s.setPlanEngine(
      new PlanEngine(w.db.planStore, {
        delegationAdapter: relay,
        localCapabilities: [],
        enableReflection: false,
        maxPlanRetries: 0,
        // Each boot is a process: its own in-process plan locks.
        driverLocks: new PlanDriverLocks(),
      }),
      w.db.planStore,
    );
    return s;
  };
  let s = boot();
  for (let t = 1; t <= TICKS; t++) {
    w.tick = t;
    const restart = w.crashed || (t > 1 && (restartMask & (1 << (t - 2))) !== 0);
    if (restart) {
      armCrash(w);
      s = boot();
    }
    await runTick(w, s);
  }
  const g = w.db.goalStore.get(GOAL)!;
  return {
    violations: w.violations,
    failures: g.consecutive_failures,
    status: g.status,
    hires: w.hires.length,
    firedTicks: [],
    settledAt: relay.settledAt,
    runs: runStatuses(w),
  };
}

describe("#890 CLI scheduler harness — no second paid attempt while the first is unknown", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  it("TURN mode: outcome × resolution tick × restart", async () => {
    const failures: string[] = [];
    const outcomes: TurnOutcome[] = ["success", "failure", "undetermined", "crash"];
    for (const first of outcomes) {
      for (const resolveAt of [2, 3, 4, null]) {
        for (let mask = 0; mask < 1 << (TICKS - 1); mask++) {
          const label = `turn/${first}/resolve@${resolveAt ?? "never"}/restart=${mask.toString(2)}`;
          const r = await runTurnCase(first, resolveAt, mask);
          for (const v of r.violations) failures.push(`${label}: SAFETY ${v}`);
          const unknown = first === "undetermined" || first === "crash";
          if (unknown && r.failures !== 0) {
            failures.push(`${label}: COUNTING consecutive_failures=${r.failures}`);
          }
          if (r.status !== "active") failures.push(`${label}: goal ${r.status}`);
          if (unknown && resolveAt != null && !r.firedTicks.includes(resolveAt)) {
            failures.push(
              `${label}: LIVENESS resolved before tick ${resolveAt}, fired at ${r.firedTicks.join(",")}`,
            );
          }
          if (unknown && resolveAt == null && r.hires !== 1) {
            failures.push(`${label}: ${r.hires} hires for a never-resolved outcome`);
          }
        }
      }
    }
    expect(failures.slice(0, 40), `${failures.length} failing cell assertions`).toEqual([]);
  }, 120_000);

  it("PLAN mode: outcome × relay truth × resolution tick × restart", async () => {
    const failures: string[] = [];
    const outcomes: PlanOutcome[] = [
      "success",
      "failure",
      "undetermined",
      "crash_task",
      "crash_no_task",
    ];
    for (const first of outcomes) {
      for (const truth of ["completes", "fails"] as Truth[]) {
        for (const resolveAt of [2, 3, 4, null]) {
          for (let mask = 0; mask < 1 << (TICKS - 1); mask++) {
            const label = `plan/${first}/${truth}/resolve@${resolveAt ?? "never"}/restart=${mask.toString(2)}`;
            const r = await runPlanCase(first, truth, resolveAt, mask);
            for (const v of r.violations) failures.push(`${label}: SAFETY ${v}`);
            const unknown = first !== "success" && first !== "failure";
            const resolvable = unknown && first !== "crash_no_task" && resolveAt != null;
            if (unknown && !(resolvable && truth === "fails") && r.failures !== 0) {
              failures.push(`${label}: COUNTING consecutive_failures=${r.failures}`);
            }
            if (resolvable && r.settledAt !== resolveAt) {
              failures.push(
                `${label}: LIVENESS readable from tick ${resolveAt}, settled at ${r.settledAt ?? "never"}`,
              );
            }
            if (unknown && !resolvable && r.hires !== 1) {
              failures.push(`${label}: ${r.hires} submissions for an unresolvable outcome`);
            }
            // HONESTY: a run that stopped on an unknown outcome is `partial`
            // (awaiting its result) — never `completed`, never `failed`. A
            // run the process died inside is `interrupted` by recovery.
            if (unknown && !resolvable) {
              const bad = r.runs.filter((st) => st !== "partial" && st !== "interrupted");
              if (bad.length > 0)
                failures.push(`${label}: HONESTY run statuses ${r.runs.join(",")}`);
            }
          }
        }
      }
    }
    expect(failures.slice(0, 40), `${failures.length} failing cell assertions`).toEqual([]);
  }, 120_000);

  it("a plan the engine refuses (the goal holds an undetermined step) closes the run `partial`, not failed", async () => {
    const w = newWorld();
    const s = newScheduler(
      w,
      mockRuntime(new PaidIntentLedger(w.store, MOTE), async function* () {
        yield { type: "text" as const, text: "unused" };
      }),
    );
    const refusing = {
      isExecuting: false,
      createPlan: vi.fn().mockRejectedValue(new DelegationUndeterminedError("remote work")),
    } as unknown as PlanEngine;
    s.setPlanEngine(refusing, w.db.planStore);
    await s.tickOnce();
    await s.tickOnce();
    await s.tickOnce();
    const g = w.db.goalStore.get(GOAL)!;
    expect(g.consecutive_failures).toBe(0);
    expect(g.status).toBe("active");
    expect(runStatuses(w)).toEqual(["partial", "partial", "partial"]);
  });
});
