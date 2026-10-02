/**
 * goal-scheduler tests — cover the web-surface daemon
 * (`createWebGoalsScheduler`): the localStorage I/O helpers (via their
 * observable effect on the engine state) and the fire() routing per mode /
 * strategy / error path. The engine's reconciliation logic is covered
 * separately in `goal-engine.test.ts`; here we exercise the web wiring.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ScheduledGoal } from "@motebit/panels";

import type { GoalRunRecord } from "../goal-engine.js";
import { createWebGoalsScheduler } from "../goal-scheduler.js";
import { latestPaymentNotice } from "../goal-engine.js";
import type { WebApp } from "../web-app.js";

const HOURLY = 3_600_000;
const DAILY = 86_400_000;
const WEEKLY = 604_800_000;

interface MockApp {
  isProcessing: boolean;
  executeGoal: (goalId: string, prompt: string) => AsyncGenerator<unknown>;
  sendMessageStreaming: (
    prompt: string,
    history?: unknown,
    opts?: unknown,
  ) => AsyncGenerator<{ type: string; text?: string }>;
  /** Returns null when identity is not loaded — adapter's signing
   *  path is fail-safe under that condition (no manifest written).
   *  Tests that exercise the artifact-signing path can override
   *  with a stub runtime that exposes `signGoalArtifact`. */
  getRuntime: () => unknown;
}

/** Expose the adapter's fire() by reading runs after a forced runNow. */
function makeApp(overrides?: Partial<MockApp>): MockApp {
  const base: MockApp = {
    isProcessing: false,
    async *executeGoal() {
      // overridable
    },
    async *sendMessageStreaming() {
      // overridable
    },
    getRuntime: () => null,
  };
  return { ...base, ...overrides };
}

beforeEach(() => {
  globalThis.localStorage.clear();
});

afterEach(() => {
  globalThis.localStorage.clear();
});

describe("createWebGoalsScheduler — storage adapter", () => {
  it("loads empty arrays on first-ever run (no stored data)", () => {
    const engine = createWebGoalsScheduler(makeApp() as unknown as WebApp);
    expect(engine.getState().goals).toEqual([]);
    expect(engine.getState().runs).toEqual([]);
  });

  it("round-trips addGoal through localStorage (save on write, load on read)", () => {
    const engine = createWebGoalsScheduler(makeApp() as unknown as WebApp);
    engine.addGoal({ prompt: "hourly brief", mode: "recurring", interval_ms: HOURLY });
    expect(engine.getState().goals).toHaveLength(1);

    const raw = globalThis.localStorage.getItem("motebit.goals");
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!) as ScheduledGoal[];
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.prompt).toBe("hourly brief");

    const fresh = createWebGoalsScheduler(makeApp() as unknown as WebApp);
    expect(fresh.getState().goals).toHaveLength(1);
    expect(fresh.getState().goals[0]?.prompt).toBe("hourly brief");
  });

  it("tolerates corrupted localStorage JSON (returns empty)", () => {
    globalThis.localStorage.setItem("motebit.goals", "not-valid-json{");
    const engine = createWebGoalsScheduler(makeApp() as unknown as WebApp);
    expect(engine.getState().goals).toEqual([]);
  });
});

