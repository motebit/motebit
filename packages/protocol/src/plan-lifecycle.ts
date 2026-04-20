/**
 * Plan-lifecycle event payload types — wire format for `plan-lifecycle-v1.md`.
 *
 * A plan is the execution backbone for a goal: an ordered list of steps,
 * each with its own description, status, and tool-call accounting. Plans
 * are created and advanced by `@motebit/runtime`'s plan-execution
 * orchestrator; events are emitted at every state transition so the event
 * log captures an append-only audit trail of every plan run.
 *
 * Because plans cross device boundaries (multi-device sync replays plan
 * history) and delegation boundaries (when a step is delegated, the
 * delegator logs the delegation; the worker logs its own plan events
 * against its own motebit_id and the result returns via
 * `AgentTaskCompleted`), the payload of every plan-lifecycle event must be
 * pinned as a wire-format type so a non-TypeScript implementer validates
 * payloads against the committed JSON Schema rather than TypeScript's
 * structural view.
 *
 * Seven event types cover the full lifecycle:
 *   1. `plan_created`        — plan materialized with N steps
 *   2. `plan_step_started`   — step N entered running state
 *   3. `plan_step_completed` — step N reached terminal success
 *   4. `plan_step_failed`    — step N reached terminal failure
 *   5. `plan_step_delegated` — step N handed off to a remote agent
 *   6. `plan_completed`      — every step finished; plan is done
 *   7. `plan_failed`         — plan terminated before completion
 *
 * Every type named here is referenced by a `### X.Y — Name` section under a
 * `#### Wire format (foundation law)` block in `spec/plan-lifecycle-v1.md`,
 * so `check-spec-coverage` (invariant #9) keeps the spec and types in
 * lockstep. Implementing package declaration lives in
 * `packages/runtime/package.json`'s `motebit.implements` array, enforced by
 * `check-spec-impl-coverage` (invariant #31).
 */

/**
 * Emitted when `@motebit/runtime`'s plan engine materializes a plan from
 * a goal or a direct prompt. Each step has its own lifecycle events; this
 * event records the top-level plan identity and step count.
 */
export interface PlanCreatedPayload {
  /** Stable identifier of the plan. UUID v4 at creation. */
  readonly plan_id: string;
  /** Human-readable title summarizing the plan's goal. */
  readonly title: string;
  /** Total number of steps the plan was materialized with. */
  readonly total_steps: number;
  /** Owning goal when the plan was created in service of a scheduled or on-demand goal. */
  readonly goal_id?: string;
}

/**
 * Emitted when a plan step transitions from `pending` to `running`. The
 * step has been chosen and the runtime is about to invoke the
 * corresponding tool or agent call.
 */
export interface PlanStepStartedPayload {
  readonly plan_id: string;
  /** Stable identifier of this step. UUID v4, unique within the plan. */
  readonly step_id: string;
  /** Zero-based position of the step within its plan. */
  readonly ordinal: number;
  /** Human-readable description of what this step does. */
  readonly description: string;
  readonly goal_id?: string;
}

/**
 * Emitted when a plan step completes successfully. Carries the tool-call
 * count so consumers can reconstruct execution cost without replaying
 * every `tool_used` event. When the step was delegated, `task_id`
 * carries the delegation identifier so the terminal event joins
 * payload-directly to its `plan_step_delegated` predecessor — receivers
 * do not have to maintain a separate task→step index.
 */
export interface PlanStepCompletedPayload {
  readonly plan_id: string;
  readonly step_id: string;
  readonly ordinal: number;
  /** Number of tool calls the step performed. */
  readonly tool_calls_made: number;
  /** Delegation task id. Present iff this step was delegated (§3.7). */
  readonly task_id?: string;
  readonly goal_id?: string;
}

/**
 * Emitted when a plan step terminates in failure. Carries a free-text
 * error message; consumers MUST NOT parse it semantically. Receivers MAY
 * correlate `error` with surrounding `tool_used` events or with a receipt
 * from a delegated step, but the error string itself is implementation-
 * detail rationale.
 */
export interface PlanStepFailedPayload {
  readonly plan_id: string;
  readonly step_id: string;
  readonly ordinal: number;
  /** Error message from the failing step. */
  readonly error: string;
  /** Delegation task id. Present iff this step was delegated (§3.7). */
  readonly task_id?: string;
  readonly goal_id?: string;
}

/**
 * Emitted when a plan step is handed off to a remote agent via
 * delegation. The delegator logs this event and then waits for the
 * corresponding `AgentTaskCompleted` / `AgentTaskFailed` event to resume
 * the plan. The `task_id` is the delegation's relay-issued id; the
 * `routing_choice` (when present) carries the routing provenance picked
 * by the semiring so downstream audit can reconstruct why this agent was
 * chosen.
 */
export interface PlanStepDelegatedPayload {
  readonly plan_id: string;
  readonly step_id: string;
  readonly ordinal: number;
  /** Relay-issued task identifier. Matches the subsequent `AgentTaskCompleted.task_id`. */
  readonly task_id: string;
  /**
   * Routing provenance picked by the semiring. Opaque to this spec; the
   * motebit semiring module defines the field set. Consumers MAY read
   * known fields (trust score, latency estimate) but MUST tolerate
   * additional fields for forward compatibility.
   */
  readonly routing_choice?: Record<string, unknown>;
  readonly goal_id?: string;
}

/**
 * Emitted when every step in a plan has reached a terminal state and the
 * plan itself is considered done. A plan completes when all its steps
 * completed or when the plan engine decided to stop short (e.g. the goal
 * was achieved before the final step). Either way, `plan_completed`
 * signals the plan record is closed.
 */
export interface PlanCompletedPayload {
  readonly plan_id: string;
  readonly goal_id?: string;
}

/**
 * Emitted when a plan terminates before completion — a step failed and
 * the plan engine could not recover, the plan was cancelled, or a policy
 * gate rejected further execution. The `reason` string is free-text
 * rationale for the failure.
 */
export interface PlanFailedPayload {
  readonly plan_id: string;
  /** Free-text failure rationale. Consumers MUST NOT parse it semantically. */
  readonly reason: string;
  readonly goal_id?: string;
}
