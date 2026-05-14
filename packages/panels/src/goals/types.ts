// Shared types for the Goals family.
//
// A goal is a user-declared outcome the motebit pursues. The user declares
// **what** (the prompt, the cadence, the mode); the motebit figures out
// **how**. See `docs/doctrine/goals-vs-tasks.md` for the goal/task split —
// tasks are the emergent plan steps a goal spawns at runtime, not
// first-class scheduled entities.
//
// This file hosts the canonical shape every surface agrees on:
//
//   - `ScheduledGoal` — the client-facing projection. Desktop + mobile read
//     it via `GoalsController` (daemon-backed). Web reads and writes it via
//     `GoalsRunner` — web IS the daemon, so its runner owns the tick loop.
//
//   - `GoalRunRecord` + `GoalFireResult` — runner-only, for surfaces that
//     ARE the daemon and track in-memory run history.
//
// The persistence + protocol layers have their own richer / more signed
// shapes (`persistence.Goal`, `GoalCreatedPayload`); `ScheduledGoal` is a
// layer-appropriate projection, not the canonical record.

export type GoalMode = "recurring" | "once";

/**
 * Goal lifecycle states. A `(string & {})` fallback opens the union to
 * forward-compat daemon additions without collapsing autocomplete —
 * idiomatic TS.
 *
 * `budget_exhausted` is set fail-closed by the runtime when a goal's
 * `spent_tokens >= budget_tokens` before the next fire. Per
 * `docs/doctrine/panel-temporal-registers.md` — the runtime register
 * makes commitments visible; the budget envelope is the cap on that
 * commitment, and overflow is a state the user must consciously
 * resolve (raise the budget or close the goal).
 */
export type GoalStatus =
  | "active"
  | "paused"
  | "suspended"
  | "completed"
  | "failed"
  | "budget_exhausted";

/**
 * The client-facing goal shape. Matches what renderers subscribe to across
 * every surface; daemons and web-runners populate different optional
 * subsets.
 */
export interface ScheduledGoal {
  goal_id: string;
  prompt: string;

  /** Cadence interval in ms. Ignored when mode === "once" (conventional 0). */
  interval_ms: number;

  mode: GoalMode;

  status: GoalStatus | (string & {});

  /** Mobile-only today. Desktop infers enabled from status !== "paused". */
  enabled?: boolean;

  last_run_at?: number | null;

  /**
   * When the runner will next consider this goal. Populated by daemon-role
   * surfaces (web runner) so the UI can render a countdown. Daemon-backed
   * surfaces (desktop, mobile) may leave undefined.
   */
  next_run_at?: number;

  /** Preview of the most recent successful response (runner-populated). */
  last_response_preview?: string | null;

  /** Error message from the most recent failed run (runner-populated). */
  last_error?: string | null;

  consecutive_failures?: number;
  max_retries?: number;
  created_at?: number;

  /**
   * Per-goal budget cap in tokens (input + output, summed across runs).
   * `null` (or absent) = no cap. Tokens is the protocol-primacy-clean
   * unit per `docs/doctrine/panel-temporal-registers.md` substrate-vs-
   * accumulation: every provider mode (motebit-cloud, BYOK, on-device)
   * generates tokens, so the cap means the same thing everywhere; USD
   * would bake motebit-cloud assumptions into the goal record and
   * break for BYOK/on-device.
   */
  budget_tokens?: number | null;

  /**
   * Total tokens consumed across all runs of this goal so far. Derived
   * by the daemon/runner by summing `goal_outcomes.tokens_used` for
   * `goal_id`. Renderers compare against `budget_tokens` to draw the
   * envelope. The runtime checks `spent_tokens >= budget_tokens`
   * before fire and pauses with `status === "budget_exhausted"` when
   * the cap is reached.
   */
  spent_tokens?: number;
}

// ── Run records (runner-only) ─────────────────────────────────────────────

/**
 * A single fire of a goal by the web runner. Daemon-backed surfaces log
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
 * Result of a single fire() call. The runner reconciles its state based on
 * the outcome: `fired` advances next_run_at and writes a success run;
 * `skipped` leaves next_run_at alone (next tick retries); `error` advances
 * next_run_at and records the failure.
 */
export type GoalFireResult =
  | { outcome: "fired"; responsePreview?: string | null }
  | { outcome: "skipped" }
  | { outcome: "error"; error: string };
