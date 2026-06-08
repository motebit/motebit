// Goals engine — the daemon-role reconciliation core for web.
//
// Web does not delegate goal execution to a Rust process (desktop) or an
// expo-sqlite store + background scheduler (mobile); the browser tab IS the
// daemon. This engine holds the in-memory source of truth for the goal
// list + run records, ticks on a 30s cadence, and fires due recurring goals
// through the injected `fire` contract. Once goals require explicit runNow —
// the tick skips them by design so Goals-panel UX ("click Execute") works.
//
// This was previously `createGoalsRunner` in `@motebit/panels`. It moved here
// (2026-06-08) because daemon logic is platform-specific — desktop and mobile
// own their schedulers in-app (`apps/desktop/src/goal-scheduler.ts`,
// `apps/mobile/src/goal-scheduler.ts`); web's daemon belongs in apps/web too.
// The shared `@motebit/panels` package keeps only the projection controller.
// `apps/web/src/goal-scheduler.ts` composes this engine with the localStorage
// adapter + fire(); the Goals panel binds to `createGoalsController` over a
// thin adapter shim, exactly like desktop and mobile.
//
// Concurrency:
//   - One fire in flight at a time. A second due goal waits for the first.
//     The injected fire() may return `skipped` (e.g. user turn is in
//     flight) — the engine leaves next_run_at alone and retries next tick.
//   - Ticks are re-entrant-safe: an overlapping tick queues behind the
//     previous via the tickInFlight guard.
//
// Persistence:
//   - Goals + runs persist through the adapter on every mutation. The
//     adapter owns the storage medium (localStorage).

import type { NewGoalInput, ScheduledGoal } from "@motebit/panels";

const TICK_INTERVAL_MS = 30_000;
const MAX_RUN_RECORDS = 50;

// ── Web-daemon-only types ──────────────────────────────────────────────────
// These describe the web scheduler's in-memory run history + fire contract.
// They lived in `@motebit/panels/goals/types` while the runner did; they
// moved here with the engine because they're a web-daemon-only concept
// (desktop / mobile log runs server-side and never populate these).

/**
 * A single fire of a goal by the web engine. Daemon-backed surfaces log
 * runs server-side and don't populate this client-side.
 */
export interface GoalRunRecord {
  run_id: string;
  goal_id: string;
  started_at: number;
  finished_at: number | null;
  status: "running" | "fired" | "skipped" | "error";
  response_preview?: string | null;
  error_message?: string | null;
}

/**
 * Result of a single fire() call. The engine reconciles its state based on
 * the outcome: `fired` advances next_run_at and writes a success run;
 * `skipped` leaves next_run_at alone (next tick retries); `error` advances
 * next_run_at and records the failure.
 *
 * `tokensUsed` rides on `fired` / `error` outcomes so the engine can roll
 * up `spent_tokens` per goal for the v1 axis of the bounded-commitment
 * envelope. Omitted means "this fire didn't report token usage" — legacy
 * adapters, plan-mode goals before plan-side token tracking lands, etc.
 * The engine adds nothing when omitted (same behavior as zero); the
 * doctrine cares about monotonic accumulation, not perfect attribution.
 * See `docs/doctrine/panel-temporal-registers.md` §"Bounded commitment is
 * multi-dimensional" and `ScheduledGoal.spent_tokens`.
 */
export type GoalFireResult =
  | {
      outcome: "fired";
      responsePreview?: string | null;
      /** Full result content — the artifact. Untruncated text the
       *  adapter accumulated during the fire. Engine stores as
       *  `goal.last_response_full`. See `docs/doctrine/goal-results.md`
       *  §"The three categories". Omit when the adapter doesn't (yet)
       *  carry the full content. */
      responseFull?: string;
      /** Slab turn id for this fire — the navigational anchor the
       *  goal card uses to open the resting `stream`/`mind` slab item
       *  the runtime created during the fire. Computed by the adapter
       *  via `slabTurnIdForRun(runId)`. Engine stores as
       *  `goal.last_turn_id`. Adapters that don't yet thread the id
       *  omit; the engine falls back to no affordance. */
      turnId?: string;
      /** Whether the adapter wrapped this fire's artifact as a signed
       *  `ContentArtifactManifest`. Engine stores as
       *  `goal.last_manifest_signed`. Omit on adapters that don't yet
       *  wire signing — engine stores `null` and the renderer omits
       *  the indicator. Doctrine: `docs/doctrine/goal-results.md`. */
      manifestSigned?: boolean;
      tokensUsed?: number;
    }
  | { outcome: "skipped" }
  | { outcome: "error"; error: string; tokensUsed?: number };

