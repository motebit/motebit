/**
 * Goals engine unit tests. Covers the daemon-role reconciliation core used
 * by web (was `createGoalsRunner` in `@motebit/panels`; moved to
 * `apps/web/src/goal-engine.ts` when web's daemon logic was extracted from
 * the shared package). Drives an injected in-memory adapter + fake fire.
 */
import { describe, it, expect, vi } from "vitest";

import { createGoalsEngine } from "../goal-engine.js";
import type { GoalFireResult, GoalRunRecord } from "../goal-engine.js";
import type { ScheduledGoal } from "@motebit/panels";

interface Stores {
  goals: ScheduledGoal[];
  runs: GoalRunRecord[];
}

function makeAdapter(
  fire: (goal: ScheduledGoal) => Promise<GoalFireResult>,
  initial: Partial<Stores> = {},
): {
  adapter: Parameters<typeof createGoalsEngine>[0];
  stores: Stores;
  fireCalls: ScheduledGoal[];
} {
  const stores: Stores = {
    goals: initial.goals ?? [],
    runs: initial.runs ?? [],
  };
  const fireCalls: ScheduledGoal[] = [];
  return {
    stores,
    fireCalls,
    adapter: {
      loadGoals: () => stores.goals,
      saveGoals: (g) => {
        stores.goals = g;
      },
      loadRuns: () => stores.runs,
      saveRuns: (r) => {
        stores.runs = r;
      },
      async fire(goal) {
        fireCalls.push(goal);
        return fire(goal);
      },
    },
  };
}

describe("createGoalsEngine — addGoal", () => {
  it("creates a recurring goal with next_run_at = created_at + interval", () => {
    const { adapter, stores } = makeAdapter(async () => ({ outcome: "fired" }));
    const engine = createGoalsEngine(adapter, {
      now: () => 1_000,
      generateId: () => "g1",
    });
    const goal = engine.addGoal({
      prompt: "hi",
      mode: "recurring",
      interval_ms: 3_600_000,
    });
    expect(goal.mode).toBe("recurring");
    expect(goal.interval_ms).toBe(3_600_000);
    expect(goal.next_run_at).toBe(1_000 + 3_600_000);
    expect(stores.goals).toHaveLength(1);
  });

  it("creates a once goal without next_run_at (requires explicit runNow)", () => {
    const { adapter } = makeAdapter(async () => ({ outcome: "fired" }));
    const engine = createGoalsEngine(adapter, {
      now: () => 5_000,
      generateId: () => "g2",
    });
    const goal = engine.addGoal({ prompt: "summarize", interval_ms: 0, mode: "once" });
    expect(goal.mode).toBe("once");
    expect(goal.interval_ms).toBe(0);
    expect(goal.next_run_at).toBeUndefined();
    expect(goal.status).toBe("active");
  });

  it("accepts an arbitrary interval_ms for recurring", () => {
    const { adapter } = makeAdapter(async () => ({ outcome: "fired" }));
    const engine = createGoalsEngine(adapter, { now: () => 0, generateId: () => "g3" });
    const goal = engine.addGoal({
      prompt: "x",
      mode: "recurring",
      interval_ms: 42_000,
    });
    expect(goal.interval_ms).toBe(42_000);
  });
});

describe("createGoalsEngine — setEnabled", () => {
  it("toggles status and enabled together", () => {
    const { adapter } = makeAdapter(async () => ({ outcome: "fired" }));
    const engine = createGoalsEngine(adapter, { now: () => 0, generateId: () => "g1" });
    const goal = engine.addGoal({
      prompt: "x",
      mode: "recurring",
      interval_ms: 86_400_000,
    });
    engine.setEnabled(goal.goal_id, false);
    expect(engine.getState().goals[0]?.status).toBe("paused");
    expect(engine.getState().goals[0]?.enabled).toBe(false);
    engine.setEnabled(goal.goal_id, true);
    expect(engine.getState().goals[0]?.status).toBe("active");
    expect(engine.getState().goals[0]?.enabled).toBe(true);
  });

  it("is a no-op on terminal states", () => {
    const initial: Partial<Stores> = {
      goals: [
        {
          goal_id: "done",
          prompt: "x",
          interval_ms: 0,
          mode: "once",
          status: "completed",
        },
      ],
    };
    const { adapter } = makeAdapter(async () => ({ outcome: "fired" }), initial);
    const engine = createGoalsEngine(adapter);
    engine.setEnabled("done", false);
    expect(engine.getState().goals[0]?.status).toBe("completed");
  });
});

