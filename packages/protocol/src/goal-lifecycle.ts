/**
 * Goal-lifecycle event payload types — wire format for `goal-lifecycle-v1.md`.
 *
 * A goal is the unit of intent a motebit owns: a prompt plus scheduling +
 * progress metadata. Goals sync across a user's devices via the event log
 * substrate — a second device joining the identity replays the ledger and
 * reconstructs the goal set without contacting the originating device
 * directly. Because the ledger crosses device boundaries, the payload of
 * every goal-lifecycle event must be pinned as a wire-format type so a
 * non-TypeScript implementer (Python daemon, Go federation peer, browser
 * worker that doesn't bundle this package) validates payloads against the
 * committed JSON Schema rather than TypeScript's structural view.
 *
 * Five event types cover the full lifecycle:
 *   1. `goal_created`  — initial declaration OR a yaml-driven revision
 *   2. `goal_executed` — a run completed with a summary, tool count, etc.
 *   3. `goal_progress` — narrative progress note emitted mid-run
 *   4. `goal_completed` — goal reached its terminal state (success / failure)
 *   5. `goal_removed`  — goal deleted, either user-initiated or yaml-pruned
 *
 * Every type named here is referenced by a `### X.Y — Name` section under a
 * `#### Wire format (foundation law)` block in `spec/goal-lifecycle-v1.md`,
 * so `check-spec-coverage` (invariant #9) keeps the spec and types in
 * lockstep. Implementing package declaration lives in
 * `packages/runtime/package.json`'s `motebit.implements` array, enforced by
 * `check-spec-impl-coverage` (invariant #31).
 */

/**
 * Emitted when a goal is declared. Two shapes in current emitters:
 *
 *  - **Initial creation** — carries `prompt` (the intent text) plus optional
 *    scheduler metadata.
 *  - **Revision** — carries `update: true` alongside `goal_id` and the
 *    updated routine metadata. `prompt` MAY be absent when only scheduling
 *    metadata changed.
 *
 * The distinction is in-band via the `update` marker. A future spec
 * revision MAY split these into two event types (`goal_created` vs
 * `goal_updated`), but v1 keeps them merged to match the shipping emitter
 * flow in `apps/cli/src/subcommands/up.ts`.
 */
export interface GoalCreatedPayload {
  /** Stable identifier of the goal. UUID v4 at creation; stable across revisions. */
  readonly goal_id: string;
  /** Natural-language goal text. REQUIRED on initial creation; MAY be absent on revision. */
  readonly prompt?: string;
  /** Scheduling cadence in milliseconds. MAY be absent for one-shot goals. */
  readonly interval_ms?: number;
  /** Scheduling mode — `"recurring"`, `"once"`, or a future-reserved variant. */
  readonly mode?: string;
  /** Wall-clock anchor for the first run (Unix milliseconds). */
  readonly wall_clock_ms?: number;
  /** User-facing project grouping, opaque to the protocol. */
  readonly project_id?: string;
  /** Source routine id when the goal was materialized from a motebit.yaml routine. */
  readonly routine_id?: string;
  /** Free-text source attribution for the routine (e.g. yaml file path). */
  readonly routine_source?: string;
  /** Canonical hash of the source routine. Used by revision flows to detect drift. */
  readonly routine_hash?: string;
  /** Marker set on yaml-driven revisions; absent on initial creation. */
  readonly update?: true;
}

/**
 * Emitted when a goal run finishes (successfully or otherwise). Distinct
 * from `goal_completed`: `goal_executed` records each run's outcome,
 * `goal_completed` records the terminal transition of a one-shot goal or
 * a user-initiated completion. A recurring goal can emit many
 * `goal_executed` events and at most one `goal_completed`.
 */
export interface GoalExecutedPayload {
  readonly goal_id: string;
  /** Up to ~200 characters of the agent's response text for this run. */
  readonly summary?: string;
  /** Number of tool calls performed during the run. */
  readonly tool_calls?: number;
  /** Number of memory nodes formed during the run. */
  readonly memories?: number;
}

/**
 * Narrative progress note emitted by the `report_progress` tool during a
 * goal run. Distinct from `goal_executed`: progress notes are events
 * within a run; `goal_executed` records the run's terminal outcome.
 */
export interface GoalProgressPayload {
  readonly goal_id: string;
  /** Free-text progress narration from the agent. */
  readonly note: string;
}

/**
 * Emitted when a goal reaches its terminal state. Two paths today:
 *
 *  - Agent-driven: the `complete_goal` tool is invoked with a `reason`.
 *  - One-shot auto-complete: a one-shot goal finishes its single run
 *    without the agent invoking the tool; the scheduler emits the event
 *    with `reason: "one-shot auto-complete"`.
 *
 * Recurring goals do not emit `goal_completed` until the user removes
 * them (→ `goal_removed`).
 */
export interface GoalCompletedPayload {
  readonly goal_id: string;
  /** Free-text rationale for completion. Consumers MUST NOT parse it semantically. */
  readonly reason?: string;
  /**
   * Terminal status — `"completed" | "failed" | "suspended"`. Optional in
   * v1 for back-compat with emitters that shipped before the field was
   * added. Future spec versions MAY tighten this to required.
   */
  readonly status?: string;
}

/**
 * Emitted when a goal is deleted. Sources include the `motebit goal
 * remove` CLI command and yaml re-apply operations that prune goals no
 * longer declared in the source routine file. The original `goal_created`
 * event persists in the log; storage adapters MUST retain it.
 */
export interface GoalRemovedPayload {
  readonly goal_id: string;
  /** Source routine id when the removal was yaml-pruned. */
  readonly routine_id?: string;
  /** Free-text rationale (e.g. `"yaml_pruned"` or a user reason). */
  readonly reason?: string;
}