// ── Engine ──────────────────────────────────────────────────────────────────

/**
 * Engine adapter. Synchronous load/save keeps the hot path simple — the web
 * consumer (localStorage) satisfies this without buffering. `fire` is the
 * only async method: it performs the actual motebit execution. The optional
 * `onChunk` forwards streaming output (plan chunks for once goals, text
 * chunks for recurring) opaquely so renderers show live progress without
 * the engine knowing runtime chunk types.
 */
export interface GoalsEngineAdapter {
  loadGoals(): ScheduledGoal[];
  saveGoals(goals: ScheduledGoal[]): void;
  loadRuns(): GoalRunRecord[];
  saveRuns(runs: GoalRunRecord[]): void;
  fire(goal: ScheduledGoal, onChunk?: (chunk: unknown) => void): Promise<GoalFireResult>;
}

export interface GoalsEngineState {
  goals: ScheduledGoal[];
  runs: GoalRunRecord[];
}

export interface GoalsEngineDeps {
  /** Injected for testability. */
  now?: () => number;
  setInterval?: (handler: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearInterval?: (handle: ReturnType<typeof setInterval>) => void;
  generateId?: () => string;
}

export interface GoalsEngine {
  getState(): GoalsEngineState;
  subscribe(listener: (state: GoalsEngineState) => void): () => void;
  addGoal(input: NewGoalInput): ScheduledGoal;
  /**
   * Set the goal's enabled state. `enabled: false` pauses, `true` resumes.
   * Re-evaluated against terminal states (completed / failed stay put).
   * Matches the `GoalsController` / `GoalsFetchAdapter` verb so the web
   * panel binds to the same contract as desktop + mobile.
   */
  setEnabled(goalId: string, enabled: boolean): void;
  /**
   * Raise / lower / clear the token cap on a goal. Pass `null` to remove
   * the cap entirely. Re-evaluates `budget_exhausted` synchronously so a
   * raise-cap action transitions the goal back to `active` without
   * waiting for the next tick. Pure local-state mutation; persistence
   * happens via the adapter's saveGoals on the next emit.
   */
  setBudgetTokens(goalId: string, budgetTokens: number | null): void;
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

export function createGoalsEngine(
  adapter: GoalsEngineAdapter,
  deps: GoalsEngineDeps = {},
): GoalsEngine {
  const now = deps.now ?? (() => Date.now());
  const generateId = deps.generateId ?? defaultGenerateId;
  const scheduleTick = deps.setInterval ?? ((h, ms) => setInterval(h, ms));
  const cancelTick = deps.clearInterval ?? ((h) => clearInterval(h));

  let state: GoalsEngineState = {
    goals: adapter.loadGoals(),
    runs: adapter.loadRuns(),
  };

  const listeners = new Set<(state: GoalsEngineState) => void>();
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

  function addGoal(input: NewGoalInput): ScheduledGoal {
    const createdAt = now();
    const interval = Math.max(0, input.interval_ms);
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
      // Budget cap on the tokens axis. `null`/omitted = no cap. Defense-
      // in-depth: zero is a valid cap meaning "no fires," matching the
      // runtime helper's contract.
      budget_tokens: input.budget_tokens ?? null,
      spent_tokens: 0,
    };
    state = { ...state, goals: [...state.goals, goal] };
    persistGoals();
    emit();
    return goal;
  }

  /**
   * Inline cap-check on the tokens axis. Mirrors `checkGoalBudget` in
   * `@motebit/runtime/goals.ts` for the v1 single-axis case; the
   * runtime helper is the canonical multi-axis primitive for
   * cli/desktop/mobile schedulers. Inlined here because web's engine
   * is a self-contained app module and `@motebit/panels` (whose
   * controller this engine feeds) cannot import `@motebit/runtime`.
   * When the axis union grows, extend this helper additively.
   * Re-evaluated every tick so raising the cap auto-resumes the goal
   * next fire — pause is a synthesized state, never sticky.
   */
  function tokensExhausted(goal: ScheduledGoal): boolean {
    if (goal.budget_tokens == null) return false;
    return (goal.spent_tokens ?? 0) >= goal.budget_tokens;
  }