describe("createWebGoalsScheduler — fire() routing by mode", () => {
  it("skipped when app.isProcessing is true", async () => {
    const engine = createWebGoalsScheduler(makeApp({ isProcessing: true }) as unknown as WebApp);
    engine.addGoal({ prompt: "x", interval_ms: 0, mode: "once" });
    const goal = engine.getState().goals[0]!;
    const result = await engine.runNow(goal.goal_id);
    expect(result.outcome).toBe("skipped");
  });

  it("once mode aggregates plan chunks and returns fired with summary", async () => {
    const planChunks = [
      { type: "plan_created", plan: { title: "Draft itinerary", total_steps: 3 } },
      {
        type: "step_completed",
        step: { description: "search flights" },
      },
      { type: "plan_completed" },
    ];
    const seen: unknown[] = [];
    const app = makeApp({
      async *executeGoal() {
        for (const chunk of planChunks) yield chunk;
      },
    });
    const engine = createWebGoalsScheduler(app as unknown as WebApp);
    engine.addGoal({ prompt: "Draft itinerary", interval_ms: 0, mode: "once" });
    const goal = engine.getState().goals[0]!;
    const result = await engine.runNow(goal.goal_id, (c) => seen.push(c));
    expect(result.outcome).toBe("fired");
    expect(seen).toHaveLength(3);
    if (result.outcome === "fired") {
      expect(result.responsePreview).toContain("Draft itinerary");
      expect(result.responsePreview).toContain("search flights");
    }
  });

  it("once mode plan_failed maps to error outcome with reason", async () => {
    const app = makeApp({
      async *executeGoal() {
        yield { type: "plan_created", plan: { title: "x", total_steps: 1 } };
        yield { type: "plan_failed", reason: "step 1 failed" };
      },
    });
    const engine = createWebGoalsScheduler(app as unknown as WebApp);
    engine.addGoal({ prompt: "x", interval_ms: 0, mode: "once" });
    const goal = engine.getState().goals[0]!;
    const result = await engine.runNow(goal.goal_id);
    expect(result.outcome).toBe("error");
    if (result.outcome === "error") expect(result.error).toBe("step 1 failed");
  });

  it("once mode wraps thrown errors as error outcome", async () => {
    const app = makeApp({
      async *executeGoal() {
        throw new Error("executeGoal blew up");
      },
    });
    const engine = createWebGoalsScheduler(app as unknown as WebApp);
    engine.addGoal({ prompt: "x", interval_ms: 0, mode: "once" });
    const goal = engine.getState().goals[0]!;
    const result = await engine.runNow(goal.goal_id);
    expect(result.outcome).toBe("error");
    if (result.outcome === "error") expect(result.error).toContain("executeGoal blew up");
  });

  it("#885: a recurring fire's payment_notice rides its own field — the run record — never the artifact", async () => {
    const app = makeApp({
      async *sendMessageStreaming() {
        yield {
          type: "payment_notice",
          notice: "This hire's wallet ALSO sent another payment (tx sigAAAAAAAAAAAA, landed)",
          extra_payments: [{ tx_hash: "sigAAAAAAAAAAAA", status: "landed" }],
        } as unknown as { type: string };
        yield { type: "text", text: "the goal's answer" };
      },
    });
    const engine = createWebGoalsScheduler(app as unknown as WebApp);
    engine.addGoal({ prompt: "hire", mode: "recurring", interval_ms: HOURLY });
    const goal = engine.getState().goals[0]!;
    const result = await engine.runNow(goal.goal_id);
    expect(result.outcome).toBe("fired");
    if (result.outcome === "fired") {
      expect(result.paymentNotice).toMatch(/^Your wallet also sent another payment/);
      expect(result.responseFull).toBe("the goal's answer");
    }
    const run = engine.getState().runs.find((r) => r.goal_id === goal.goal_id);
    expect(run?.payment_notice).toMatch(/^Your wallet also sent another payment/);
    expect(latestPaymentNotice(engine.getState().runs, goal.goal_id)).toMatch(
      /^Your wallet also sent another payment/,
    );
    expect(engine.getState().goals[0]?.last_response_full).toBe("the goal's answer");
  });

  it("recurring mode accumulates text chunks and returns fired", async () => {
    const app = makeApp({
      async *sendMessageStreaming() {
        yield { type: "text", text: "Hello " };
        yield { type: "text", text: "world" };
        yield { type: "other" };
      },
    });
    const engine = createWebGoalsScheduler(app as unknown as WebApp);
    engine.addGoal({ prompt: "brief me", mode: "recurring", interval_ms: HOURLY });
    const goal = engine.getState().goals[0]!;
    const result = await engine.runNow(goal.goal_id);
    expect(result.outcome).toBe("fired");
    if (result.outcome === "fired") {
      expect(result.responsePreview).toBe("Hello world");
    }
  });

  it("recurring mode wraps thrown errors", async () => {
    const app = makeApp({
      async *sendMessageStreaming() {
        throw new Error("streaming failed");
      },
    });
    const engine = createWebGoalsScheduler(app as unknown as WebApp);
    engine.addGoal({ prompt: "x", mode: "recurring", interval_ms: DAILY });
    const goal = engine.getState().goals[0]!;
    const result = await engine.runNow(goal.goal_id);
    expect(result.outcome).toBe("error");
    if (result.outcome === "error") expect(result.error).toContain("streaming failed");
  });

  it("recurring mode with empty text returns null responsePreview", async () => {
    const app = makeApp({
      async *sendMessageStreaming() {
        // no text chunks
      },
    });
    const engine = createWebGoalsScheduler(app as unknown as WebApp);
    engine.addGoal({ prompt: "x", mode: "recurring", interval_ms: WEEKLY });
    const goal = engine.getState().goals[0]!;
    const result = await engine.runNow(goal.goal_id);
    expect(result.outcome).toBe("fired");
    if (result.outcome === "fired") {
      expect(result.responsePreview).toBeNull();
    }
  });

  it("persists run records to the motebit.goals_runs key", async () => {
    const app = makeApp({
      async *sendMessageStreaming() {
        yield { type: "text", text: "ok" };
      },
    });
    const engine = createWebGoalsScheduler(app as unknown as WebApp);
    engine.addGoal({ prompt: "x", mode: "recurring", interval_ms: HOURLY });
    const goal = engine.getState().goals[0]!;
    await engine.runNow(goal.goal_id);

    const raw = globalThis.localStorage.getItem("motebit.goals_runs");
    expect(raw).not.toBeNull();
    const runs = JSON.parse(raw!) as GoalRunRecord[];
    expect(runs.length).toBeGreaterThan(0);
    expect(runs[0]?.status).toBe("fired");
  });

  it("saveGoals tolerates localStorage quota errors without crashing", () => {
    const app = makeApp();
    const engine = createWebGoalsScheduler(app as unknown as WebApp);
    const original = globalThis.localStorage.setItem.bind(globalThis.localStorage);
    const spy = vi.spyOn(globalThis.localStorage, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceeded");
    });
    // Should not throw:
    expect(() =>
      engine.addGoal({ prompt: "will not persist", interval_ms: 0, mode: "once" }),
    ).not.toThrow();
    expect(engine.getState().goals).toHaveLength(1);
    spy.mockRestore();
    // Smoke — original storage still usable after restore.
    original("check", "ok");
    expect(globalThis.localStorage.getItem("check")).toBe("ok");
  });
});

