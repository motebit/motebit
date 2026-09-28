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
 * - Recorded ONLY from a money fact produced by the payment path — never
 *   from an intent or a prompt: a `settledPayment`, a payment proof in hand
 *   (recorded at broadcast, before the task is submitted — #885), or a
 *   payment builder that threw with the chain unable to rule out that the
 *   money moved (#885, `p2p-unconfirmed:`). Nothing a model says can lock
 *   anything.
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
 * Ledger ids for payments that have no confirmed relay task (#885). The
 * ledger is keyed by task, but a P2P payment exists BEFORE the relay admits
 * its task — from the moment its transaction is signed — so it gets an
 * entry under a synthetic id that can never collide with a relay task id:
 *
 *   - `p2p-payment:<signature>` — a transaction this device signed for a
 *     hire. Recorded after signing and BEFORE it is sent (in flight, this
 *     session). Handed over to the real task id when the relay admits it;
 *     voided when the chain confirms it can never land; otherwise it stays
 *     and locks the pair — it may have moved money, and no relay task is
 *     confirmed for it (the relay rejected it, or admission is unconfirmed).
 *   - `p2p-unconfirmed:<...>` — a rail that does not report its transactions
 *     threw, and nothing could be confirmed. Money may have left the wallet.
 *
 * Neither is fetchable from the relay by that id; `retrieveDelegationResult`
 * answers them locally (`not_admitted`) without a relay read.
 */
export const PAYMENT_ENTRY_PREFIX = "p2p-payment:";
export const UNCONFIRMED_TASK_PREFIX = "p2p-unconfirmed:";

/** The ledger id of a signed P2P payment transaction with no confirmed relay task. */
export function paymentEntryId(signature: string): string {
  return `${PAYMENT_ENTRY_PREFIX}${signature}`;
}

/** True for a ledger id that names a payment with no confirmed relay task (either kind). */
export function isPaymentWithoutTaskId(taskId: string): boolean {
  return taskId.startsWith(PAYMENT_ENTRY_PREFIX) || taskId.startsWith(UNCONFIRMED_TASK_PREFIX);
}

/** The `tx_hash` recorded for a payment whose transaction is not known. */
export const UNKNOWN_TX_HASH = "unknown";

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
   * Record a P2P payment transaction the moment it is SIGNED — before it is
   * sent, so before any money can move (#885). `txHash` is its signature,
   * and the entry lives under `paymentEntryId(txHash)`. It is in flight:
   * this session is paying and submitting it and nothing locks here, but a
   * process that dies before the relay admits the task leaves it on record
   * and every later session refuses the re-hire. On admission it is handed
   * over to the task (`admitted`); if the chain says the transaction can
   * never land it is voided (`voidUnsent`); if the submission is given up
   * or the payment's fate is unknown it becomes unretrieved
   * (`recordSettledUnretrieved` with the same id). A caller that cannot
   * write this record must not send the transaction.
   */
  recordBroadcast(entry: Omit<UnretrievedPayment, "taskId">): void {
    this.write({ ...entry, taskId: paymentEntryId(entry.txHash) }, "in_flight");
  }

  /**
   * The relay admitted the task a recorded payment bought: the task entry
   * takes over (in flight, polled by this session) and the pre-admission
   * entry stops locking. The task entry is written first, so a crash in
   * between leaves two entries for one payment — over-locking, never
   * under-locking.
   *
   * The pre-admission entry is resolved `retrieved` because the record's
   * resolution vocabulary (`@motebit/sdk` `PaidIntentRecord`) has only
   * retrieved / dismissed; what it means here is "carried by the task entry".
   */
  admitted(txHash: string, task: UnretrievedPayment): void {
    this.recordInFlight(task);
    this.store.resolve(this.motebitId, paymentEntryId(txHash), "retrieved", Date.now());
  }

  /**
   * Record a payment whose builder threw and whose landing the chain could
   * not confirm or rule out (#885). Money may have left the wallet, and no
   * transaction is known, so the entry is unretrieved at once — it locks
   * the pair in this session too — until the owner reconciles the wallet
   * and dismisses it. Returns the entry's ledger id.
   */
  recordUnconfirmed(entry: Omit<UnretrievedPayment, "taskId" | "txHash">): string {
    const taskId =
      `${UNCONFIRMED_TASK_PREFIX}${entry.recordedAt.toString(36)}-` +
      newSessionId()
        .replace(/[^A-Za-z0-9]/g, "")
        .slice(0, 12);
    this.write({ ...entry, taskId, txHash: UNKNOWN_TX_HASH }, "unretrieved");
    return taskId;
  }

  /**
   * A transaction recorded at signing turned out never to move money: the
   * chain says it expired unsent or failed onchain (#885). Its entry stops
   * locking. Resolved `dismissed` — the record's resolution vocabulary
   * (`@motebit/sdk`) has no "never sent"; the row stays as history.
   */
  voidUnsent(signature: string): boolean {
    return this.store.resolve(this.motebitId, paymentEntryId(signature), "dismissed", Date.now());
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
