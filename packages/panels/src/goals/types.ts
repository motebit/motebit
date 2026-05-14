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
 * `budget_exhausted` is set fail-closed by the runtime when **any
 * axis** of the goal's bounded-commitment envelope is exhausted before
 * the next fire. Per `docs/doctrine/panel-temporal-registers.md`
 * §"Bounded commitment is multi-dimensional" — the runtime register
 * makes commitments visible; the budget envelope is the cap on that
 * commitment across every dimension the goal consumes resource in.
 * v1 ships only the `tokens` axis but the status is intentionally
 * axis-agnostic; surfaces use `BudgetCheckResult.exhausted_axis` from
 * `@motebit/runtime` to render axis-specific copy ("Token budget
 * exhausted", "Voice-minutes exhausted", ...). Overflow is a state
 * the user must consciously resolve (raise the cap on the exhausted
 * axis, or close the goal).
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

  /** Preview of the most recent successful response (runner-populated).
   *  Truncated to ~160 chars for card-meta display. Renderers prefer
   *  `last_response_full` when present (longer preview / slab handoff
   *  per `docs/doctrine/goal-results.md` §"The three categories"). */
  last_response_preview?: string | null;

  /** Full result content from the most recent successful fire — the
   *  **artifact** per `docs/doctrine/goal-results.md`. Populated when
   *  the adapter's fire() returns `responseFull`. Today rendered as a
   *  longer in-card preview (~500 chars / first paragraph); future
   *  (Phase 3 of the goal-results arc) wraps as a signed
   *  `ContentArtifactManifest` per `docs/doctrine/receipts-unified.md`
   *  and routes to the slab as a mind-mode slab item. Cleared on
   *  error fires the same way `last_response_preview` is, so the
   *  surfaced "latest outcome" stays honest. */
  last_response_full?: string | null;

  /** Error message from the most recent failed run (runner-populated). */
  last_error?: string | null;

  consecutive_failures?: number;
  max_retries?: number;
  created_at?: number;

  /**
   * v1 axis of the multi-dimensional bounded-commitment envelope per
   * `docs/doctrine/panel-temporal-registers.md` §"Bounded commitment
   * is multi-dimensional". Token cap on inference work (input +
   * output, summed across runs). `null` or absent = no cap on this
   * axis. Tokens is the only doctrinally-clean axis available today —
   * every provider mode (motebit-cloud, BYOK, on-device) generates
   * tokens, so the cap means the same thing everywhere; USD would
   * bake cloud-mode assumptions and break for BYOK / on-device.
   * Future axes (`budget_voice_seconds`, `budget_tool_calls`,
   * `budget_wall_clock_ms`, ...) land as additive sibling fields; this
   * one is not renamed.
   */
  budget_tokens?: number | null;

  /**
   * Total tokens consumed across all runs of this goal so far —
   * derived rollup, not a maintained counter. Daemons/runners
   * populate by summing `goal_outcomes.tokens_used` for `goal_id`.
   * Renderers compare against `budget_tokens` to draw the envelope
   * at axis-native scale ("Inference: 12k/50k tokens"); cost
   * translation ("· ≈$0.30 on Sonnet") is additive disclosure when
   * computable, never the headline. The runtime's `checkGoalBudget`
   * helper (`@motebit/runtime`) accepts per-axis `{ cap, spent }`
   * records and pauses the goal with `status="budget_exhausted"` on
   * first-axis-exhausted; multi-axis surfaces will populate
   * `spent_voice_seconds` etc. alongside this.
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
 *
 * `tokensUsed` rides on `fired` / `error` outcomes so the runner can roll
 * up `spent_tokens` per goal for the v1 axis of the bounded-commitment
 * envelope. Omitted means "this fire didn't report token usage" — legacy
 * adapters, plan-mode goals before plan-side token tracking lands, etc.
 * The runner adds nothing when omitted (same behavior as zero); the
 * doctrine cares about monotonic accumulation, not perfect attribution.
 * See `docs/doctrine/panel-temporal-registers.md` §"Bounded commitment is
 * multi-dimensional" and `ScheduledGoal.spent_tokens`.
 */
export type GoalFireResult =
  | {
      outcome: "fired";
      responsePreview?: string | null;
      /** Full result content — the artifact. Untruncated text the
       *  adapter accumulated during the fire. Runner stores as
       *  `goal.last_response_full`. See `docs/doctrine/goal-results.md`
       *  §"The three categories" for the architectural intent
       *  (Phase 2 content preservation; Phase 3 routes to the slab
       *  as a `mind`-mode slab item with `ContentArtifactManifest`
       *  signing). Omit when the adapter doesn't (yet) carry the
       *  full content. */
      responseFull?: string;
      tokensUsed?: number;
    }
  | { outcome: "skipped" }
  | { outcome: "error"; error: string; tokensUsed?: number };
