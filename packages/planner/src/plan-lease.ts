/**
 * One driver per plan (#890).
 *
 * A plan can be driven from more than one place: a goal scheduler's
 * `resumePlan`, a reconnect's `recoverDelegatedSteps`, a surface's run-now.
 * Two drivers on the same plan each settle the held step from the relay's
 * receipt and then each submit the NEXT step — two paid tasks for one
 * step, one of them untracked. So a plan is driven only under a lease:
 *
 *   - IN-PROCESS: `PlanDriverLocks`, keyed by `plan_id`. Every PlanEngine in
 *     a process shares the module's default instance, so the scheduler's
 *     engine and the runtime's engine exclude each other. A crash releases
 *     it with the process.
 *   - ACROSS PROCESSES: when the plan store implements `PlanLeaseStore`, a
 *     persisted lease taken with compare-and-set (holder + expiry). A
 *     holder renews it at every step; a crashed holder's lease expires.
 *
 * A driver that cannot take the lease yields `plan_busy` and delegates
 * nothing. The step's derived Idempotency-Key (`planStepIdempotencyKey`) is
 * the relay-side backstop if two drivers ever did overlap.
 */

/** In-process single-flight set of plans being driven. */
export class PlanDriverLocks {
  private readonly held = new Set<string>();

  /** Take the plan; false when another driver in this process holds it. */
  tryAcquire(planId: string): boolean {
    if (this.held.has(planId)) return false;
    this.held.add(planId);
    return true;
  }

  release(planId: string): void {
    this.held.delete(planId);
  }

  isHeld(planId: string): boolean {
    return this.held.has(planId);
  }
}

/** The process-wide default: every PlanEngine in a process shares it. */
export const PROCESS_PLAN_LOCKS = new PlanDriverLocks();

/**
 * A plan store that can hold a cross-process driver lease. `acquire` is a
 * compare-and-set: it succeeds when the plan has no lease, the lease has
 * expired, or `holder` already holds it (a renewal).
 */
export interface PlanLeaseStore {
  acquirePlanLease(planId: string, holder: string, now: number, ttlMs: number): boolean;
  releasePlanLease(planId: string, holder: string): void;
}

export function isPlanLeaseStore(store: unknown): store is PlanLeaseStore {
  return (
    typeof store === "object" &&
    store != null &&
    typeof (store as Partial<PlanLeaseStore>).acquirePlanLease === "function" &&
    typeof (store as Partial<PlanLeaseStore>).releasePlanLease === "function"
  );
}

/** Default lease lifetime; renewed at every step, so it only has to outlive one step. */
export const DEFAULT_PLAN_LEASE_TTL_MS = 15 * 60 * 1000;
