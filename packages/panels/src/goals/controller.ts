// Surface-agnostic CRUD controller for daemon-backed goals.
//
// This controller reads goal state through an adapter — the adapter
// implementation decides whether that's a Rust daemon (desktop), SQLite +
// expo store (mobile), or relay fetch. Surfaces that ARE the daemon (web)
// use the sibling `createGoalsRunner` instead, which owns fire + run state.
//
// Shared state lifted here:
//   - goal list (fetched via adapter)
//   - CRUD (add / setEnabled / remove)
//   - loading + error surfaces preserve previous-good state on failure
//
// Surface-specific state that stays inline:
//   - desktop plan progress card + recent outcomes + plan history + tool audit
//   - mobile add-form input state (prompt, interval, mode)
//
// See `docs/doctrine/goals-vs-tasks.md` for the goal/task distinction and
// `packages/panels/src/goals/types.ts` for the canonical shape.

import type { GoalMode, GoalStatus, ScheduledGoal } from "./types.js";

export type { GoalMode, GoalStatus, ScheduledGoal };

// ── Adapter ──────────────────────────────────────────────────────────────

/**
 * Input for a new goal. Same shape both surfaces need. The controller
 * doesn't assign the goal_id — the adapter's implementation does (desktop
 * uses crypto.randomUUID; mobile's SQLite store generates one).
 */
export interface NewGoalInput {
  prompt: string;
  interval_ms: number;
  mode: GoalMode;
}

export interface GoalsFetchAdapter {
  listGoals(): Promise<ScheduledGoal[]>;
  addGoal(input: NewGoalInput): Promise<void>;
  /**
   * Toggle the enabled state. Mobile respects the explicit `enabled` flag.
   * Desktop's current Rust daemon flips based on current state regardless
   * of the argument — the controller passes `enabled` through and trusts
   * the adapter to do the right thing per surface.
   */
  setEnabled(goalId: string, enabled: boolean): Promise<void>;
  removeGoal(goalId: string): Promise<void>;
  /**
   * Trigger an immediate run of a recurring goal, bypassing cadence.
   * Optional — surfaces whose daemon doesn't expose a direct-fire path
   * may omit this. When absent, the controller does not surface
   * `runNow`, letting UIs hide the affordance via `if (ctrl.runNow)`.
   */
  runNow?(goalId: string): Promise<void>;
}

// ── State ────────────────────────────────────────────────────────────────

export interface GoalsState {
  goals: ScheduledGoal[];
  loading: boolean;
  error: string | null;
}

function initialState(): GoalsState {
  return {
    goals: [],
    loading: false,
    error: null,
  };
}

// ── Controller ───────────────────────────────────────────────────────────

export interface GoalsController {
  getState(): GoalsState;
  subscribe(listener: (state: GoalsState) => void): () => void;
  refresh(): Promise<void>;
  addGoal(input: NewGoalInput): Promise<void>;
  setEnabled(goalId: string, enabled: boolean): Promise<void>;
  removeGoal(goalId: string): Promise<void>;
  /**
   * Present when and only when the adapter exposes `runNow`. Triggers
   * an immediate run of the goal, then refreshes state so the new
   * `last_run_at` propagates. Errors surface as `state.error`.
   */
  runNow?(goalId: string): Promise<void>;
  dispose(): void;
}

export function createGoalsController(adapter: GoalsFetchAdapter): GoalsController {
  let state = initialState();
  const listeners = new Set<(state: GoalsState) => void>();
  let disposed = false;

  function emit(next: GoalsState): void {
    state = next;
    for (const listener of listeners) listener(state);
  }

  function patch(partial: Partial<GoalsState>): void {
    if (disposed) return;
    emit({ ...state, ...partial });
  }

  async function refresh(): Promise<void> {
    if (disposed) return;
    patch({ loading: true, error: null });
    try {
      const goals = await adapter.listGoals();
      if (disposed) return;
      patch({ goals, loading: false });
    } catch (err) {
      if (disposed) return;
      patch({
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async function addGoal(input: NewGoalInput): Promise<void> {
    try {
      await adapter.addGoal(input);
      if (disposed) return;
      // Refresh so the new row reflects the adapter's authoritative state
      // (goal_id, created_at, default max_retries). Optimistic insertion
      // would require the controller to mint the id — out of scope.
      await refresh();
    } catch (err) {
      if (!disposed) {
        patch({ error: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  async function setEnabled(goalId: string, enabled: boolean): Promise<void> {
    try {
      await adapter.setEnabled(goalId, enabled);
      if (disposed) return;
      // Mutate in place so the UI shows the new state immediately; the
      // next refresh reconciles with the adapter's authoritative reading.
      const updated = state.goals.map((g) =>
        g.goal_id === goalId ? { ...g, enabled, status: enabled ? "active" : "paused" } : g,
      );
      patch({ goals: updated });
    } catch (err) {
      if (!disposed) {
        patch({ error: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  async function removeGoal(goalId: string): Promise<void> {
    try {
      await adapter.removeGoal(goalId);
      if (disposed) return;
      const remaining = state.goals.filter((g) => g.goal_id !== goalId);
      patch({ goals: remaining });
    } catch (err) {
      if (!disposed) {
        patch({ error: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  async function runNowImpl(goalId: string): Promise<void> {
    const runNow = adapter.runNow;
    if (!runNow) return;
    try {
      await runNow(goalId);
      if (disposed) return;
      // Refresh so the new `last_run_at` propagates to subscribers.
      // The goal stays in the list regardless of outcome (fired / skipped
      // / error) — runNow is invocation, not status mutation.
      await refresh();
    } catch (err) {
      if (!disposed) {
        patch({ error: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  function subscribe(listener: (state: GoalsState) => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  function getState(): GoalsState {
    return state;
  }

  function dispose(): void {
    disposed = true;
    listeners.clear();
  }

  return {
    getState,
    subscribe,
    refresh,
    addGoal,
    setEnabled,
    removeGoal,
    // Surface runNow only if the adapter does. UIs check presence.
    ...(adapter.runNow ? { runNow: runNowImpl } : {}),
    dispose,
  };
}
