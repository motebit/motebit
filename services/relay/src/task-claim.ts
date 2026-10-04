/**
 * One task, one body — the claim a serving body takes on a broadcast task.
 *
 * A plain task is handed to EVERY serving socket of its motebit (the CLI
 * daemon, the desktop app, a browser tab, a phone are all bodies of one
 * identity). Each body answers with `task_claim`; this module decides, in
 * one synchronous turn, which body won (`task_claimed`) and refuses the rest
 * (`task_claim_rejected`). The body executes only on the grant — the client
 * half is `TaskClaimCoordinator` in `@motebit/runtime`.
 *
 * THE LAW: at most one execution per task. A body executes the moment its
 * claim is granted, so a granted claim means "may have started". The relay
 * therefore never grants a second claim on a task: failover to another body
 * happens only BEFORE any grant (every body that was presented the task and
 * lost the race simply drops it). Nothing marks a task idempotent today, so
 * no task is ever re-dispatched after a grant.
 *
 * A claim made with `lease: true` is a LEASE (`TASK_CLAIM_LEASE_MS`) — a
 * liveness signal, not a re-dispatch timer. The winner renews it
 * (`task_claim_renew`) while it runs, from any socket of its device id (a
 * desktop rebuilds its socket every few minutes). A claimer that dies, or
 * whose renewals stop reaching the relay, has its lease lapse: the task
 * stays Claimed by that body and becomes UNDETERMINED (`undetermined_at`) —
 * the claimer may have run it, may still be running it, or never started.
 * The delegator's poll surfaces it (`undeterminedOf`, reason
 * `claimer_lost`); it is never Pending again and never handed to another
 * body. No body converts that uncertainty into an assumed failure. It
 * resolves only by the claimer itself: a later renewal clears the mark (the
 * claimer is alive), and the claimer's signed result answers the task. A
 * claim without `lease` (a client that predates leases) never lapses.
 *
 * The claim also names who may answer: a result POSTed under a device token
 * of any device other than the claimer — whether or not the claiming
 * socket's device id was verified — is refused (`claimRefusesAnswer`). A
 * result POSTed under the master token names no device, so the receipt's
 * SIGNED `device_id` (verified first) is compared instead: a non-claimer's
 * is refused (the CLI daemon and desktop send the master token first when
 * one is configured). The result route refuses early on the entry it read;
 * the BINDING comparison is `answerTask`'s write step (task-answer.ts step
 * 5), in the same synchronous turn as the write, against the entry as it is
 * then — so a claim granted while an answer awaited its signature check
 * refuses that answer. The other order is `claim`'s: an answered entry is
 * never claimable, and an answer is written in the turn it is accepted.
 * The answer itself stays `answerTask`'s — write-once, settled once.
 *
 * EVERY GRANT LIVES HERE, not only a body's claim (round 3,
 * `__tests__/one-execution-matrix.probe.ts`). The relay's own MCP forward
 * takes the grant before its first request (`grantForward`) and reports how
 * it ended (`forwardEnded`: no `tools/call` sent ⇒ released to Pending and
 * re-presented; sent with no accepted receipt ⇒ undetermined); the
 * submitter's chosen presentation is granted at admission
 * (`grantToSubmitter`). Reconnect recovery presents only a Pending task, so
 * no presenter ever runs beside another. The TTL pass (`expire`) never lets
 * an unanswered task vanish: never granted ⇒ expired VISIBLY
 * (`expiredOf`); granted without a live lease ⇒ undetermined. A granted,
 * unanswered entry is never deleted by the queue sweep, and its allocation
 * hold is never refunded as stale (`holdsUnresolvedGrant`).
 *
 * The Pending ⇄ Claimed transitions and the grant's marks live here and
 * only here (the static answer-writer scan in `receipt-doors-890.test.ts`
 * exempts exactly them). A body's grant returns to Pending never; only the
 * relay's forward that provably sent nothing that could run the task is
 * released.
 */

import { AgentTaskStatus } from "@motebit/sdk";
import type { TaskQueueEntry } from "./tasks.js";
import type { ConnectedDevice } from "./websocket.js";

/** How long a leased claim holds without a renewal. */
export const TASK_CLAIM_LEASE_MS = 30_000;

/**
 * Who a task was GRANTED to. A grant is a presentation that may lead to
 * execution, so every grant is held here and none is ever made twice:
 *   - `ws`         a serving body's `task_claim` (absent on entries written
 *                  before presenters were named);
 *   - `mcp_forward` the relay's own MCP forward (`presentViaMcp`), taken
 *                  before the forward's first request;
 *   - `submitter`  the submitter's chosen presentation (`presenter:
 *                  "submitter"`), taken at admission — the dispatch token it
 *                  is handed is the grant.
 */
