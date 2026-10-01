/**
 * Settlement recovery (#890 round 10) — the restart half of "an answer and
 * its settlement are ONE decision".
 *
 * `admitReceipt` claims an answer's settlement in the write that takes it and
 * marks it settled only when the door's settlement step COMPLETES. A process
 * that dies (or a step that fails) between the claim and the settle leaves
 * the answer claimed and unsettled, and until now only the sender's identical
 * retry settled it — a retry that, for the executor relay's federation result
 * or a sub-task nested in its parent's answer, never comes.
 *
 * The sweep runs on boot and on a supervised interval, and does three things:
 *
 *   1. LEGACY CLAIM — an inbound-forward entry (this relay is the executor)
 *      answered before the claim existed adopts the claim for exactly its
 *      stored answer (`claimStoredAnswer`, the legacy repeat's rule), so the
 *      origin's settlement forward — however late — pays that answer, and the
 *      answer is archived with its claim before the queue can forget it.
 *   2. SETTLE — every queue entry whose answer is claimed (`settling` names
 *      the entry's own receipt) and not settled is REPLAYED through the door
 *      its claim was taken by (`settle_via`): the local doors through
 *      `handleReceiptIngestion`, the federation door through
 *      `onTaskResultReceived` with its peer (and the key it forwarded), a
 *      sub-task through its parent's answer (whose repeat re-walks its
 *      stranded sub-claims), falling back to the sub-task's own local door
 *      when the parent is gone. The sweep never writes a settlement itself:
 *      it is the sender's identical retry, and `admitReceipt` decides it.
 *   3. DELIVER — the executor relay's pending federation results are retried
 *      until the origin acknowledges (`processResultDeliveries`).
 *
 * Idempotency: a replay is a REPEAT of the entry's own receipt, so the door
 * routine's order does the rest — a settled entry returns `alreadySettled`
 * and runs nothing; a settlement row already naming the task marks it settled
 * and writes nothing; otherwise the door's settlement step runs once, and the
 * table guards (`installSettlementGuards`: one settlement row per task across
 * both tables, only for the claimed signature; a `settlement_credit` names
 * its row in the same transaction) refuse a second write from any racing
 * door. A claim younger than `graceMs` is skipped by the periodic pass — its
 * own door may still be inside its settlement step — and the boot pass uses
 * no grace (no door is in flight in a process that just started).
 */
import type { DatabaseDriver } from "@motebit/persistence";
import type { ExecutionReceipt } from "@motebit/sdk";
import type { TaskQueueEntry } from "./tasks.js";
import type { AnswerQueue } from "./task-answer.js";
import { claimStoredAnswer } from "./task-answer.js";
import { createLogger } from "./logger.js";

const logger = createLogger({ service: "relay", module: "settlement-recovery" });

/** How long a fresh claim is left to its own door before the periodic pass replays it. */
export const SETTLEMENT_RECOVERY_GRACE_MS = 2 * 60 * 1000;

export interface SettlementRecoveryDeps {
  db: DatabaseDriver;
  taskQueue: AnswerQueue;
  /** The local doors (`TaskRoutesHandle.replayLocalAnswer`). */
  replayLocalAnswer(taskId: string, door: "result_post" | "mcp_forward"): Promise<boolean>;
  /** The federation result door (`onTaskResultReceived`). */
  replayFederationResult(input: {
    taskId: string;
    originRelay: string;
    receipt: ExecutionReceipt;
    agentPublicKey?: string;
  }): Promise<void>;
  /** The executor relay's pending federation result deliveries. */
  deliverPendingResults(now: number): Promise<number>;
}

export interface SettlementRecoveryReport {
  /** Inbound-forward entries that adopted the claim for their stored answer. */
  claimed: string[];
  /** Claimed-but-unsettled entries replayed through their door. */
  replayed: string[];
  /** Of those, the entries settled now. */
  settled: string[];
  /** Federation results the origin acknowledged in this pass. */
  delivered: number;
}

const claimedUnsettled = (e: TaskQueueEntry): boolean =>
  e.receipt != null &&
  e.settled !== true &&
  e.settling != null &&
  e.settling !== "" &&
  e.settling === e.receipt.signature;

