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