  function setBudgetTokens(goalId: string, budgetTokens: number | null): void {
    const goal = state.goals.find((g) => g.goal_id === goalId);
    if (!goal) return;
    const next: ScheduledGoal = { ...goal, budget_tokens: budgetTokens };
    // Re-evaluate the synthesized budget_exhausted state under the new
    // cap. Raising/clearing pulls the goal back to active; lowering
    // below current spent pushes it to budget_exhausted. Terminal
    // (completed/failed) statuses are immune — caps don't reopen them.
    if (next.status !== "completed" && next.status !== "failed") {
      next.status = tokensExhausted(next) ? "budget_exhausted" : "active";
    }
    const goals = state.goals.map((g) => (g.goal_id === goalId ? next : g));
    state = { ...state, goals };
    persistGoals();
    emit();
  }

  function setEnabled(goalId: string, enabled: boolean): void {
    const goal = state.goals.find((g) => g.goal_id === goalId);
    if (!goal) return;
    // Terminal states are immune. Completed / failed goals stay put.
    if (goal.status === "completed" || goal.status === "failed") return;
    updateGoal(goalId, {
      status: enabled ? "active" : "paused",
      enabled,
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
    // Roll up `spent_tokens` from the fire's reported usage. Adapters
    // that don't carry token attribution (legacy / plan-mode) report
    // `undefined`; absent treated as zero so the rollup stays monotonic
    // without sprinkling nulls. v1 axis only — sibling axes
    // (voice_seconds, tool_calls) will land additively.
    const tokensUsed =
      result.outcome === "fired" || result.outcome === "error" ? (result.tokensUsed ?? 0) : 0;
    if (tokensUsed > 0) {
      patch.spent_tokens = (goal.spent_tokens ?? 0) + tokensUsed;
    }
    if (result.outcome === "fired") {
      patch.last_response_preview = result.responsePreview ?? null;
      // Preserve the full artifact content per
      // `docs/doctrine/goal-results.md` §"The three categories" Phase 2.
      patch.last_response_full = result.responseFull ?? null;
      // Slab navigational anchor per goal-results.md Phase 3. Absence
      // degrades to no "View result" affordance — the correct
      // calm-software fallback, better than a stale link.
      patch.last_turn_id = result.turnId ?? null;
      // Signed-manifest receipt indicator per goal-results.md. Legacy
      // adapters omit and we store `null` so the renderer omits it.
      patch.last_manifest_signed = result.manifestSigned ?? null;
      patch.last_error = null;
      if (goal.mode === "once") {
        patch.status = "completed";
      } else {
        patch.next_run_at = finishedAt + goal.interval_ms;
      }
    } else if (result.outcome === "error") {
      patch.last_error = result.error;
      // Clear-on-error symmetry: a stale prior-success preview /
      // artifact / slab anchor / signed indicator would all be
      // misleading once this fire errored. Clearing makes the error
      // the most-recent visible signal; a subsequent success
      // repopulates them above. The slab anchor especially must clear —
      // a failed turn's slab item dissolves rather than rests, so a
      // stale link would 404 the renderer's id lookup.
      patch.last_response_preview = null;
      patch.last_response_full = null;
      patch.last_turn_id = null;
      patch.last_manifest_signed = null;
      if (goal.mode === "once") {
        patch.status = "failed";
      } else {
        patch.next_run_at = finishedAt + goal.interval_ms;
      }
    }
    // `skipped` leaves next_run_at alone — next tick retries.
    // After accumulating, re-evaluate the cap. Recurring goals that
    // just exhausted their token budget transition to budget_exhausted
    // so the next tick skips them; user raises cap to resume.
    if (goal.mode === "recurring" && patch.status !== "completed" && patch.status !== "failed") {
      const projected: ScheduledGoal = {
        ...goal,
        ...patch,
        spent_tokens: patch.spent_tokens ?? goal.spent_tokens ?? 0,
      };
      if (tokensExhausted(projected)) {
        patch.status = "budget_exhausted";
      }
    }
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
      //
      // Budget gate is structural: a recurring goal whose tokens axis
      // is exhausted stays as status="budget_exhausted" and the tick
      // skips it. Raising the cap via setBudgetTokens flips the status
      // back to "active" synchronously and the next tick picks it up.
      const due = state.goals.filter(
        (g) =>
          g.mode === "recurring" &&
          g.status === "active" &&
          g.enabled !== false &&
          !tokensExhausted(g) &&
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

  function subscribe(listener: (state: GoalsEngineState) => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  function getState(): GoalsEngineState {
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
    setEnabled,
    setBudgetTokens,
    removeGoal,
    runNow,
    start,
    stop,
    dispose,
  };
}