export type TaskGrantPresenter = "ws" | "mcp_forward" | "submitter";

/** Why a granted task's outcome is undetermined. */
export type TaskUndeterminedReason =
  /** A body's leased claim lapsed with no answer. */
  | "claimer_lost"
  /** The relay's MCP forward sent `tools/call` and no receipt was accepted. */
  | "forward_unanswered"
  /** The task's TTL passed with a grant held and no answer (a claim without a lease, or the submitter's presentation). */
  | "unanswered_at_expiry";

/** The claim a body holds on a task (persisted on the queue entry). */
export interface TaskClaimLease {
  /** The grant's presenter; absent = `ws` (entries written before it existed). */
  presenter?: TaskGrantPresenter;
  /**
   * The claiming socket's device id (relay-made when it declared none); for
   * `mcp_forward` `mcp:<worker>`, for `submitter` `submitter:<id>`.
   */
  device_id: string;
  /** The device id was proven by the token that admitted the socket. */
  device_verified: boolean;
  /**
   * The relay MADE the device id (the claiming socket declared none): it
   * names no device a receipt can carry. Absent = declared (or an entry
   * written before this existed).
   */
  device_generated?: true;
  /**
   * The device the claiming socket's token proved, when that differs from
   * an unverified declared `device_id` — it may answer too.
   */
  authenticated_did?: string;
  /** When the lease lapses; absent for a claim made without `lease`. */
  expires_at?: number;
  /**
   * When the lease lapsed with no answer: the claimer is lost and the
   * task's outcome is undetermined. Cleared by the claimer's own renewal.
   */
  undetermined_at?: number;
  /** Why it is undetermined (absent on marks written before reasons existed = `claimer_lost`). */
  undetermined_reason?: TaskUndeterminedReason;
}

/**
 * A task that was never granted and outlived its TTL: it expired VISIBLY.
 * The entry stays (status Pending, never presentable or claimable again)
 * for `EXPIRED_VISIBLE_MS` so the delegator's poll reads why, instead of a
 * bare 404.
 */
export interface TaskExpiredUnclaimed {
  reason: "never_claimed";
  detail: string;
  since: number;
}

/** How long a visibly-expired (never granted) task stays readable. */
export const EXPIRED_VISIBLE_MS = 24 * 60 * 60 * 1000;

/** Why a task's outcome is undetermined, as the delegator's poll reads it. */
export interface TaskUndetermined {
  reason: TaskUndeterminedReason;
  detail: string;
  since: number;
}

export type ClaimVerdict =
  { granted: true; lease_ms?: number } | { granted: false; reason: string };

type ClaimingPeer = Pick<ConnectedDevice, "deviceId" | "deviceIdVerified" | "capabilities"> &
  Partial<Pick<ConnectedDevice, "authenticatedDid" | "deviceIdDeclared">>;

interface Logger {
  info(event: string, ctx: Record<string, unknown>): void;
}

export interface TaskClaimsDeps {
  taskQueue: Map<string, TaskQueueEntry>;
  connections: Map<string, ConnectedDevice[]>;
  logger: Logger;
  leaseMs?: number;
  /**
   * The ids of entries past their TTL with no answer — the expiry pass reads
   * only these (`TaskQueue.unansweredPastExpiry`). Absent: the queue is
   * scanned.
   */
  unansweredPastExpiry?: (now: number) => string[];
}

export class TaskClaims {
  readonly leaseMs: number;
  /** Task ids holding a lease — the sweep reads only these. */
  private readonly leased = new Set<string>();

  constructor(private readonly deps: TaskClaimsDeps) {
    this.leaseMs = deps.leaseMs ?? TASK_CLAIM_LEASE_MS;
    // A restart forgets the in-memory index, not the leases: re-adopt every
    // leased claim the durable queue holds so the sweep still reaches it.
    for (const [taskId, entry] of deps.taskQueue) {
      if (entry.task.status === AgentTaskStatus.Claimed && entry.claim_lease?.expires_at != null) {
        this.leased.add(taskId);
      }
    }
  }

