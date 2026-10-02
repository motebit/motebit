/**
 * Goal-run hold — a goal whose last run left a paid outcome UNKNOWN does not
 * fire again until that outcome is resolved (#890).
 *
 * A goal run can buy work two ways, and both can end without the delegator
 * knowing how the paid work ended:
 *
 *   - a plan step delegated through the plan engine ends `plan_undetermined`
 *     (the planner holds that step itself — the goal's plan is resumed,
 *     never re-planned, and the step settles only from the relay's signed
 *     receipt);
 *   - the model hires through `delegate_to_agent` and the payment settles
 *     but the result never arrives. The paid-intent ledger (#874/#885)
 *     records it as owed, durably, and releases it only on RETRIEVAL of the
 *     signed result or the owner's explicit dismissal.
 *
 * The ledger's own lock is keyed on (worker, capability), so a re-fired goal
 * whose model picks a DIFFERENT worker for the same work would pass it and
 * pay a second time. This hold closes that at the scheduler: a payment the
 * ledger still owes that was recorded during the goal's last run holds the
 * goal. Attribution is by the run's time window over two durable records
 * (the surface's run record and the ledger), so it survives a restart; an
 * unrelated hire that lands inside the window over-holds, never under-holds.
 *
 * Nothing here guesses from a timeout: the hold lifts only when the ledger
 * entry is resolved (`/result` retrieved the signed result, or the owner
 * dismissed it).
 */

import type { UnretrievedPayment } from "./paid-intent-ledger.js";

/** When a goal run was executing. `endedAt` null = not known (held open). */
export interface GoalRunWindow {
  startedAt: number;
  endedAt: number | null;
}

/**
 * The owed payments (from `runtime.outstandingPaidResults()`) recorded
 * during this run. Non-empty ⇒ the goal is held.
 */
export function paidResultsOwedByRun(
  outstanding: readonly UnretrievedPayment[],
  run: GoalRunWindow | null,
): UnretrievedPayment[] {
  if (run == null) return [];
  return outstanding.filter(
    (e) => e.recordedAt >= run.startedAt && (run.endedAt == null || e.recordedAt <= run.endedAt),
  );
}

/**
 * The goal's runs as attribution windows, INCLUDING runs that never
 * finished (#890 round 2): a run that paid and then died has no end
 * record, and attributing only to finished runs let exactly that run's
 * payment slip past the hold. Each run must have been recorded durably
 * when it STARTED — before anything could be paid.
 *
 * An unfinished run's window ends where the next run of the goal started
 * (its process was gone by then), else after `maxRunMs` when the surface
 * bounds a run's wall clock, else stays open.
 */
export function goalRunWindows(
  runs: ReadonlyArray<{ startedAt: number; endedAt: number | null }>,
  opts: { maxRunMs?: number } = {},
): GoalRunWindow[] {
  const sorted = [...runs].sort((a, b) => a.startedAt - b.startedAt);
  return sorted.map((r, i) => {
    if (r.endedAt != null) return { startedAt: r.startedAt, endedAt: r.endedAt };
    const next = sorted[i + 1]?.startedAt;
    const bound = opts.maxRunMs != null ? r.startedAt + opts.maxRunMs : undefined;
    const ends = [next, bound].filter((x): x is number => x != null);
    return { startedAt: r.startedAt, endedAt: ends.length > 0 ? Math.min(...ends) : null };
  });
}

/**
 * The owed payments recorded during ANY of these runs (see
 * `goalRunWindows`). Non-empty ⇒ the goal is held.
 */
export function paidResultsOwedByRuns(
  outstanding: readonly UnretrievedPayment[],
  runs: readonly GoalRunWindow[],
): UnretrievedPayment[] {
  return outstanding.filter((e) => runs.some((w) => paidResultsOwedByRun([e], w).length > 0));
}

/** The owner-facing line for a goal held on an unknown paid outcome. */
export function goalAwaitingResultMessage(owed: readonly UnretrievedPayment[]): string {
  const first = owed[0];
  const which =
    first != null ? ` (task ${first.taskId}${owed.length > 1 ? `, +${owed.length - 1}` : ""})` : "";
  return (
    `awaiting the result of a paid delegation${which} — held so it is not paid for twice; ` +
    "retrieve it with /result, or dismiss it there, to let the goal run again"
  );
}
