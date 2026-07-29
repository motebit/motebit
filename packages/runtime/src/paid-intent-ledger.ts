/**
 * Paid-intent ledger — the runtime interlock that makes "never pay twice
 * for the same job" structural instead of a prompt convention (#435, made
 * mandatory by the #436 audit).
 *
 * #434 taught the MODEL that a post-broadcast poll failure means money
 * already moved (`PAYMENT_ALREADY_SETTLED`). But the last line of defense
 * was still the model reading that message correctly — and on the
 * standing-grant auto-execute path there is no human between a retry loop
 * and real money at all. This ledger is the mechanical stop: while a paid
 * delegation's payment has SETTLED onchain but its result was never
 * retrieved, any NEW paid delegation to the same worker + capability is
 * refused BEFORE broadcast (`intent_already_paid`, fail-closed). Two or
 * more outstanding unretrieved payments suspend ALL new paid delegation
 * for the session — money is leaking; stop the bleeding.
 *
 * Scope and honesty:
 * - Session-scoped (one runtime instance = one ledger). A restart clears
 *   it — the retry loop it guards against is a session phenomenon, and a
 *   human restarting has seen the refusal message with the prior taskId.
 * - Keyed on (worker motebit_id, capability) — the observed #433 shape is
 *   "same job, same worker, re-hired". A different worker for one
 *   outstanding payment is legitimate fan-out and passes; the session
 *   threshold bounds the pathological case.
 * - Recorded ONLY from a `settledPayment` fact (the money independently
 *   verified as moved), never from an intent or a prompt. No unverified
 *   state can lock anything.
 * - Enforced INSIDE the shared submit chokepoint
 *   (`resolveAndSubmitP2pDelegation`), so the interactive loop path and
 *   the granted deterministic path cannot diverge
 *   (docs/doctrine/composition-preserves-enforcement.md).
 */

/** A payment that settled onchain whose result was never delivered. */
export interface UnretrievedPayment {
  workerMotebitId: string;
  capability: string;
  /** The relay task the payment bought — the handle to re-fetch, never re-pay. */
  taskId: string;
  txHash: string;
  paidMicro: number;
  feeMicro: number;
  recordedAt: number;
}

export type PaidIntentVerdict =
  | { locked: false }
  | {
      locked: true;
      /** `pair` = this worker+capability already has settled-unretrieved money;
       *  `session` = too many outstanding payments — all paid delegation suspended. */
      scope: "pair" | "session";
      prior: UnretrievedPayment;
    };

/**
 * Outstanding-payment count at which ALL new paid delegation is refused
 * for the session, regardless of worker. One unretrieved payment can be a
 * transient delivery blip; two concurrent ones is a failure loop.
 */
export const SESSION_SUSPEND_THRESHOLD = 2;

export class PaidIntentLedger {
  private readonly entries = new Map<string, UnretrievedPayment>();

  private key(workerMotebitId: string, capability: string): string {
    return `${workerMotebitId}::${capability}`;
  }

  /** Record a settled-but-unretrieved payment (from a `settledPayment` fact). */
  recordSettledUnretrieved(entry: UnretrievedPayment): void {
    this.entries.set(this.key(entry.workerMotebitId, entry.capability), entry);
  }

  /**
   * May a NEW paid delegation to this worker+capability broadcast?
   * Fail-closed: any lock verdict must refuse before money moves.
   */
  check(workerMotebitId: string, capability: string): PaidIntentVerdict {
    const pair = this.entries.get(this.key(workerMotebitId, capability));
    if (pair != null) return { locked: true, scope: "pair", prior: pair };
    if (this.entries.size >= SESSION_SUSPEND_THRESHOLD) {
      const oldest = [...this.entries.values()].sort((a, b) => a.recordedAt - b.recordedAt)[0]!;
      return { locked: true, scope: "session", prior: oldest };
    }
    return { locked: false };
  }

  /** Resolve one entry — its result was finally retrieved (or a human cleared it). */
  resolve(taskId: string): boolean {
    for (const [key, entry] of this.entries) {
      if (entry.taskId === taskId) {
        this.entries.delete(key);
        return true;
      }
    }
    return false;
  }

  get outstandingCount(): number {
    return this.entries.size;
  }

  /** The outstanding entries, oldest first — for owner-facing rendering. */
  outstanding(): UnretrievedPayment[] {
    return [...this.entries.values()].sort((a, b) => a.recordedAt - b.recordedAt);
  }
}