  /**
   * `task_claim` from a socket of `motebitId`. Atomic: the entry's status is
   * read and written in one synchronous turn.
   */
  claim(
    taskId: string,
    motebitId: string,
    peer: ClaimingPeer,
    opts: { lease: boolean; now: number },
  ): ClaimVerdict {
    const { taskQueue } = this.deps;
    const entry = taskQueue.get(taskId);
    if (!entry || entry.task.motebit_id !== motebitId) {
      return { granted: false, reason: "Task not found" };
    }
    if (entry.task.status !== AgentTaskStatus.Pending || entry.receipt != null) {
      return { granted: false, reason: "already_claimed" };
    }
    if (entry.expired_unclaimed != null) {
      return { granted: false, reason: "expired" };
    }
    const requiredCaps = entry.task.required_capabilities ?? [];
    if (
      requiredCaps.length > 0 &&
      peer.capabilities != null &&
      !requiredCaps.every((c) => peer.capabilities!.includes(c))
    ) {
      return { granted: false, reason: "Device lacks required capabilities" };
    }
    entry.task.status = AgentTaskStatus.Claimed;
    entry.task.claimed_by = peer.deviceId;
    entry.claim_lease = {
      presenter: "ws",
      device_id: peer.deviceId,
      device_verified: peer.deviceIdVerified === true,
      ...(peer.deviceIdDeclared === false ? { device_generated: true as const } : {}),
      ...(peer.authenticatedDid != null && peer.authenticatedDid !== peer.deviceId
        ? { authenticated_did: peer.authenticatedDid }
        : {}),
      ...(opts.lease ? { expires_at: opts.now + this.leaseMs } : {}),
    };
    taskQueue.set(taskId, entry);
    if (opts.lease) {
      this.leased.add(taskId);
      return { granted: true, lease_ms: this.leaseMs };
    }
    return { granted: true };
  }

  /**
   * `task_claim_renew` from a socket of `motebitId` under `deviceId`: extend
   * the lease when that device holds it. A renewal from a claimer whose
   * lease had lapsed clears the undetermined mark — the claimer is alive.
   * Returns whether it renewed.
   */
  renew(taskId: string, motebitId: string, deviceId: string, now: number): boolean {
    const { taskQueue } = this.deps;
    const entry = taskQueue.get(taskId);
    const lease = entry?.claim_lease;
    if (
      entry == null ||
      entry.task.motebit_id !== motebitId ||
      entry.task.status !== AgentTaskStatus.Claimed ||
      lease?.expires_at == null ||
      lease.device_id !== deviceId
    ) {
      return false;
    }
    const { undetermined_at: _lost, ...held } = lease;
    entry.claim_lease = { ...held, expires_at: now + this.leaseMs };
    taskQueue.set(taskId, entry);
    this.leased.add(taskId);
    return true;
  }

  /**
   * The relay's MCP forward takes the grant BEFORE its first request
   * (`presentViaMcp`): Pending → Claimed by `mcp:<worker>`, no lease (the
   * forward cannot renew; its outcome is reported by `forwardEnded`).
   * Refused (false) when the task is no longer Pending — a body already
   * holds it, or it was answered — and then the forward must not be sent.
   */
  grantForward(taskId: string, workerId: string): boolean {
    const { taskQueue } = this.deps;
    const entry = taskQueue.get(taskId);
    if (
      entry == null ||
      entry.task.status !== AgentTaskStatus.Pending ||
      entry.receipt != null ||
      entry.expired_unclaimed != null
    ) {
      return false;
    }
    entry.task.status = AgentTaskStatus.Claimed;
    entry.task.claimed_by = `mcp:${workerId}`;
    entry.claim_lease = {
      presenter: "mcp_forward",
      device_id: `mcp:${workerId}`,
      device_verified: false,
    };
    taskQueue.set(taskId, entry);
    return true;
  }

