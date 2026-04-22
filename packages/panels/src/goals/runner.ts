// Goals runner — the daemon-role primitive for surfaces that ARE the daemon.
//
// Web does not delegate goal execution to a Rust process; the browser tab
// is the daemon. This runner holds the in-memory source of truth for the
// goal list + run records, ticks on a 30s cadence, and fires due recurring
// goals through the adapter's `fire` contract. Once goals require explicit
// runNow — the tick skips them by design so Goals-panel UX ("click Execute")
// still works.
//
// Concurrency:
//   - One fire in flight at a time. A second due goal waits for the first.
//     The adapter's fire() may return `skipped` (e.g. user turn is in
//     flight) — the runner leaves next_run_at alone and retries next tick.
//   - Ticks are re-entrant-safe: an overlapping tick queues behind the
//     previous via the tickInFlight guard.
//
// Persistence:
//   - Goals + runs persist through the adapter on every mutation. The
//     adapter owns the storage medium (localStorage, SQLite, etc).
//
// Migration:
//   - Outside this file — see `migrations.ts`. Callers migrate legacy
//     records into `ScheduledGoal` before the adapter's loadGoals() returns.

import type { GoalFireResult, GoalMode, GoalRunRecord, ScheduledGoal } from "./types.js";

const TICK_INTERVAL_MS = 30_000;
const MAX_RUN_RECORDS = 50;

const CADENCE_DEFAULTS = {
  hourly: 3_600_000,
  daily: 86_400_000,
  weekly: 604_800_000,
} as const;

/**
 * Runner adapter. Synchronous load/save keeps the hot path simple — every
 * known consumer (web localStorage) can satisfy this without buffering.
 * `fire` is the only async method: it performs the actual motebit
 * execution. The optional `onChunk` forwards streaming output (plan chunks
 * for once goals, text chunks for recurring) opaquely so renderers show
 * live progress without the package knowing runtime chunk types.
 */
export interface GoalsRunnerAdapter {
  loadGoals(): ScheduledGoal[];
  saveGoals(goals: ScheduledGoal[]): void;
  loadRuns(): GoalRunRecord[];
  saveRuns(runs: GoalRunRecord[]): void;
  fire(goal: ScheduledGoal, onChunk?: (chunk: unknown) => void): Promise<GoalFireResult>;
}

export interface GoalsRunnerState {
  goals: ScheduledGoal[];
  runs: GoalRunRecord[];
}

export interface NewGoalRunnerInput {
  prompt: string;
  mode: GoalMode;
  /** Named cadence for recurring goals; ignored when mode === "once". */
  cadence?: "hourly" | "daily" | "weekly" | "custom";
  /** Explicit interval in ms — used when cadence === "custom". */
  interval_ms?: number;
}