describe("createWebGoalsScheduler — goal_executed emission (#594 Inc 3b prerequisite)", () => {
  /** A stub runtime capturing what the scheduler emits to the execution ledger. */
  function makeRuntime(): { runtime: unknown; emitted: Array<Record<string, unknown>> } {
    const emitted: Array<Record<string, unknown>> = [];
    return {
      emitted,
      runtime: {
        goals: {
          executed: (payload: Record<string, unknown>) => {
            emitted.push(payload);
            return Promise.resolve();
          },
        },
        signGoalArtifact: () => Promise.resolve(null),
        outstandingPaidResults: () => [],
      },
    };
  }

  it("emits goal_executed on a successful recurring fire, with CLI-matching counters", async () => {
    // Web was the ONLY surface that never emitted this — CLI and desktop both
    // do — so the same goal firing on the same identity produced a ledger entry
    // on one surface and nothing on another. That is the Ring-1 divergence #594
    // Inc 3b has to close before per-fire rows can mean anything.
    const { runtime, emitted } = makeRuntime();
    const app = makeApp({
      getRuntime: () => runtime,
      async *sendMessageStreaming() {
        yield { type: "tool_status", status: "calling", name: "web_search" };
        yield { type: "tool_status", status: "done", name: "web_search" };
        yield { type: "tool_status", status: "calling", name: "read_url" };
        yield { type: "text", text: "Findings: the report body." };
        yield {
          type: "result",
          result: { totalTokens: 1234, memoriesFormed: [{ id: "m1" }, { id: "m2" }] },
        };
      },
    });
    const engine = createWebGoalsScheduler(app as unknown as WebApp);
    engine.addGoal({ prompt: "daily brief", interval_ms: 3_600_000, mode: "recurring" });
    const goal = engine.getState().goals[0]!;

    const result = await engine.runNow(goal.goal_id);
    expect(result.outcome).toBe("fired");

    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      goal_id: goal.goal_id,
      summary: "Findings: the report body.",
      // Calls INITIATED, matching the CLI's semantic (one per `calling` chunk).
      // The `done` chunk must not double-count.
      tool_calls: 2,
      memories: 2,
    });
  });

  it("emits the failure variant with `error` when the turn throws", async () => {
    const { runtime, emitted } = makeRuntime();
    const app = makeApp({
      getRuntime: () => runtime,
      // eslint-disable-next-line require-yield -- the throw is the behaviour under test
      async *sendMessageStreaming() {
        throw new Error("provider unreachable");
      },
    });
    const engine = createWebGoalsScheduler(app as unknown as WebApp);
    engine.addGoal({ prompt: "daily brief", interval_ms: 3_600_000, mode: "recurring" });
    const goal = engine.getState().goals[0]!;

    const result = await engine.runNow(goal.goal_id);
    expect(result.outcome).toBe("error");
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ goal_id: goal.goal_id, error: "provider unreachable" });
    // A failed run has no counters to report — omitted, never guessed as zero.
    expect(emitted[0]).not.toHaveProperty("tool_calls");
  });

  it("emits on the once/plan path too — success and plan_failed", async () => {
    const { runtime, emitted } = makeRuntime();
    const app = makeApp({
      getRuntime: () => runtime,
      async *executeGoal() {
        yield { type: "plan_created", plan: { title: "Draft itinerary", total_steps: 2 } };
        yield { type: "plan_completed" };
      },
    });
    const engine = createWebGoalsScheduler(app as unknown as WebApp);
    engine.addGoal({ prompt: "Draft itinerary", interval_ms: 0, mode: "once" });
    const goal = engine.getState().goals[0]!;
    await engine.runNow(goal.goal_id);

    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.["summary"]).toContain("Draft itinerary");
    // The plan path has no per-tool chunk to count, so the counters are omitted
    // rather than reported as zero — absent means unknown, not none.
    expect(emitted[0]).not.toHaveProperty("tool_calls");

    const failing = makeApp({
      getRuntime: () => runtime,
      async *executeGoal() {
        yield { type: "plan_failed", reason: "step 2 unreachable" };
      },
    });
    const e2 = createWebGoalsScheduler(failing as unknown as WebApp);
    e2.addGoal({ prompt: "Other", interval_ms: 0, mode: "once" });
    await e2.runNow(e2.getState().goals[0]!.goal_id);

    expect(emitted).toHaveLength(2);
    expect(emitted[1]).toMatchObject({ error: "step 2 unreachable" });
  });

  it("does not emit when identity is not loaded — no ledger to write to", async () => {
    // getRuntime() === null is the fail-safe state the signing path already
    // honours; the ledger emission must not throw through it.
    const app = makeApp({
      async *sendMessageStreaming() {
        yield { type: "text", text: "ok" };
      },
    });
    const engine = createWebGoalsScheduler(app as unknown as WebApp);
    engine.addGoal({ prompt: "x", interval_ms: 3_600_000, mode: "recurring" });
    const result = await engine.runNow(engine.getState().goals[0]!.goal_id);
    expect(result.outcome).toBe("fired");
  });

  it("a rejected emission never fails the goal run", async () => {
    // Fire-and-forget, exactly as the CLI does: a ledger write must never take
    // down the run that produced it.
    const app = makeApp({
      getRuntime: () => ({
        goals: { executed: () => Promise.reject(new Error("ledger unavailable")) },
        signGoalArtifact: () => Promise.resolve(null),
        outstandingPaidResults: () => [],
      }),
      async *sendMessageStreaming() {
        yield { type: "text", text: "ok" };
      },
    });
    const engine = createWebGoalsScheduler(app as unknown as WebApp);
    engine.addGoal({ prompt: "x", interval_ms: 3_600_000, mode: "recurring" });
    const result = await engine.runNow(engine.getState().goals[0]!.goal_id);
    expect(result.outcome).toBe("fired");
  });
});