  /**
   * The forward the relay granted itself has ended. `called` is whether its
   * `tools/call` — the only request that can run the task — was sent:
   *   - not sent: the worker provably never ran it, so the grant is
   *     RELEASED (Claimed → Pending) and the entry is returned for the
   *     caller to present to the bodies connected now (recovery skipped
   *     them while the forward held the grant);
   *   - sent, and no receipt accepted: the worker may have run it — the
   *     task is UNDETERMINED (`forward_unanswered`), never Pending again.
   * Returns the released entry, or null.
   */
  forwardEnded(taskId: string, called: boolean, now: number): TaskQueueEntry | null {
    const { taskQueue, logger } = this.deps;
    const entry = taskQueue.get(taskId);
    const lease = entry?.claim_lease;
    if (
      entry == null ||
      entry.receipt != null ||
      entry.task.status !== AgentTaskStatus.Claimed ||
      lease?.presenter !== "mcp_forward"
    ) {
      return null;
    }
    if (!called) {
      entry.task.status = AgentTaskStatus.Pending;
      entry.task.claimed_by = undefined;
      entry.claim_lease = undefined;
      taskQueue.set(taskId, entry);
      logger.info("task.forward_released", { correlationId: taskId, worker: lease.device_id });
      return entry;
    }
    if (lease.undetermined_at == null) {
      entry.claim_lease = {
        ...lease,
        undetermined_at: now,
        undetermined_reason: "forward_unanswered",
      };
      taskQueue.set(taskId, entry);
      logger.info("task.claim_undetermined", {
        correlationId: taskId,
        motebitId: entry.task.motebit_id,
        deviceId: lease.device_id,
        reason: "forward_unanswered",
      });
    }
    return null;
  }

  /**
   * Whether `taskId` is GRANTED and unanswered — its executor may have run
   * it. Its allocation hold is then never released as stale: the money
   * stays held until the executor's signed result settles it.
   */
  holdsUnresolvedGrant(taskId: string): boolean {
    const entry = this.deps.taskQueue.get(taskId);
    return entry != null && entry.receipt == null && entry.task.status === AgentTaskStatus.Claimed;
  }

  /**
   * The TTL pass. An unanswered entry past its expiry is never deleted
   * silently:
   *   - never granted (Pending) → EXPIRED VISIBLY (`expired_unclaimed`): no
   *     longer presentable or claimable, and readable by the delegator's
   *     poll for `EXPIRED_VISIBLE_MS`;
   *   - granted (Claimed) with no live lease → UNDETERMINED
   *     (`unanswered_at_expiry`) where it is not already; it then persists
   *     until the claimer's result resolves it (the queue's cleanup never
   *     deletes a granted, unanswered entry). A claim whose lease is still
   *     being renewed is left alone: its body is still running it.
   * Returns the ids it changed.
   */
  expire(now: number): string[] {
    const { taskQueue, logger } = this.deps;
    const ids =
      this.deps.unansweredPastExpiry?.(now) ??
      [...taskQueue.entries()]
        .filter(([, e]) => e.expiresAt < now && e.receipt == null)
        .map(([id]) => id);
    const changed: string[] = [];
    for (const taskId of ids) {
      const entry = taskQueue.get(taskId);
      if (entry == null || entry.receipt != null || entry.expiresAt >= now) continue;
      if (entry.task.status === AgentTaskStatus.Pending) {
        if (entry.expired_unclaimed != null) continue;
        entry.expired_unclaimed = { reason: "never_claimed", since: now };
        entry.expiresAt = now + EXPIRED_VISIBLE_MS;
        taskQueue.set(taskId, entry);
        logger.info("task.expired_unclaimed", {
          correlationId: taskId,
          motebitId: entry.task.motebit_id,
        });
        changed.push(taskId);
        continue;
      }
      if (entry.task.status !== AgentTaskStatus.Claimed) continue;
      const lease = entry.claim_lease;
      if (lease?.undetermined_at != null) continue;
      if (lease?.expires_at != null && lease.expires_at > now) continue; // still renewing
      entry.claim_lease = {
        ...(lease ?? { device_id: entry.task.claimed_by ?? "unknown", device_verified: false }),
        undetermined_at: now,
        undetermined_reason: lease?.expires_at != null ? "claimer_lost" : "unanswered_at_expiry",
      };
      taskQueue.set(taskId, entry);
      logger.info("task.claim_undetermined", {
        correlationId: taskId,
        motebitId: entry.task.motebit_id,
        deviceId: entry.claim_lease.device_id,
        reason: entry.claim_lease.undetermined_reason,
      });
      changed.push(taskId);
    }
    return changed;
  }

  /**
   * Lapse every lease past its expiry: the claimer is lost, so the task —
   * still Claimed by it — is marked UNDETERMINED. It is never returned to
   * Pending and never handed to another body: the claimer may have started
   * it. Returns the task ids marked.
   */
  sweep(now: number): string[] {
    const { taskQueue, logger } = this.deps;
    const lost: string[] = [];
    for (const taskId of [...this.leased]) {
      const entry = taskQueue.get(taskId);
      const lease = entry?.claim_lease;
      if (
        entry == null ||
        entry.receipt != null ||
        entry.task.status !== AgentTaskStatus.Claimed ||
        lease?.expires_at == null ||
        lease.undetermined_at != null
      ) {
        this.leased.delete(taskId);
        continue;
      }
      if (lease.expires_at > now) continue;
      this.leased.delete(taskId);
      entry.claim_lease = { ...lease, undetermined_at: now, undetermined_reason: "claimer_lost" };
      taskQueue.set(taskId, entry);
      logger.info("task.claim_undetermined", {
        correlationId: taskId,
        motebitId: entry.task.motebit_id,
        deviceId: lease.device_id,
      });
      lost.push(taskId);
    }
    return lost;
  }
}