describe("createGoalsEngine — runNow + fire reconciliation", () => {
  it("recurring fired: advances next_run_at, writes last_response_preview", async () => {
    const { adapter, fireCalls } = makeAdapter(async () => ({
      outcome: "fired",
      responsePreview: "ok",
    }));
    let n = 100;
    const ids = ["g1", "run1"];
    let i = 0;
    const engine = createGoalsEngine(adapter, {
      now: () => n,
      generateId: () => ids[i++] ?? "x",
    });
    engine.addGoal({ prompt: "hi", mode: "recurring", interval_ms: 3_600_000 });
    n = 4_000_000;
    const result = await engine.runNow("g1");
    expect(result.outcome).toBe("fired");
    expect(fireCalls).toHaveLength(1);
    const state = engine.getState();
    expect(state.goals[0]?.last_response_preview).toBe("ok");
    expect(state.goals[0]?.last_run_at).toBe(4_000_000);
    expect(state.goals[0]?.next_run_at).toBe(4_000_000 + 3_600_000);
    expect(state.runs).toHaveLength(1);
    expect(state.runs[0]?.status).toBe("fired");
  });

  it("once goal fired: status reaches completed", async () => {
    const { adapter } = makeAdapter(async () => ({
      outcome: "fired",
      responsePreview: "done",
    }));
    const engine = createGoalsEngine(adapter, { now: () => 0, generateId: () => "g1" });
    engine.addGoal({ prompt: "p", interval_ms: 0, mode: "once" });
    await engine.runNow("g1");
    expect(engine.getState().goals[0]?.status).toBe("completed");
  });

  it("once goal error: status reaches failed and last_error populated", async () => {
    const { adapter } = makeAdapter(async () => ({ outcome: "error", error: "oops" }));
    const engine = createGoalsEngine(adapter, { now: () => 0, generateId: () => "g1" });
    engine.addGoal({ prompt: "p", interval_ms: 0, mode: "once" });
    await engine.runNow("g1");
    const goal = engine.getState().goals[0];
    expect(goal?.status).toBe("failed");
    expect(goal?.last_error).toBe("oops");
  });

  it("recurring error after a prior success clears last_response_preview", async () => {
    // The latest-outcome semantic: when a recurring goal errors after
    // previously succeeding, the prior success preview is stale and
    // misleading. Engine clears it so renderers surface the error as
    // the most-recent visible signal, not a stale earlier success.
    let nextResult: GoalFireResult = {
      outcome: "fired",
      responsePreview: "earlier success",
    };
    const adapter = {
      loadGoals: (): ScheduledGoal[] => [],
      saveGoals: (): void => {},
      loadRuns: (): GoalRunRecord[] => [],
      saveRuns: (): void => {},
      fire: async (): Promise<GoalFireResult> => nextResult,
    };
    const engine = createGoalsEngine(adapter, { now: () => 0, generateId: () => "g1" });
    engine.addGoal({ prompt: "p", mode: "recurring", interval_ms: 3_600_000 });

    await engine.runNow("g1");
    expect(engine.getState().goals[0]?.last_response_preview).toBe("earlier success");
    expect(engine.getState().goals[0]?.last_error).toBeNull();

    nextResult = { outcome: "error", error: "boom" };
    await engine.runNow("g1");
    const after = engine.getState().goals[0];
    expect(after?.last_error).toBe("boom");
    // Stale success preview must be cleared so the error is what
    // surfaces in the renderer's expanded card.
    expect(after?.last_response_preview).toBeNull();
    // Goal stays active because it's recurring — the renderer will
    // derive the `errored` visual state from `last_error != null
    // && status === "active"`.
    expect(after?.status).toBe("active");
  });

  it("fired with responseFull preserves the full artifact on the goal record", async () => {
    // Phase 2 of the goal-results arc: artifacts (full result content) are
    // preserved alongside the truncated preview.
    const full = "A very long synthesized result that motebit produced for the goal. ".repeat(20);
    const { adapter } = makeAdapter(async () => ({
      outcome: "fired",
      responsePreview: full.slice(0, 160),
      responseFull: full,
    }));
    const engine = createGoalsEngine(adapter, { now: () => 0, generateId: () => "g1" });
    engine.addGoal({ prompt: "p", mode: "recurring", interval_ms: 3_600_000 });
    await engine.runNow("g1");
    const goal = engine.getState().goals[0];
    expect(goal?.last_response_preview).toBe(full.slice(0, 160));
    expect(goal?.last_response_full).toBe(full);
  });

  it("fired without responseFull stores null (adapters can opt in incrementally)", async () => {
    const { adapter } = makeAdapter(async () => ({
      outcome: "fired",
      responsePreview: "preview only",
    }));
    const engine = createGoalsEngine(adapter, { now: () => 0, generateId: () => "g1" });
    engine.addGoal({ prompt: "p", mode: "recurring", interval_ms: 3_600_000 });
    await engine.runNow("g1");
    const goal = engine.getState().goals[0];
    expect(goal?.last_response_preview).toBe("preview only");
    expect(goal?.last_response_full).toBeNull();
  });

  it("error clears last_response_full symmetrically with last_response_preview", async () => {
    let nextResult: GoalFireResult = {
      outcome: "fired",
      responsePreview: "preview",
      responseFull: "full artifact content",
    };
    const adapter = {
      loadGoals: (): ScheduledGoal[] => [],
      saveGoals: (): void => {},
      loadRuns: (): GoalRunRecord[] => [],
      saveRuns: (): void => {},
      fire: async (): Promise<GoalFireResult> => nextResult,
    };
    const engine = createGoalsEngine(adapter, { now: () => 0, generateId: () => "g1" });
    engine.addGoal({ prompt: "p", mode: "recurring", interval_ms: 3_600_000 });

    await engine.runNow("g1");
    expect(engine.getState().goals[0]?.last_response_full).toBe("full artifact content");

    nextResult = { outcome: "error", error: "boom" };
    await engine.runNow("g1");
    const after = engine.getState().goals[0];
    expect(after?.last_error).toBe("boom");
    expect(after?.last_response_preview).toBeNull();
    expect(after?.last_response_full).toBeNull();
  });

  it("fired with turnId persists last_turn_id (slab navigational anchor)", async () => {
    const { adapter } = makeAdapter(async () => ({
      outcome: "fired",
      responsePreview: "preview",
      responseFull: "full artifact",
      turnId: "slab-turn-abc-123",
    }));
    const engine = createGoalsEngine(adapter, { now: () => 0, generateId: () => "g1" });
    engine.addGoal({ prompt: "p", mode: "recurring", interval_ms: 3_600_000 });
    await engine.runNow("g1");
    expect(engine.getState().goals[0]?.last_turn_id).toBe("slab-turn-abc-123");
  });

  it("error clears last_turn_id symmetrically (stale anchor would 404 the renderer)", async () => {
    let nextResult: GoalFireResult = {
      outcome: "fired",
      responsePreview: "preview",
      responseFull: "full",
      turnId: "slab-turn-xyz-789",
    };
    const adapter = {
      loadGoals: (): ScheduledGoal[] => [],
      saveGoals: (): void => {},
      loadRuns: (): GoalRunRecord[] => [],
      saveRuns: (): void => {},
      fire: async (): Promise<GoalFireResult> => nextResult,
    };
    const engine = createGoalsEngine(adapter, { now: () => 0, generateId: () => "g1" });
    engine.addGoal({ prompt: "p", mode: "recurring", interval_ms: 3_600_000 });

    await engine.runNow("g1");
    expect(engine.getState().goals[0]?.last_turn_id).toBe("slab-turn-xyz-789");

    nextResult = { outcome: "error", error: "boom" };
    await engine.runNow("g1");
    expect(engine.getState().goals[0]?.last_turn_id).toBeNull();
  });

  it("fired with manifestSigned persists last_manifest_signed (receipt indicator)", async () => {
    const { adapter } = makeAdapter(async () => ({
      outcome: "fired",
      responsePreview: "preview",
      responseFull: "full",
      manifestSigned: true,
    }));
    const engine = createGoalsEngine(adapter, { now: () => 0, generateId: () => "g1" });
    engine.addGoal({ prompt: "p", mode: "recurring", interval_ms: 3_600_000 });
    await engine.runNow("g1");
    expect(engine.getState().goals[0]?.last_manifest_signed).toBe(true);
  });

  it("fired with manifestSigned=false persists false (signing skipped, not unknown)", async () => {
    const { adapter } = makeAdapter(async () => ({
      outcome: "fired",
      responsePreview: "preview",
      manifestSigned: false,
    }));
    const engine = createGoalsEngine(adapter, { now: () => 0, generateId: () => "g1" });
    engine.addGoal({ prompt: "p", mode: "recurring", interval_ms: 3_600_000 });
    await engine.runNow("g1");
    expect(engine.getState().goals[0]?.last_manifest_signed).toBe(false);
  });

  it("error clears last_manifest_signed symmetrically (indicator must not outlive artifact)", async () => {
    let nextResult: GoalFireResult = {
      outcome: "fired",
      responsePreview: "p",
      responseFull: "full",
      manifestSigned: true,
    };
    const adapter = {
      loadGoals: (): ScheduledGoal[] => [],
      saveGoals: (): void => {},
      loadRuns: (): GoalRunRecord[] => [],
      saveRuns: (): void => {},
      fire: async (): Promise<GoalFireResult> => nextResult,
    };
    const engine = createGoalsEngine(adapter, { now: () => 0, generateId: () => "g1" });
    engine.addGoal({ prompt: "p", mode: "recurring", interval_ms: 3_600_000 });

    await engine.runNow("g1");
    expect(engine.getState().goals[0]?.last_manifest_signed).toBe(true);

    nextResult = { outcome: "error", error: "boom" };
    await engine.runNow("g1");
    expect(engine.getState().goals[0]?.last_manifest_signed).toBeNull();
  });

  it("skipped: next_run_at unchanged (retried on next tick)", async () => {
    const { adapter } = makeAdapter(async () => ({ outcome: "skipped" }));
    let n = 100;
    const engine = createGoalsEngine(adapter, { now: () => n, generateId: () => "g1" });
    const goal = engine.addGoal({ prompt: "p", mode: "recurring", interval_ms: 3_600_000 });
    const originalNext = goal.next_run_at;
    n = 5_000_000;
    await engine.runNow("g1");
    expect(engine.getState().goals[0]?.next_run_at).toBe(originalNext);
    expect(engine.getState().runs[0]?.status).toBe("skipped");
  });

  it("wraps adapter.fire() throws as error outcome", async () => {
    const { adapter } = makeAdapter(async () => {
      throw new Error("boom");
    });
    const engine = createGoalsEngine(adapter, { now: () => 0, generateId: () => "g1" });
    engine.addGoal({ prompt: "p", interval_ms: 0, mode: "once" });
    const result = await engine.runNow("g1");
    expect(result.outcome).toBe("error");
    if (result.outcome === "error") expect(result.error).toBe("boom");
  });

  it("runNow for missing goal returns error without side effects", async () => {
    const { adapter, fireCalls } = makeAdapter(async () => ({ outcome: "fired" }));
    const engine = createGoalsEngine(adapter);
    const result = await engine.runNow("nope");
    expect(result.outcome).toBe("error");
    expect(fireCalls).toHaveLength(0);
  });

  it("runNow forwards the onChunk callback to fire", async () => {
    const seenChunks: unknown[] = [];
    const { stores } = makeAdapter(async () => ({ outcome: "fired" }));
    const adapter = {
      loadGoals: () => stores.goals,
      saveGoals: (g: ScheduledGoal[]) => {
        stores.goals = g;
      },
      loadRuns: () => stores.runs,
      saveRuns: (r: GoalRunRecord[]) => {
        stores.runs = r;
      },
      async fire(_goal: ScheduledGoal, onChunk?: (c: unknown) => void): Promise<GoalFireResult> {
        onChunk?.({ type: "plan_created" });
        return { outcome: "fired", responsePreview: "done" };
      },
    };
    const engine = createGoalsEngine(adapter, { now: () => 0, generateId: () => "g1" });
    engine.addGoal({ prompt: "p", interval_ms: 0, mode: "once" });
    await engine.runNow("g1", (c) => seenChunks.push(c));
    expect(seenChunks).toHaveLength(1);
  });
});

