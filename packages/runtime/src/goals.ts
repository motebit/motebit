/**
 * Goals primitive — the single authorship site for every `goal_*` event in
 * the `@motebit/runtime` process.
 *
 * Why this exists. `goal-lifecycle-v1.md` pins a wire-format contract for
 * five event types. Before this primitive, emission of those events lived
 * inline in `apps/cli/src/{subcommands,scheduler}.ts` and
 * `apps/desktop/src/goal-scheduler.ts` — three separate surfaces each
 * constructing the payload by hand, typed only as `Record<string, unknown>`
 * at the event-log boundary. Any of them could drift from the spec and
 * the first signal would be a cross-device state comparison test or a
 * third-party implementer complaint. Same failure mode that drove plan
 * events into a single `_logPlanChunkEvent` method on
 * `PlanExecutionManager`, and the same fix: one function, typed against
 * `@motebit/protocol`.
 *
 * Extended surface vs. the pre-existing plumbing:
 *
 *  1. **Failure emission.** The previous `GoalExecuted` emitter fired
 *     only inside the try-block of `scheduler.ts`'s run path. Failed
 *     runs wrote a `goal_outcomes` projection row with `status: "failed"`
 *     but emitted no event — a direct violation of goal-lifecycle-v1
 *     §1's "ledger is the semantic source of truth." This primitive's
 *     `executed()` accepts an `error` field; emitters in the catch
 *     path now produce a `goal_executed` with `error` set. Schema is
 *     additive; consumers that ignore `error` still see success runs.
 *
 *  2. **Terminal-state guard.** Spec §3.4 says post-terminal emission
 *     against a completed goal MUST NOT happen. Pre-primitive, this
 *     held only indirectly (the scheduler filters active goals). The
 *     primitive accepts an optional `getGoalStatus` resolver; when
 *     provided, `executed / progress / completed` calls against a goal
 *     whose status is already `"completed"` are dropped with a logger
 *     warning — no event appended.
 *
 *  3. **Type parity with the wire.** Every method takes a payload
 *     typed against `@motebit/protocol`'s `Goal*Payload`. A drift in
 *     spec §5 against the payload types breaks `tsc`; wire-schemas'
 *     existing `_TYPE_PARITY` guards make the chain zod ↔ TS ↔ JSON
 *     Schema drift-proof. Callers cannot drift the wire from here.
 *
 * Consumers instantiate via `createGoalsController(deps)` and call the
 * five methods mirroring the spec. The `MotebitRuntime` class wires one
 * up in its constructor and exposes it as `runtime.goals`.
 */

import { EventType } from "@motebit/sdk";
import type {
  GoalCreatedPayload,
  GoalExecutedPayload,
  GoalProgressPayload,
  GoalCompletedPayload,
  GoalRemovedPayload,
} from "@motebit/sdk";
import type { EventStore } from "@motebit/event-log";

/** Status values a `getGoalStatus` resolver may return; `null` means the goal is unknown to the resolver. */
export type GoalLifecycleStatus = "active" | "paused" | "completed" | "failed" | null;

export interface GoalsControllerDeps {
  motebitId: string;
  /** Event log surface. Only the append + clock methods are used. */
  events: Pick<EventStore, "append" | "getLatestClock" | "appendWithClock">;
  /**
   * Optional lookup used to enforce §3.4 terminal-state convention. When
   * provided, `executed / progress / completed` are no-ops against a
   * goal in a terminal state; when absent, the primitive trusts the
   * caller.
   */
  getGoalStatus?: (goalId: string) => GoalLifecycleStatus;
  /** Optional logger; defaults to `console.warn`. */
  logger?: { warn(message: string, context?: Record<string, unknown>): void };
}

export interface GoalsController {
  /** Emit `goal_created`. Initial creation or yaml-driven revision (§5.1). */
  created(payload: GoalCreatedPayload): Promise<void>;
  /** Emit `goal_executed` for a successful or failed run (§5.2 — `error` distinguishes). */
  executed(payload: GoalExecutedPayload): Promise<void>;
  /** Emit `goal_progress` for an in-run narrative note (§5.3). */
  progress(payload: GoalProgressPayload): Promise<void>;
  /** Emit `goal_completed` for an agent-driven or auto-completion (§5.4). */
  completed(payload: GoalCompletedPayload): Promise<void>;
  /** Emit `goal_removed` for a user- or yaml-initiated deletion (§5.5). */
  removed(payload: GoalRemovedPayload): Promise<void>;
}

const TERMINAL_STATUSES: ReadonlySet<GoalLifecycleStatus> = new Set<GoalLifecycleStatus>([
  "completed",
  "failed",
]);

export function createGoalsController(deps: GoalsControllerDeps): GoalsController {
  const { motebitId, events, getGoalStatus, logger } = deps;
  const warn = logger?.warn.bind(logger) ?? ((msg, ctx) => console.warn(msg, ctx));

  const isTerminal = (goalId: string): boolean => {
    if (!getGoalStatus) return false;
    return TERMINAL_STATUSES.has(getGoalStatus(goalId));
  };

  const emit = async (
    eventType: EventType,
    goalId: string,
    payload: Record<string, unknown>,
  ): Promise<void> => {
    try {
      await events.appendWithClock({
        event_id: crypto.randomUUID(),
        motebit_id: motebitId,
        timestamp: Date.now(),
        event_type: eventType,
        payload,
        tombstoned: false,
      });
    } catch (err: unknown) {
      warn("goal event emission failed", {
        event_type: eventType,
        goal_id: goalId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  return {
    async created(payload) {
      await emit(EventType.GoalCreated, payload.goal_id, { ...payload });
    },
    async executed(payload) {
      if (isTerminal(payload.goal_id)) {
        warn("goal_executed suppressed — goal already terminal (spec §3.4)", {
          goal_id: payload.goal_id,
        });
        return;
      }
      await emit(EventType.GoalExecuted, payload.goal_id, { ...payload });
    },
    async progress(payload) {
      if (isTerminal(payload.goal_id)) {
        warn("goal_progress suppressed — goal already terminal (spec §3.4)", {
          goal_id: payload.goal_id,
        });
        return;
      }
      await emit(EventType.GoalProgress, payload.goal_id, { ...payload });
    },
    async completed(payload) {
      if (isTerminal(payload.goal_id)) {
        warn("goal_completed suppressed — goal already terminal (spec §3.4)", {
          goal_id: payload.goal_id,
        });
        return;
      }
      await emit(EventType.GoalCompleted, payload.goal_id, { ...payload });
    },
    async removed(payload) {
      // `goal_removed` is idempotent by design — spec §3.4 explicitly
      // permits a defensive second removal and requires receivers to
      // tolerate the redundancy. No terminal guard here.
      await emit(EventType.GoalRemoved, payload.goal_id, { ...payload });
    },
  };
}