const UNDETERMINED_DETAIL: Record<TaskUndeterminedReason, string> = {
  claimer_lost:
    "The body that claimed this task stopped answering after its claim was granted; it may have executed the task. The task is not re-dispatched — it resolves only when that body posts its result.",
  forward_unanswered:
    "The relay forwarded this task to the worker's MCP endpoint and no receipt came back; the worker may have executed it. The task is not re-dispatched — it resolves only when the worker's signed result arrives.",
  unanswered_at_expiry:
    "This task was granted to a presenter and its TTL passed with no answer; it may have been executed. The task is not re-dispatched — it resolves only when the executor's signed result arrives.",
};

/**
 * The task's undetermined outcome, for the delegator's poll: set while the
 * grantee is lost and no answer has arrived.
 */
export function undeterminedOf(entry: TaskQueueEntry): TaskUndetermined | null {
  const since = entry.claim_lease?.undetermined_at;
  if (since == null || entry.receipt != null) return null;
  const reason = entry.claim_lease?.undetermined_reason ?? "claimer_lost";
  return { reason, detail: UNDETERMINED_DETAIL[reason], since };
}

/**
 * The task expired before anything was granted it, for the delegator's
 * poll: it never ran (no presenter was granted it) and never will.
 */
export function expiredOf(entry: TaskQueueEntry): TaskExpiredUnclaimed | null {
  const e = entry.expired_unclaimed;
  if (e == null || entry.receipt != null) return null;
  return {
    reason: e.reason,
    detail:
      "No serving body or worker was granted this task before its TTL passed; it was never executed through this relay and will not be presented again. Submit it again to retry.",
    since: e.since,
  };
}

/**
 * The grant the submitter's chosen presentation takes at admission
 * (`presenter: "submitter"`): the entry is queued already Claimed, so no
 * body is ever presented it. Applied to the entry before it is first
 * written.
 */
export function grantToSubmitter(entry: TaskQueueEntry, submitter: string | undefined): void {
  entry.task.status = AgentTaskStatus.Claimed;
  entry.task.claimed_by = `submitter:${submitter ?? "operator"}`;
  entry.claim_lease = {
    presenter: "submitter",
    device_id: `submitter:${submitter ?? "operator"}`,
    device_verified: false,
  };
}

/**
 * Whether a body's claim (a `ws` grant) names the device that may answer the
 * task. A forward's or a submitter's grant names none: it is answered
 * through the routed executor's receipt (`isRoutedExecutor`).
 */
export function claimNamesAnswerer(entry: TaskQueueEntry): boolean {
  const lease = entry.claim_lease;
  if (lease == null) return false;
  return lease.presenter == null || lease.presenter === "ws";
}

/**
 * Whether a master-token answer's SIGNED `device_id` is compared against the
 * claim: only when a body's claim names a device a receipt can carry — one
 * it declared or proved. A claimer whose id the relay made could never
 * match any receipt, so its master-token answer keeps the behaviour before
 * the signed comparison (stated limit, docs/doctrine/task-admission.md).
 */
export function claimBindsSignedAnswerer(entry: TaskQueueEntry): boolean {
  return claimNamesAnswerer(entry) && entry.claim_lease?.device_generated !== true;
}

/**
 * Whether the task's claim refuses an answer from device `did`: true
 * whenever a device holds the claim and `did` is any other device —
 * whether or not the claiming socket's device id was verified (an
 * unverified claim also admits the device its token proved). `did` is the
 * presenting device token's `did`; under the master token it is the
 * receipt's SIGNED `device_id`, read only after its signature verified
 * (the result door, and `answerTask`'s write step against the current
 * entry). No `did` at all is not refused here.
 */
export function claimRefusesAnswer(entry: TaskQueueEntry, did: string | undefined): boolean {
  const lease = entry.claim_lease;
  if (lease == null || did == null) return false;
  if (!claimNamesAnswerer(entry)) return false;
  return did !== lease.device_id && did !== lease.authenticated_did;
}