describe("createGoalsEngine — tick", () => {
  it("tick skips once goals — they only fire via runNow", async () => {
    const fired: string[] = [];
    const { adapter } = makeAdapter(async (g) => {
      fired.push(g.goal_id);
      return { outcome: "fired" };
    });
    const tickHolder: { fn: (() => void) | null } = { fn: null };
    const engine = createGoalsEngine(adapter, {
      now: () => 10_000_000,
      generateId: () => "once-1",
      setInterval: (h) => {
        tickHolder.fn = h;
        return 1 as unknown as ReturnType<typeof setInterval>;
      },
      clearInterval: () => {},
    });
    engine.addGoal({ prompt: "x", interval_ms: 0, mode: "once" });
    engine.start();
    tickHolder.fn?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(fired).toHaveLength(0);
  });
});

describe("createGoalsEngine — budget envelope (tokens axis)", () => {
  it("addGoal persists budget_tokens and zeroes spent_tokens", () => {
    const { adapter, stores } = makeAdapter(async () => ({ outcome: "fired" }));
    const engine = createGoalsEngine(adapter, { now: () => 0, generateId: () => "g1" });
    const goal = engine.addGoal({
      prompt: "x",
      mode: "recurring",
      interval_ms: 3_600_000,
      budget_tokens: 50_000,
    });
    expect(goal.budget_tokens).toBe(50_000);
    expect(goal.spent_tokens).toBe(0);
    expect(stores.goals[0]?.budget_tokens).toBe(50_000);
  });

  it("fired result with tokensUsed accumulates spent_tokens", async () => {
    const { adapter } = makeAdapter(async () => ({
      outcome: "fired",
      responsePreview: "ok",
      tokensUsed: 7_500,
    }));
    const engine = createGoalsEngine(adapter, { now: () => 0, generateId: () => "g1" });
    engine.addGoal({
      prompt: "x",
      mode: "recurring",
      interval_ms: 3_600_000,
      budget_tokens: 50_000,
    });
    await engine.runNow("g1");
    expect(engine.getState().goals[0]?.spent_tokens).toBe(7_500);
    await engine.runNow("g1");
    expect(engine.getState().goals[0]?.spent_tokens).toBe(15_000);
  });

  it("fired without tokensUsed leaves spent_tokens monotonic (no NaN)", async () => {
    const { adapter } = makeAdapter(async () => ({ outcome: "fired" }));
    const engine = createGoalsEngine(adapter, { now: () => 0, generateId: () => "g1" });
    engine.addGoal({
      prompt: "x",
      mode: "recurring",
      interval_ms: 3_600_000,
      budget_tokens: 50_000,
    });
    await engine.runNow("g1");
    expect(engine.getState().goals[0]?.spent_tokens).toBe(0);
  });

  it("crossing the cap on a recurring fire transitions to budget_exhausted", async () => {
    const { adapter } = makeAdapter(async () => ({
      outcome: "fired",
      responsePreview: "ok",
      tokensUsed: 60_000,
    }));
    const engine = createGoalsEngine(adapter, { now: () => 0, generateId: () => "g1" });
    engine.addGoal({
      prompt: "x",
      mode: "recurring",
      interval_ms: 3_600_000,
      budget_tokens: 50_000,
    });
    await engine.runNow("g1");
    expect(engine.getState().goals[0]?.status).toBe("budget_exhausted");
  });

  it("budget_exhausted goals are skipped by the tick (auto-pause synthesis)", async () => {
    const fired: string[] = [];
    const { adapter } = makeAdapter(async (g) => {
      fired.push(g.goal_id);
      return { outcome: "fired", tokensUsed: 0 };
    });
    const tickHolder: { fn: (() => void) | null } = { fn: null };
    let nowMs = 0;
    const engine = createGoalsEngine(adapter, {
      now: () => nowMs,
      generateId: () => "g1",
      setInterval: (h) => {
        tickHolder.fn = h;
        return 1 as unknown as ReturnType<typeof setInterval>;
      },
      clearInterval: () => {},
    });
    const goal = engine.addGoal({
      prompt: "x",
      mode: "recurring",
      interval_ms: 3_600_000,
      budget_tokens: 100,
    });
    // Force the goal into budget_exhausted by spending past the cap.
    engine.setBudgetTokens(goal.goal_id, 0);
    expect(engine.getState().goals[0]?.status).toBe("budget_exhausted");
    nowMs = 10_000_000;
    engine.start();
    tickHolder.fn?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(fired).toHaveLength(0);
  });

  it("setBudgetTokens raises cap and flips budget_exhausted back to active", () => {
    const { adapter } = makeAdapter(async () => ({ outcome: "fired" }));
    const engine = createGoalsEngine(adapter, { now: () => 0, generateId: () => "g1" });
    engine.addGoal({ prompt: "x", mode: "recurring", interval_ms: 3_600_000, budget_tokens: 100 });
    // Synthesize exhaustion via setBudgetTokens(0) — same shape as a
    // real exhausted goal after a high-token fire.
    engine.setBudgetTokens("g1", 0);
    expect(engine.getState().goals[0]?.status).toBe("budget_exhausted");
    engine.setBudgetTokens("g1", 50_000);
    expect(engine.getState().goals[0]?.status).toBe("active");
  });

  it("setBudgetTokens(null) clears the cap and returns to active", () => {
    const { adapter } = makeAdapter(async () => ({ outcome: "fired" }));
    const engine = createGoalsEngine(adapter, { now: () => 0, generateId: () => "g1" });
    engine.addGoal({ prompt: "x", mode: "recurring", interval_ms: 3_600_000, budget_tokens: 100 });
    engine.setBudgetTokens("g1", 0);
    expect(engine.getState().goals[0]?.status).toBe("budget_exhausted");
    engine.setBudgetTokens("g1", null);
    expect(engine.getState().goals[0]?.budget_tokens).toBeNull();
    expect(engine.getState().goals[0]?.status).toBe("active");
  });

  it("terminal status (completed/failed) is immune to cap re-evaluation", async () => {
    const { adapter } = makeAdapter(async () => ({
      outcome: "fired",
      responsePreview: "done",
      tokensUsed: 25,
    }));
    const engine = createGoalsEngine(adapter, { now: () => 0, generateId: () => "g1" });
    engine.addGoal({ prompt: "x", interval_ms: 0, mode: "once", budget_tokens: 50 });
    await engine.runNow("g1");
    expect(engine.getState().goals[0]?.status).toBe("completed");
    engine.setBudgetTokens("g1", 0);
    expect(engine.getState().goals[0]?.status).toBe("completed");
  });
});

describe("createGoalsEngine — dispose + start/stop", () => {
  it("dispose stops the tick and blocks emissions", () => {
    const clearCalls: unknown[] = [];
    const { adapter } = makeAdapter(async () => ({ outcome: "fired" }));
    const engine = createGoalsEngine(adapter, {
      setInterval: () => 42 as unknown as ReturnType<typeof setInterval>,
      clearInterval: (h) => {
        clearCalls.push(h);
      },
    });
    engine.start();
    engine.dispose();
    expect(clearCalls).toEqual([42]);
    const listener = vi.fn();
    engine.subscribe(listener);
    engine.addGoal({ prompt: "x", interval_ms: 0, mode: "once" });
    expect(listener).toHaveBeenCalled();
  });

  it("start is idempotent", () => {
    const calls: number[] = [];
    const { adapter } = makeAdapter(async () => ({ outcome: "fired" }));
    const engine = createGoalsEngine(adapter, {
      setInterval: () => {
        const handle = calls.length;
        calls.push(handle);
        return handle as unknown as ReturnType<typeof setInterval>;
      },
      clearInterval: () => {},
    });
    engine.start();
    engine.start();
    expect(calls).toHaveLength(1);
  });
});
