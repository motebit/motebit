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
 * A claim made with `lease: true` is a LEASE (`TASK_CLAIM_LEASE_MS`): the
 * winner renews it (`task_claim_renew`) while it runs, from any socket of
 * its device id (a desktop rebuilds its socket every few minutes). A
 * claimer that dies, or whose renewals stop reaching the relay, loses the
 * claim when the lease lapses: the task goes back to Pending and is handed
 * again to every serving socket of the motebit, so another body — or the
 * same one, reconnected — takes it. A claim without `lease` (a client that
 * predates leases) never lapses: main's behaviour, so a long task on an old
 * client is never presented twice.
 *
 * The claim also names who may answer: a result POSTed under a device token
 * for a task whose verified claimer is a DIFFERENT device is refused
 * (`claimRefusesAnswer`), so a lapsed claimer that finishes late cannot
 * answer the task its successor holds. The answer itself stays
 * `answerTask`'s (task-answer.ts) — write-once, settled once.
 *
 * The Pending ⇄ Claimed transitions live here and only here (the static
 * answer-writer scan in `receipt-doors-890.test.ts` exempts exactly them).
 */

import { AgentTaskStatus } from "@motebit/sdk";
import type { TaskQueueEntry } from "./tasks.js";
import type { ConnectedDevice } from "./websocket.js";
import { routeToSockets } from "./task-presentation.js";

/** How long a leased claim holds without a renewal. */
export const TASK_CLAIM_LEASE_MS = 30_000;

/** The claim a body holds on a task (persisted on the queue entry). */
export interface TaskClaimLease {
  /** The claiming socket's device id (relay-made when it declared none). */
  device_id: string;
  /** The device id was proven by the token that admitted the socket. */
  device_verified: boolean;
  /** When the lease lapses; absent for a claim made without `lease`. */
  expires_at?: number;
}

export type ClaimVerdict =
  { granted: true; lease_ms?: number } | { granted: false; reason: string };

type ClaimingPeer = Pick<ConnectedDevice, "deviceId" | "deviceIdVerified" | "capabilities">;

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
   * the lease when that device still holds it. Returns whether it did.
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
    entry.claim_lease = { ...lease, expires_at: now + this.leaseMs };
    taskQueue.set(taskId, entry);
    return true;
  }

  /**
   * Lapse every lease past its expiry: the task returns to Pending and is
   * handed again to every serving socket of its motebit. With none open it
   * stays Pending, and reconnect recovery hands it to the next socket.
   * Returns the task ids re-presented.
   */
  sweep(now: number): string[] {
    const { taskQueue, connections, logger } = this.deps;
    const lapsed: string[] = [];
    for (const taskId of [...this.leased]) {
      const entry = taskQueue.get(taskId);
      const lease = entry?.claim_lease;
      if (
        entry == null ||
        entry.receipt != null ||
        entry.task.status !== AgentTaskStatus.Claimed ||
        lease?.expires_at == null
      ) {
        this.leased.delete(taskId);
        continue;
      }
      if (lease.expires_at > now) continue;
      this.leased.delete(taskId);
      entry.task.status = AgentTaskStatus.Pending;
      entry.task.claimed_by = undefined;
      entry.claim_lease = undefined;
      taskQueue.set(taskId, entry);
      const route = routeToSockets(
        connections.get(entry.task.motebit_id),
        JSON.stringify({ type: "task_request", task: entry.task }),
      );
      logger.info("task.claim_lease_lapsed", {
        correlationId: taskId,
        motebitId: entry.task.motebit_id,
        deviceId: lease.device_id,
        route,
      });
      lapsed.push(taskId);
    }
    return lapsed;
  }
}

/**
 * Whether the task's claim refuses an answer presented under device `did`:
 * true exactly when a VERIFIED device holds the claim and `did` is another
 * device. A master-token presentation (no `did`) and an unverified claim
 * (a socket that declared no device id, or one its token did not prove)
 * are not refused here.
 */
export function claimRefusesAnswer(entry: TaskQueueEntry, did: string | undefined): boolean {
  const lease = entry.claim_lease;
  if (lease == null || !lease.device_verified || did == null) return false;
  return lease.device_id !== did;
}
