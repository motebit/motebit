// Surface-agnostic state controller for the scheduled-goals panel.
//
// Scope note: this controller covers desktop + mobile only. Web's "goals"
// panel is a different feature (one-shot execute-on-demand via streaming
// plan chunks, backed by localStorage) and stays outside the extraction.
// Per the diagnostic that led to this controller, forcing all three into
// one state layer would either break web's one-shot semantics or force
// desktop/mobile to lose the scheduled-daemon model.
//
// Shared state lifted here:
//   - goal list (fetched via adapter)
//   - CRUD (add / setEnabled / remove)
//   - loading + error surfaces preserve previous-good state on failure
//
// Surface-specific state that stays inline:
//   - desktop plan progress card + recent outcomes + plan history + tool audit
//   - mobile add-form input state (prompt, interval, mode)

// ── Shape ─────────────────────────────────────────────────────────────

export type GoalMode = "recurring" | "once";

/**
 * Goal lifecycle states. Desktop uses "active" | "paused" | "suspended"
 * (the suspended state = retry-backoff, not user-paused). Mobile adds
 * "completed" and "failed" for one-shot goals. A string fallback keeps the
 * renderer forgiving to relay/daemon additions.
 */
export type GoalStatus = "active" | "paused" | "suspended" | "completed" | "failed";

/**
 * The unified shape the two surfaces agree on. Mobile has the richer model
 * (tracked retries, last_run_at, enabled flag separate from status); desktop
 * implements a subset and leaves the extras undefined.
 */
export interface ScheduledGoal {
  goal_id: string;
  prompt: string;
  interval_ms: number;
  mode: GoalMode;
  status: GoalStatus | string;
  /** Mobile-only today. Desktop infers enabled from status !== "paused". */
  enabled?: boolean;
  last_run_at?: number | null;
  consecutive_failures?: number;
  max_retries?: number;
  created_at?: number;
}

// ── Adapter ──────────────────────────────────────────────────────────

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
}

// ── State ────────────────────────────────────────────────────────────

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

// ── Controller ────────────────────────────────────────────────────────

export interface GoalsController {
  getState(): GoalsState;
  subscribe(listener: (state: GoalsState) => void): () => void;
  refresh(): Promise<void>;
  addGoal(input: NewGoalInput): Promise<void>;
  setEnabled(goalId: string, enabled: boolean): Promise<void>;
  removeGoal(goalId: string): Promise<void>;
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
    dispose,
  };
}
