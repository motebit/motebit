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
 * socket's device id was verified — is refused (`claimRefusesAnswer`). The
 * answer itself stays `answerTask`'s (task-answer.ts) — write-once, settled
 * once.
 *
 * The Pending → Claimed transition and the lease's marks live here and only
 * here (the static answer-writer scan in `receipt-doors-890.test.ts` exempts
 * exactly them).
 */

import { AgentTaskStatus } from "@motebit/sdk";
import type { TaskQueueEntry } from "./tasks.js";
import type { ConnectedDevice } from "./websocket.js";

/** How long a leased claim holds without a renewal. */
export const TASK_CLAIM_LEASE_MS = 30_000;

/** The claim a body holds on a task (persisted on the queue entry). */
export interface TaskClaimLease {
  /** The claiming socket's device id (relay-made when it declared none). */
  device_id: string;
  /** The device id was proven by the token that admitted the socket. */
  device_verified: boolean;
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
}

/** Why a task's outcome is undetermined, as the delegator's poll reads it. */
export interface TaskUndetermined {
  reason: "claimer_lost";
  detail: string;
  since: number;
}

export type ClaimVerdict =
  { granted: true; lease_ms?: number } | { granted: false; reason: string };

type ClaimingPeer = Pick<ConnectedDevice, "deviceId" | "deviceIdVerified" | "capabilities"> &
  Partial<Pick<ConnectedDevice, "authenticatedDid">>;

interface Logger {
  info(event: string, ctx: Record<string, unknown>): void;
}

export interface TaskClaimsDeps {
  taskQueue: Map<string, TaskQueueEntry>;
  connections: Map<string, ConnectedDevice[]>;
  logger: Logger;
  leaseMs?: number;
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
      device_id: peer.deviceId,
      device_verified: peer.deviceIdVerified === true,
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
      entry.claim_lease = { ...lease, undetermined_at: now };
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

/**
 * The task's undetermined outcome, for the delegator's poll: set while the
 * claimer is lost and no answer has arrived.
 */
export function undeterminedOf(entry: TaskQueueEntry): TaskUndetermined | null {
  const since = entry.claim_lease?.undetermined_at;
  if (since == null || entry.receipt != null) return null;
  return {
    reason: "claimer_lost",
    detail:
      "The body that claimed this task stopped answering after its claim was granted; it may have executed the task. The task is not re-dispatched — it resolves only when that body posts its result.",
    since,
  };
}

/**
 * Whether the task's claim refuses an answer presented under device `did`:
 * true whenever a device holds the claim and `did` is any other device —
 * whether or not the claiming socket's device id was verified (an
 * unverified claim also admits the device its token proved). A
 * master-token presentation (no `did`) is not refused here.
 */
export function claimRefusesAnswer(entry: TaskQueueEntry, did: string | undefined): boolean {
  const lease = entry.claim_lease;
  if (lease == null || did == null) return false;
  return did !== lease.device_id && did !== lease.authenticated_did;
}