/** One recovery pass. */
export async function recoverSettlements(
  deps: SettlementRecoveryDeps,
  opts: { graceMs?: number; now?: number } = {},
): Promise<SettlementRecoveryReport> {
  const now = opts.now ?? Date.now();
  const graceMs = opts.graceMs ?? SETTLEMENT_RECOVERY_GRACE_MS;
  const { db, taskQueue } = deps;
  const report: SettlementRecoveryReport = { claimed: [], replayed: [], settled: [], delivered: 0 };

  // 1. Legacy claim: an inbound forward answered before the claim existed.
  const legacy = db
    .prepare(
      `SELECT task_id FROM relay_task_queue
        WHERE receipt IS NOT NULL
          AND json_extract(task_json, '$.settling') IS NULL
          AND json_extract(task_json, '$.origin_relay') IS NOT NULL`,
    )
    .all() as Array<{ task_id: string }>;
  for (const { task_id } of legacy) {
    try {
      if (claimStoredAnswer(taskQueue, task_id, { kind: "result_post" })?.settling != null) {
        report.claimed.push(task_id);
      }
    } catch (err) {
      logger.warn("settlement.recovery_claim_failed", {
        correlationId: task_id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // 2. Settle: claimed, unsettled, and older than the grace (by its answer's
  //    archive time — the claim's write).
  const candidates = db
    .prepare(
      `SELECT q.task_id FROM relay_task_queue q
         JOIN relay_task_answers a ON a.task_id = q.task_id
        WHERE json_extract(q.task_json, '$.settling') IS NOT NULL
          AND COALESCE(json_extract(q.task_json, '$.settled'), 0) = 0
          AND a.answered_at <= ?
        ORDER BY a.answered_at`,
    )
    .all(now - graceMs) as Array<{ task_id: string }>;
  for (const { task_id } of candidates) {
    const entry = taskQueue.get(task_id);
    if (entry == null || !claimedUnsettled(entry)) continue;
    report.replayed.push(task_id);
    try {
      await replay(deps, task_id, entry);
    } catch (err) {
      // A door's refusal of its own claimed answer (an HTTP error from the
      // federation door) — logged; the claim stays for the next pass.
      logger.warn("settlement.recovery_replay_failed", {
        correlationId: task_id,
        door: entry.settle_via?.kind ?? "result_post",
        error: err instanceof Error ? err.message : String(err),
      });
    }
    if (taskQueue.get(task_id)?.settled === true) report.settled.push(task_id);
    else {
      logger.error("settlement.recovery_unsettled", {
        correlationId: task_id,
        door: entry.settle_via?.kind ?? "result_post",
      });
    }
  }

  // 3. Deliver the executor relay's owed federation results.
  try {
    report.delivered = await deps.deliverPendingResults(now);
  } catch (err) {
    logger.warn("federation.result_delivery_pass_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  if (report.claimed.length + report.replayed.length + report.delivered > 0) {
    logger.info("settlement.recovery_pass", {
      claimed: report.claimed.length,
      replayed: report.replayed.length,
      settled: report.settled.length,
      delivered: report.delivered,
    });
  }
  return report;
}

/** Replay `entry`'s own answer through the door its claim was taken by. */
async function replay(
  deps: SettlementRecoveryDeps,
  taskId: string,
  entry: TaskQueueEntry,
): Promise<void> {
  const receipt = entry.receipt!;
  const via = entry.settle_via ?? { kind: "result_post" as const };
  switch (via.kind) {
    case "result_post":
    case "mcp_forward":
      await deps.replayLocalAnswer(taskId, via.kind);
      return;
    case "federation_result":
      await deps.replayFederationResult({
        taskId,
        originRelay: via.viaPeer,
        receipt,
        ...(via.peerKey != null ? { agentPublicKey: via.peerKey } : {}),
      });
      return;
    case "sub_receipt": {
      // The parent's answer, replayed through ITS door: a repeat of a settled
      // parent re-walks the sub-claims it left unsettled (#890 r10). The
      // sub-task's own local door only when the parent is no longer queued.
      const parent = deps.taskQueue.get(via.parentTaskId);
      if (parent?.receipt != null) {
        const parentVia = parent.settle_via?.kind;
        await deps.replayLocalAnswer(
          via.parentTaskId,
          parentVia === "mcp_forward" ? "mcp_forward" : "result_post",
        );
        if (deps.taskQueue.get(taskId)?.settled === true) return;
      }
      await deps.replayLocalAnswer(taskId, "result_post");
      return;
    }
  }
}
