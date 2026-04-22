/**
 * goals-runner tests — covers the web-surface adapter for
 * `@motebit/panels/goals`. Tests both the localStorage I/O helpers
 * (via their observable effect on the runner) and the fire() routing
 * per mode / strategy / error path.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { GoalRunRecord, ScheduledGoal } from "@motebit/panels";

import { createWebGoalsRunner, formatCountdownUntil } from "../goals-runner.js";
import type { WebApp } from "../web-app.js";

interface MockApp {
  isProcessing: boolean;
  executeGoal: (goalId: string, prompt: string) => AsyncGenerator<unknown>;
  sendMessageStreaming: (
    prompt: string,
    history?: unknown,
    opts?: unknown,
  ) => AsyncGenerator<{ type: string; text?: string }>;
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
  };
  return { ...base, ...overrides };
}

beforeEach(() => {
  globalThis.localStorage.clear();
});

afterEach(() => {
  globalThis.localStorage.clear();
});

describe("formatCountdownUntil", () => {
  it('returns "any moment" when target already passed', () => {
    expect(formatCountdownUntil(1000, 2000)).toBe("any moment");
    expect(formatCountdownUntil(1000, 1000)).toBe("any moment");
  });

  it("seconds bucket for sub-minute windows", () => {
    expect(formatCountdownUntil(1000 + 30_000, 1000)).toBe("in 30s");
  });

  it("minutes bucket for sub-hour windows", () => {
    expect(formatCountdownUntil(1000 + 5 * 60_000, 1000)).toBe("in 5m");
  });

  it("hours bucket, round hour and with minutes remainder", () => {
    expect(formatCountdownUntil(1000 + 3 * 3_600_000, 1000)).toBe("in 3h");
    expect(formatCountdownUntil(1000 + 3 * 3_600_000 + 15 * 60_000, 1000)).toBe("in 3h 15m");
  });

  it("days bucket, round day and with hours remainder", () => {
    expect(formatCountdownUntil(1000 + 2 * 86_400_000, 1000)).toBe("in 2d");
    expect(formatCountdownUntil(1000 + 2 * 86_400_000 + 5 * 3_600_000, 1000)).toBe("in 2d 5h");
  });
});

describe("createWebGoalsRunner — storage adapter", () => {
  it("loads empty arrays on first-ever run (no stored data)", () => {
    const runner = createWebGoalsRunner(makeApp() as unknown as WebApp);
    expect(runner.getState().goals).toEqual([]);
    expect(runner.getState().runs).toEqual([]);
  });

  it("round-trips addGoal through localStorage (save on write, load on read)", () => {
    const runner = createWebGoalsRunner(makeApp() as unknown as WebApp);
    runner.addGoal({ prompt: "hourly brief", mode: "recurring", cadence: "hourly" });
    expect(runner.getState().goals).toHaveLength(1);

    const raw = globalThis.localStorage.getItem("motebit.goals");
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!) as ScheduledGoal[];
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.prompt).toBe("hourly brief");

    const fresh = createWebGoalsRunner(makeApp() as unknown as WebApp);
    expect(fresh.getState().goals).toHaveLength(1);
    expect(fresh.getState().goals[0]?.prompt).toBe("hourly brief");
  });

  it("tolerates corrupted localStorage JSON (returns empty)", () => {
    globalThis.localStorage.setItem("motebit.goals", "not-valid-json{");
    const runner = createWebGoalsRunner(makeApp() as unknown as WebApp);
    expect(runner.getState().goals).toEqual([]);
  });
});

describe("createWebGoalsRunner — fire() routing by mode", () => {
  it("skipped when app.isProcessing is true", async () => {
    const runner = createWebGoalsRunner(makeApp({ isProcessing: true }) as unknown as WebApp);
    runner.addGoal({ prompt: "x", mode: "once" });
    const goal = runner.getState().goals[0]!;
    const result = await runner.runNow(goal.goal_id);
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
    const runner = createWebGoalsRunner(app as unknown as WebApp);
    runner.addGoal({ prompt: "Draft itinerary", mode: "once" });
    const goal = runner.getState().goals[0]!;
    const result = await runner.runNow(goal.goal_id, (c) => seen.push(c));
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
    const runner = createWebGoalsRunner(app as unknown as WebApp);
    runner.addGoal({ prompt: "x", mode: "once" });
    const goal = runner.getState().goals[0]!;
    const result = await runner.runNow(goal.goal_id);
    expect(result.outcome).toBe("error");
    if (result.outcome === "error") expect(result.error).toBe("step 1 failed");
  });

  it("once mode wraps thrown errors as error outcome", async () => {
    const app = makeApp({
      async *executeGoal() {
        throw new Error("executeGoal blew up");
      },
    });
    const runner = createWebGoalsRunner(app as unknown as WebApp);
    runner.addGoal({ prompt: "x", mode: "once" });
    const goal = runner.getState().goals[0]!;
    const result = await runner.runNow(goal.goal_id);
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
    const runner = createWebGoalsRunner(app as unknown as WebApp);
    runner.addGoal({ prompt: "brief me", mode: "recurring", cadence: "hourly" });
    const goal = runner.getState().goals[0]!;
    const result = await runner.runNow(goal.goal_id);
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
    const runner = createWebGoalsRunner(app as unknown as WebApp);
    runner.addGoal({ prompt: "x", mode: "recurring", cadence: "daily" });
    const goal = runner.getState().goals[0]!;
    const result = await runner.runNow(goal.goal_id);
    expect(result.outcome).toBe("error");
    if (result.outcome === "error") expect(result.error).toContain("streaming failed");
  });

  it("recurring mode with empty text returns null responsePreview", async () => {
    const app = makeApp({
      async *sendMessageStreaming() {
        // no text chunks
      },
    });
    const runner = createWebGoalsRunner(app as unknown as WebApp);
    runner.addGoal({ prompt: "x", mode: "recurring", cadence: "weekly" });
    const goal = runner.getState().goals[0]!;
    const result = await runner.runNow(goal.goal_id);
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
    const runner = createWebGoalsRunner(app as unknown as WebApp);
    runner.addGoal({ prompt: "x", mode: "recurring", cadence: "hourly" });
    const goal = runner.getState().goals[0]!;
    await runner.runNow(goal.goal_id);

    const raw = globalThis.localStorage.getItem("motebit.goals_runs");
    expect(raw).not.toBeNull();
    const runs = JSON.parse(raw!) as GoalRunRecord[];
    expect(runs.length).toBeGreaterThan(0);
    expect(runs[0]?.status).toBe("fired");
  });

  it("saveGoals tolerates localStorage quota errors without crashing", () => {
    const app = makeApp();
    const runner = createWebGoalsRunner(app as unknown as WebApp);
    const original = globalThis.localStorage.setItem.bind(globalThis.localStorage);
    const spy = vi.spyOn(globalThis.localStorage, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceeded");
    });
    // Should not throw:
    expect(() => runner.addGoal({ prompt: "will not persist", mode: "once" })).not.toThrow();
    expect(runner.getState().goals).toHaveLength(1);
    spy.mockRestore();
    // Smoke — original storage still usable after restore.
    original("check", "ok");
    expect(globalThis.localStorage.getItem("check")).toBe("ok");
  });
});
