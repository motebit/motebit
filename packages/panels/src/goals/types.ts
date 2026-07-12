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
//   - `ScheduledGoal` — the client-facing projection. ALL surfaces read it
//     via `GoalsController` over a surface-specific adapter: desktop (Tauri
//     IPC), mobile (expo-sqlite), web (a shim over its in-process goals
//     engine — web IS the daemon, but the panel binds to the same controller
//     as the others). Run records + the fire contract are web-daemon-only and
//     live in `apps/web/src/goal-engine.ts`, not here.
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
  "active" | "paused" | "suspended" | "completed" | "failed" | "budget_exhausted";

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

  /** Slab turn id of the most recent successful fire — the navigational
   *  anchor for the goal card's "View result" affordance. The runtime
   *  already lands every turn as a resting `stream`/`mind` slab item
   *  via `projectSlabForTurn` (`motebit-runtime.ts:1660` / `:1908`).
   *  When the adapter passes an explicit `runId` to
   *  `sendMessageStreaming`, the slab item's id is computable via
   *  `slabTurnIdForRun(runId)` from `@motebit/runtime`. The adapter
   *  returns that id on `GoalFireResult.fired.turnId`; the runner
   *  persists it here; the surface reads it to render the affordance
   *  and resolve the click. Cleared symmetrically with the artifact
   *  on error fires — a failed fire's slab item dissolves rather than
   *  rests, so a stale link would 404 the renderer's id lookup.
   *  Doctrine: `docs/doctrine/goal-results.md` §"The three
   *  categories" — Phase 3 makes the existing slab item *legible* as
   *  the goal's artifact and *navigable* from the commitment card. */
  last_turn_id?: string | null;

  /** Error message from the most recent failed run (runner-populated). */
  last_error?: string | null;

  /** Whether the most recent successful fire's artifact was wrapped
   *  as a signed `ContentArtifactManifest` per
   *  `docs/doctrine/goal-results.md` §"The three categories". The
   *  goal card's receipt-summary row reads this to render the
   *  "signed" indicator next to "ran Xm ago". `true` = manifest
   *  was minted and persisted (web localStorage / desktop +
   *  mobile `goal_outcomes.signed_manifest` column); `false` =
   *  fire succeeded but signing was skipped (identity not loaded,
   *  empty content, or signing threw); `null` / absent = never
   *  run, or the adapter doesn't yet carry signing wire (legacy
   *  surfaces degrade to no indicator, which is the calm-software
   *  fallback). Cleared symmetrically with `last_response_full` on
   *  error fires so the indicator never outlives the artifact it
   *  attested. */
  last_manifest_signed?: boolean | null;

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

// Run records (`GoalRunRecord`) and the fire contract (`GoalFireResult`)
// used to live here. They moved to `apps/web/src/goal-engine.ts` (2026-06-08)
// because they describe a web-daemon-only concept — desktop / mobile log
// runs server-side and never populate them. `ScheduledGoal` stays here as
// the cross-surface projection shape every controller agrees on.