export interface GoalsRunnerDeps {
  /** Injected for testability. */
  now?: () => number;
  setInterval?: (handler: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearInterval?: (handle: ReturnType<typeof setInterval>) => void;
  generateId?: () => string;
}

export interface GoalsRunner {
  getState(): GoalsRunnerState;
  subscribe(listener: (state: GoalsRunnerState) => void): () => void;
  addGoal(input: NewGoalRunnerInput): ScheduledGoal;
  setPaused(goalId: string, paused: boolean): void;
  removeGoal(goalId: string): void;
  /**
   * Trigger a goal run explicitly. Works for any goal regardless of mode —
   * once goals require this call to execute at all (the background tick
   * skips them). `onChunk` forwards live streaming output for surfaces
   * that render plan/text progress inline.
   */
  runNow(goalId: string, onChunk?: (chunk: unknown) => void): Promise<GoalFireResult>;
  start(): void;
  stop(): void;
  dispose(): void;
}

function defaultGenerateId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function createGoalsRunner(
  adapter: GoalsRunnerAdapter,
  deps: GoalsRunnerDeps = {},
): GoalsRunner {
  const now = deps.now ?? (() => Date.now());
  const generateId = deps.generateId ?? defaultGenerateId;
  const scheduleTick = deps.setInterval ?? ((h, ms) => setInterval(h, ms));
  const cancelTick = deps.clearInterval ?? ((h) => clearInterval(h));

  let state: GoalsRunnerState = {
    goals: adapter.loadGoals(),
    runs: adapter.loadRuns(),
  };

  const listeners = new Set<(state: GoalsRunnerState) => void>();
  let tickHandle: ReturnType<typeof setInterval> | null = null;
  let disposed = false;
  let tickInFlight = false;

  function emit(): void {
    for (const listener of listeners) listener(state);
  }

  function persistGoals(): void {
    adapter.saveGoals(state.goals);
  }

  function persistRuns(): void {
    adapter.saveRuns(state.runs);
  }

  function appendRun(run: GoalRunRecord): void {
    const runs = [run, ...state.runs].slice(0, MAX_RUN_RECORDS);
    state = { ...state, runs };
    persistRuns();
    emit();
  }

  function updateRun(runId: string, patch: Partial<GoalRunRecord>): void {
    const runs = state.runs.map((r) => (r.run_id === runId ? { ...r, ...patch } : r));
    state = { ...state, runs };
    persistRuns();
    emit();
  }

  function updateGoal(goalId: string, patch: Partial<ScheduledGoal>): void {
    const goals = state.goals.map((g) => (g.goal_id === goalId ? { ...g, ...patch } : g));
    state = { ...state, goals };
    persistGoals();
    emit();
  }

  function computeIntervalMs(input: NewGoalRunnerInput): number {
    if (input.mode === "once") return 0;
    if (input.cadence === "custom" && typeof input.interval_ms === "number") {
      return Math.max(0, input.interval_ms);
    }
    if (input.cadence === "hourly") return CADENCE_DEFAULTS.hourly;
    if (input.cadence === "daily") return CADENCE_DEFAULTS.daily;
    if (input.cadence === "weekly") return CADENCE_DEFAULTS.weekly;
    return CADENCE_DEFAULTS.daily;
  }

  function addGoal(input: NewGoalRunnerInput): ScheduledGoal {
    const createdAt = now();
    const interval = computeIntervalMs(input);
    const goal: ScheduledGoal = {
      goal_id: generateId(),
      prompt: input.prompt,
      interval_ms: interval,
      mode: input.mode,
      status: "active",
      enabled: true,
      created_at: createdAt,
      last_run_at: null,
      // Recurring goals schedule against cadence; once goals require
      // explicit runNow (background tick skips them — Goals-panel UX).
      next_run_at: input.mode === "once" ? undefined : createdAt + interval,
    };
    state = { ...state, goals: [...state.goals, goal] };
    persistGoals();
    emit();
    return goal;
  }

  function setPaused(goalId: string, paused: boolean): void {
    const goal = state.goals.find((g) => g.goal_id === goalId);
    if (!goal) return;
    // Terminal states are immune. Completed / failed goals stay put.
    if (goal.status === "completed" || goal.status === "failed") return;
    updateGoal(goalId, {
      status: paused ? "paused" : "active",
      enabled: !paused,
    });
  }

  function removeGoal(goalId: string): void {
    const goals = state.goals.filter((g) => g.goal_id !== goalId);
    state = { ...state, goals };
    persistGoals();
    emit();
  }

  async function runGoalOnce(
    goal: ScheduledGoal,
    onChunk?: (chunk: unknown) => void,
  ): Promise<GoalFireResult> {
    const runId = generateId();
    const startedAt = now();
    appendRun({
      run_id: runId,
      goal_id: goal.goal_id,
      started_at: startedAt,
      finished_at: null,
      status: "running",
    });

    let result: GoalFireResult;
    try {
      result = await adapter.fire(goal, onChunk);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result = { outcome: "error", error: msg };
    }

    const finishedAt = now();
    const runStatus: GoalRunRecord["status"] =
      result.outcome === "fired" ? "fired" : result.outcome === "skipped" ? "skipped" : "error";
    updateRun(runId, {
      finished_at: finishedAt,
      status: runStatus,
      response_preview: result.outcome === "fired" ? (result.responsePreview ?? null) : null,
      error_message: result.outcome === "error" ? result.error : null,
    });

    const patch: Partial<ScheduledGoal> = { last_run_at: finishedAt };
    if (result.outcome === "fired") {
      patch.last_response_preview = result.responsePreview ?? null;
      patch.last_error = null;
      if (goal.mode === "once") {
        patch.status = "completed";
      } else {
        patch.next_run_at = finishedAt + goal.interval_ms;
      }
    } else if (result.outcome === "error") {
      patch.last_error = result.error;
      if (goal.mode === "once") {
        patch.status = "failed";
      } else {
        patch.next_run_at = finishedAt + goal.interval_ms;
      }
    }
    // `skipped` leaves next_run_at alone — next tick retries.
    updateGoal(goal.goal_id, patch);
    return result;
  }

  async function runNow(
    goalId: string,
    onChunk?: (chunk: unknown) => void,
  ): Promise<GoalFireResult> {
    const goal = state.goals.find((g) => g.goal_id === goalId);
    if (!goal) return { outcome: "error", error: "goal not found" };
    return runGoalOnce(goal, onChunk);
  }

  async function tick(): Promise<void> {
    if (disposed || tickInFlight) return;
    tickInFlight = true;
    try {
      const t = now();
      // Tick auto-fires only recurring goals. Once goals must be
      // runNow-triggered — see addGoal's next_run_at assignment.
      const due = state.goals.filter(
        (g) =>
          g.mode === "recurring" &&
          g.status === "active" &&
          g.enabled !== false &&
          typeof g.next_run_at === "number" &&
          g.next_run_at <= t,
      );
      for (const goal of due) {
        if (disposed) return;
        await runGoalOnce(goal);
      }
    } finally {
      tickInFlight = false;
    }
  }

  function start(): void {
    if (tickHandle != null || disposed) return;
    tickHandle = scheduleTick(() => {
      void tick();
    }, TICK_INTERVAL_MS);
  }

  function stop(): void {
    if (tickHandle == null) return;
    cancelTick(tickHandle);
    tickHandle = null;
  }

  function subscribe(listener: (state: GoalsRunnerState) => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  function getState(): GoalsRunnerState {
    return state;
  }

  function dispose(): void {
    disposed = true;
    stop();
    listeners.clear();
  }

  return {
    getState,
    subscribe,
    addGoal,
    setPaused,
    removeGoal,
    runNow,
    start,
    stop,
    dispose,
  };
}
