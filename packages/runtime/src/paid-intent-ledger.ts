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
 * until they are retrieved or dismissed — money is leaking; stop the
 * bleeding.
 *
 * Scope and honesty:
 * - Per identity, and as durable as the store behind it (#874). The
 *   runtime passes its surface's `paidIntentStore` when one exists (the
 *   CLI's SQLite database); otherwise an in-memory store, which holds for
 *   one process only. The durable form is what closes the #874 shape: a
 *   restart used to forget every settled-unretrieved payment, so the
 *   agent's only route to "get my paid result" was a second hire.
 * - Keyed on (worker motebit_id, capability) — the observed #433 shape is
 *   "same job, same worker, re-hired". A different worker for one
 *   outstanding payment is legitimate fan-out and passes; the suspend
 *   threshold bounds the pathological case.
 * - Recorded ONLY from a `settledPayment` fact (the money independently
 *   verified as moved), never from an intent or a prompt. No unverified
 *   state can lock anything.
 * - An entry leaves the ledger only by RETRIEVAL (the signed result was
 *   fetched — `retrieveDelegationResult`) or an owner's explicit
 *   DISMISSAL. Never by elapsed time, never by a 404: a 404 has followed
 *   a transient 503 before (#433), so it is not proof the result is gone.
 * - Enforced INSIDE the shared submit chokepoint
 *   (`resolveAndSubmitP2pDelegation`), so the interactive loop path, the
 *   deterministic `invokeCapability` path and the granted path cannot
 *   diverge (docs/doctrine/composition-preserves-enforcement.md).
 */

import type { PaidIntentRecord, PaidIntentStoreAdapter } from "@motebit/sdk";

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
 * Outstanding-payment count at which ALL new paid delegation is refused,
 * regardless of worker, until the outstanding results are retrieved or
 * dismissed. One unretrieved payment can be a
 * transient delivery blip; two concurrent ones is a failure loop.
 */
export const SESSION_SUSPEND_THRESHOLD = 2;

/**
 * In-memory `PaidIntentStoreAdapter` — the default when a surface has no
 * durable store, and the test double. Holds for one process only.
 */
export class InMemoryPaidIntentStore implements PaidIntentStoreAdapter {
  private readonly rows = new Map<string, PaidIntentRecord>();

  private key(motebitId: string, taskId: string): string {
    return `${motebitId}::${taskId}`;
  }

  record(entry: Omit<PaidIntentRecord, "resolution" | "resolved_at">): void {
    const k = this.key(entry.motebit_id, entry.task_id);
    const existing = this.rows.get(k);
    if (existing != null) {
      // The one transition a re-record may make: the poll that owned an
      // in-flight entry failed, so it is now unretrieved. Same rule as the
      // SQLite store's upsert.
      if (existing.resolution == null && entry.state === "unretrieved") {
        existing.state = "unretrieved";
      }
      return;
    }
    this.rows.set(k, { ...entry, resolution: null, resolved_at: null });
  }

  listOutstanding(motebitId: string): PaidIntentRecord[] {
    return [...this.rows.values()]
      .filter((r) => r.motebit_id === motebitId && r.resolution == null)
      .sort((a, b) => a.recorded_at - b.recorded_at)
      .map((r) => ({ ...r }));
  }

  resolve(
    motebitId: string,
    taskId: string,
    resolution: "retrieved" | "dismissed",
    resolvedAt: number,
  ): boolean {
    const row = this.rows.get(this.key(motebitId, taskId));
    if (row == null || row.resolution != null) return false;
    row.resolution = resolution;
    row.resolved_at = resolvedAt;
    return true;
  }
}

function fromRecord(r: PaidIntentRecord): UnretrievedPayment {
  return {
    workerMotebitId: r.worker_motebit_id,
    capability: r.capability,
    taskId: r.task_id,
    txHash: r.tx_hash,
    paidMicro: r.paid_micro,
    feeMicro: r.fee_micro,
    recordedAt: r.recorded_at,
  };
}

/**
 * A random id per ledger instance — "this runtime, in this process". An
 * in-flight entry is the live session's own business only while the
 * session that recorded it is the one reading it; any other session sees
 * a process that died mid-poll, and so an unretrieved payment.
 */
function newSessionId(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export class PaidIntentLedger {
  /** This ledger's session — see `newSessionId`. */
  readonly sessionId: string;

  /**
   * @param store where entries live — durable on a surface that has a
   *   database, in-memory otherwise.
   * @param motebitId the delegator the ledger belongs to (per identity).
   * @param sessionId the recording session (tests pin it; production takes
   *   a fresh random id per runtime instance).
   */
  constructor(
    private readonly store: PaidIntentStoreAdapter = new InMemoryPaidIntentStore(),
    private readonly motebitId: string = "local",
    sessionId?: string,
  ) {
    this.sessionId = sessionId ?? newSessionId();
  }

  private write(entry: UnretrievedPayment, state: PaidIntentRecord["state"]): void {
    this.store.record({
      motebit_id: this.motebitId,
      task_id: entry.taskId,
      worker_motebit_id: entry.workerMotebitId,
      capability: entry.capability,
      tx_hash: entry.txHash,
      paid_micro: entry.paidMicro,
      fee_micro: entry.feeMicro,
      recorded_at: entry.recordedAt,
      state,
      session_id: this.sessionId,
    });
  }

  /**
   * Record a payment that settled and whose task the relay accepted, while
   * this session polls for the result (#874 review). It does NOT lock
   * anything for this session — concurrent hires proceed exactly as they
   * did before the ledger existed — but if this process dies mid-poll,
   * every later session reads it as unretrieved: the re-hire is refused
   * and `/result` lists it.
   */
  recordInFlight(entry: UnretrievedPayment): void {
    this.write(entry, "in_flight");
  }

  /** Record a settled-but-unretrieved payment (from a `settledPayment` fact). */
  recordSettledUnretrieved(entry: UnretrievedPayment): void {
    this.write(entry, "unretrieved");
  }

  /**
   * May a NEW paid delegation to this worker+capability broadcast?
   * Fail-closed: any lock verdict must refuse before money moves. Only
   * genuinely unretrieved payments count — this session's own in-flight
   * hires never lock or suspend anything.
   */
  check(workerMotebitId: string, capability: string): PaidIntentVerdict {
    const all = this.outstanding();
    const pair = all.find(
      (e) => e.workerMotebitId === workerMotebitId && e.capability === capability,
    );
    if (pair != null) return { locked: true, scope: "pair", prior: pair };
    if (all.length >= SESSION_SUSPEND_THRESHOLD) {
      return { locked: true, scope: "session", prior: all[0]! };
    }
    return { locked: false };
  }

  /** The result of `taskId` was retrieved — the entry stops locking. */
  resolve(taskId: string): boolean {
    return this.store.resolve(this.motebitId, taskId, "retrieved", Date.now());
  }

  /**
   * The owner cleared an entry knowingly (the relay reaped the task and
   * the result is unrecoverable). An explicit human act, never automatic.
   */
  dismiss(taskId: string): boolean {
    return this.store.resolve(this.motebitId, taskId, "dismissed", Date.now());
  }

  /** The unresolved entry for `taskId` — unretrieved or in flight — if any. */
  find(taskId: string): UnretrievedPayment | null {
    const r = this.store.listOutstanding(this.motebitId).find((e) => e.task_id === taskId);
    return r != null ? fromRecord(r) : null;
  }

  get outstandingCount(): number {
    return this.outstanding().length;
  }

  /**
   * Payments whose results are owed and nobody is fetching, oldest first:
   * every `unretrieved` entry, plus `in_flight` entries recorded by
   * another session (a process that died mid-poll).
   */
  outstanding(): UnretrievedPayment[] {
    return this.store
      .listOutstanding(this.motebitId)
      .filter((r) => r.state === "unretrieved" || r.session_id !== this.sessionId)
      .map(fromRecord);
  }

  /** This session's own hires still being polled — owed nothing yet, locking nothing. */
  inFlight(): UnretrievedPayment[] {
    return this.store
      .listOutstanding(this.motebitId)
      .filter((r) => r.state === "in_flight" && r.session_id === this.sessionId)
      .map(fromRecord);
  }
}