describe("#890: a goal whose last run left a paid outcome unknown", () => {
  it("is not fired again while a payment made during that run is still owed its result", async () => {
    const owed: unknown[] = [];
    let turns = 0;
    const app = makeApp({
      getRuntime: () => ({
        goals: { executed: () => Promise.resolve() },
        signGoalArtifact: () => Promise.resolve(null),
        outstandingPaidResults: () => owed,
      }),
      async *sendMessageStreaming() {
        turns++;
        // The model hires; the payment settles; the result never arrives.
        owed.push({
          workerMotebitId: "worker-a",
          capability: "research",
          taskId: "task-owed",
          txHash: "tx",
          paidMicro: 1000,
          feeMicro: 50,
          recordedAt: Date.now(),
        });
        yield { type: "text", text: "hired" };
      },
    });
    const engine = createWebGoalsScheduler(app as unknown as WebApp);
    engine.addGoal({ prompt: "buy the report", interval_ms: 3_600_000, mode: "recurring" });
    const goalId = engine.getState().goals[0]!.goal_id;

    expect((await engine.runNow(goalId)).outcome).toBe("fired");
    expect((await engine.runNow(goalId)).outcome).toBe("skipped");
    expect(turns).toBe(1);

    // Retrieved (or dismissed) with /result: the hold lifts.
    owed.length = 0;
    expect((await engine.runNow(goalId)).outcome).toBe("fired");
    expect(turns).toBe(2);
  });

  it("a once goal whose plan ends undetermined reports awaiting its result, not a plan failure", async () => {
    const emitted: Array<Record<string, unknown>> = [];
    const app = makeApp({
      getRuntime: () => ({
        goals: {
          executed: (p: Record<string, unknown>) => {
            emitted.push(p);
            return Promise.resolve();
          },
        },
        outstandingPaidResults: () => [],
      }),
      async *executeGoal() {
        yield { type: "plan_created", plan: { title: "Hire", total_steps: 1 } };
        yield {
          type: "plan_undetermined",
          plan: {},
          step: { description: "remote work" },
          reason: "Submission unconfirmed — the task may still complete; check /result",
        };
      },
    });
    const engine = createWebGoalsScheduler(app as unknown as WebApp);
    engine.addGoal({ prompt: "hire", interval_ms: 0, mode: "once" });
    const goalId = engine.getState().goals[0]!.goal_id;
    const result = await engine.runNow(goalId);
    // Held, never an error: the once goal stays active and carries no error.
    expect(result.outcome).toBe("awaiting_result");
    const goal = engine.getState().goals.find((g) => g.goal_id === goalId)!;
    expect(goal.status).toBe("active");
    expect(goal.last_error ?? null).toBeNull();
    expect(engine.getState().runs.at(-1)?.status).toBe("awaiting_result");
    expect(emitted[0]?.error).toBeUndefined();
    expect(String(emitted[0]?.summary)).toMatch(/^awaiting result — /);
  });

  it("r3: a once goal whose plan is busy (another driver holds it) awaits, never errors", async () => {
    const app = makeApp({
      getRuntime: () => ({
        goals: { executed: () => Promise.resolve() },
        outstandingPaidResults: () => [],
      }),
      async *executeGoal() {
        yield { type: "plan_busy", plan: {} };
      },
    });
    const engine = createWebGoalsScheduler(app as unknown as WebApp);
    engine.addGoal({ prompt: "hire", interval_ms: 0, mode: "once" });
    const goalId = engine.getState().goals[0]!.goal_id;
    expect((await engine.runNow(goalId)).outcome).toBe("awaiting_result");
    expect(engine.getState().goals.find((g) => g.goal_id === goalId)!.status).toBe("active");
  });

  const owedAt = (recordedAt: number) => ({
    workerMotebitId: "worker-a",
    capability: "research",
    taskId: "task-owed",
    txHash: "tx",
    paidMicro: 1000,
    feeMicro: 50,
    recordedAt,
  });

  function appOwing(owed: unknown[], turns: { n: number }) {
    return makeApp({
      getRuntime: () => ({
        goals: { executed: () => Promise.resolve() },
        signGoalArtifact: () => Promise.resolve(null),
        outstandingPaidResults: () => owed,
      }),
      async *sendMessageStreaming() {
        turns.n++;
        yield { type: "text", text: "ran" };
      },
    });
  }

  function seedRuns(runs: GoalRunRecord[]): void {
    globalThis.localStorage.setItem("motebit.goals_runs", JSON.stringify(runs));
  }

  it("PROBE: a fire that paid and died mid-run (its record still `running`) holds the goal", async () => {
    const turns = { n: 0 };
    const owed = [owedAt(1_500)];
    const engine = createWebGoalsScheduler(appOwing(owed, turns) as unknown as WebApp);
    engine.addGoal({ prompt: "buy", interval_ms: 3_600_000, mode: "recurring" });
    const goalId = engine.getState().goals[0]!.goal_id;
    // The tab closed mid-fire: no finish ever recorded — and it is the ONLY run.
    seedRuns([
      { run_id: "r1", goal_id: goalId, started_at: 1_000, finished_at: null, status: "running" },
    ]);
    // The next page load: a fresh engine over what storage holds.
    const reloaded = createWebGoalsScheduler(appOwing(owed, turns) as unknown as WebApp);
    expect((await reloaded.runNow(goalId)).outcome).toBe("skipped");
    expect(turns.n).toBe(0);
  });

  it("an owed payment recorded after the last fire FINISHED (no later fire) does not hold it", async () => {
    const turns = { n: 0 };
    const owed = [owedAt(3_000)];
    const engine = createWebGoalsScheduler(appOwing(owed, turns) as unknown as WebApp);
    engine.addGoal({ prompt: "buy", interval_ms: 3_600_000, mode: "recurring" });
    const goalId = engine.getState().goals[0]!.goal_id;
    seedRuns([
      { run_id: "r1", goal_id: goalId, started_at: 1_000, finished_at: 2_000, status: "fired" },
    ]);
    const reloaded = createWebGoalsScheduler(appOwing(owed, turns) as unknown as WebApp);
    expect((await reloaded.runNow(goalId)).outcome).toBe("fired");
    expect(turns.n).toBe(1);
  });
});
