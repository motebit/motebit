/**
 * A task's ANSWER is decided here, and only here (#890 round 8).
 *
 * Every door a receipt enters by — the result POST, the MCP forward's
 * callback (both through `handleReceiptIngestion`), and the federation result
 * (`onTaskResultReceived`) — calls `answerTask`. It is the one writer of a
 * queue entry's `receipt` and terminal `task.status` (a static test in
 * `__tests__/receipt-doors-890.test.ts` fails on any other assignment), and
 * it decides in a fixed order:
 *
 *   1. the receipt is bound to THIS task (`relay_task_id`);
 *   2. a P2P task is answered only by the worker it was paid to (#959);
 *   3. the signer is a recorded executor of this task, through the door's
 *      peer, on a route of the task's own origin (`isRoutedExecutor`, #890
 *      r6/r7) — the local doors by the entry's `origin_relay`, the
 *      federation door `admission` only;
 *   4. the signature verifies under the signer's key (the federation door
 *      alone may fall back to the key the peer forwards);
 *   5. ONE write-once rule, decided and written in the same synchronous turn
 *      against the entry as it is NOW (the durable queue hands out copies):
 *      an entry with no answer that is not settled takes the receipt; an
 *      answered entry is never re-answered, except that a verified
 *      `completed` replaces a `failed`/`denied` while the answer is
 *      UNSETTLED. The same receipt again is a repeat: the entry already
 *      holds it.
 *
 * An answer and its settlement are ONE decision (#890 round 9): the write
 * that takes an answer also CLAIMS its settlement (`settling` = the
 * receipt's signature), so from that write on the answer is frozen and
 * every door settles the ENTRY'S receipt — never a door-local copy — and
 * marks it settled only for that receipt (`markTaskSettled`). A settled or
 * claimed answer is refused a different receipt (the door answers 409 with
 * the standing answer). The write goes through `TaskQueue.writeAnswer` with
 * the answer capability only this module holds (a compare-and-set on the
 * entry's answer version), and archives the answer in the same transaction
 * (`relay_task_answers`, keyed by the task), so the poll after eviction
 * answers exactly what it answered live.
 *
 * A door reports acceptance ONLY when this returns `took: true` — positive
 * evidence that the entry holds this receipt. Anything else (settled,
 * answered, gone, refused) is not acceptance.
 */
import type { IdentityManager } from "@motebit/core-identity";
import type { DatabaseDriver } from "@motebit/persistence";
import type { ExecutionReceipt } from "@motebit/sdk";
import { AgentTaskStatus, asMotebitId } from "@motebit/sdk";
/* eslint-disable no-restricted-imports -- diagnostic re-verification of a refused receipt */
import { verifyExecutionReceiptDetailed, hexToBytes } from "@motebit/encryption";
/* eslint-enable no-restricted-imports */
import { verifySovereignBinding } from "@motebit/crypto";
import type { TaskQueueEntry } from "./tasks.js";
import { issueAnswerCapability } from "./task-queue.js";
import type { AnswerCapability } from "./task-queue.js";
import { verificationKeyFor } from "./identity-keys.js";
import { p2pPayeeOf, receiptDischargesP2p } from "./p2p-payee.js";
import {
  admittedBeforeTaskRoutes,
  isRoutedExecutor,
  receiptRelayTaskId,
  taskRoutes,
} from "./task-routing.js";
import { persistReceiptChain } from "./receipts-store.js";
import { createLogger } from "./logger.js";

const logger = createLogger({ service: "relay", module: "task-answer" });

/**
 * The answer capability (#890 round 9): issued ONCE, here, at import — the
 * queue's `writeAnswer` refuses any other object, and a second
 * `issueAnswerCapability` throws. It never leaves this module.
 */
const ANSWER_CAP: AnswerCapability = issueAnswerCapability();

/** The queue surface the answer is written through. */
export interface AnswerQueue {
  get(taskId: string): TaskQueueEntry | undefined;
  writeAnswer(
    cap: AnswerCapability,
    taskId: string,
    expectedVersion: number,
    mutate: (entry: TaskQueueEntry) => void,
  ): TaskQueueEntry | null;
}

/** The door a receipt arrived by. */
export type AnswerDoor =
  | { kind: "result_post" }
  | { kind: "mcp_forward" }
  /**
   * A sub-task's receipt embedded in its parent's answer (multi-hop): the
   * sub-task's OWN answer, taken through this chokepoint before it is
   * settled (#890 r9 C1).
   */
  | { kind: "sub_receipt"; parentTaskId: string }
  | {
      kind: "federation_result";
      /** The peer relay the result arrived from (its envelope signer). */
      viaPeer: string;
      /** The executor relay's copy of the signer's key, when it sent one. */
      peerKey?: string;
    };

export type AnswerRefusal =
  "gone" | "not_bound" | "not_payee" | "not_routed" | "no_key" | "bad_signature" | "answered";

export type AnswerVerdict =
  | {
      took: true;
      /** The entry as written (or, on a repeat, as it stands). */
      entry: TaskQueueEntry;
      /** The receipt is the entry's first answer. */
      first: boolean;
      /** A verified `completed` replaced a `failed`/`denied` answer. */
      replaced: boolean;
      /** The entry already held this very receipt. */
      repeat: boolean;
      /** The key the signature verified under (hex). */
      publicKeyHex: string;
    }
  | {
      took: false;
      refusal: AnswerRefusal;
      reason: string;
      /** On `answered`: the task's standing (settled) answer. */
      answer?: ExecutionReceipt;
    };

export interface AnswerDeps {
  db: DatabaseDriver;
  identityManager: IdentityManager;
  taskQueue: AnswerQueue;
  /**
   * The door's receipt-signature verifier (`verifyExecutionReceipt` over the
   * hex key). REQUIRED: each consuming door supplies and is seen to call its
   * verifier (`check-signed-artifact-consumed-verified`); the chokepoint
   * calls it before any write.
   */
  verifyReceipt: (receipt: ExecutionReceipt, publicKeyHex: string) => Promise<boolean>;
  /**
   * The local doors' registry heal: set `motebitId`'s registry key to
   * `publicKeyHex` — called ONLY for an embedded key already registered as one
   * of that identity's devices, after the receipt verified under it (main's
   * heal, #703 build 4; the registered writer lives in tasks.ts). Absent on
   * the federation door, which never heals.
   */
  healRegistryKey?: (motebitId: string, publicKeyHex: string) => void;
}

const refuse = (refusal: AnswerRefusal, reason: string): AnswerVerdict => ({
  took: false,
  refusal,
  reason,
});

/** The queue status a receipt's status answers. */
function statusOf(receipt: ExecutionReceipt): AgentTaskStatus {
  return receipt.status === "completed"
    ? AgentTaskStatus.Completed
    : receipt.status === "denied"
      ? AgentTaskStatus.Denied
      : AgentTaskStatus.Failed;
}

/** The receipt a settlement row settled: its signature, or (legacy) its hash. */
export interface SettlementNaming {
  receipt_signature: string | null;
  receipt_hash: string;
}

/** Every settlement row, in either settlement table, that names `taskId`. */
export function settlementRowsFor(db: DatabaseDriver, taskId: string): SettlementNaming[] {
  return [
    ...(db
      .prepare("SELECT receipt_signature, receipt_hash FROM relay_settlements WHERE task_id = ?")
      .all(taskId) as SettlementNaming[]),
    ...(db
      .prepare(
        "SELECT receipt_signature, receipt_hash FROM relay_federation_settlements WHERE task_id = ?",
      )
      .all(taskId) as SettlementNaming[]),
  ];
}

/**
 * Does `row` name `receipt`? By signature; a row written before the
 * signature column existed, by the hash its writer recorded (`result_hash`,
 * or the signature on the federation row).
 */
function rowNames(row: SettlementNaming, receipt: ExecutionReceipt): boolean {
  if (row.receipt_signature != null) return row.receipt_signature === receipt.signature;
  return (
    row.receipt_hash !== "" &&
    (row.receipt_hash === receipt.result_hash || row.receipt_hash === receipt.signature)
  );
}

/**
 * An entry's answer is FROZEN once its settlement is claimed (`settling`) or
 * done (`settled`) — or once ANY settlement row names the task, whether or
 * not the entry holds an answer (#890 r9 C1: a settlement written for a
 * receipt the entry never held freezes it too).
 */
export function answerFrozen(db: DatabaseDriver, entry: TaskQueueEntry, taskId: string): boolean {
  if (entry.settled === true || (entry.settling != null && entry.settling !== "")) return true;
  return settlementRowsFor(db, taskId).length > 0;
}

/**
 * The write-once rule, alone: may `incoming` become the answer of an entry
 * that holds `prior` (`frozen`: its settlement is claimed or done)? `repeat`
 * when the entry already holds this receipt.
 */
export function answerRule(
  prior: ExecutionReceipt | undefined,
  frozen: boolean,
  incoming: ExecutionReceipt,
): "take" | "replace" | "repeat" | "answered" {
  if (
    prior != null &&
    prior.signature === incoming.signature &&
    prior.motebit_id === incoming.motebit_id
  ) {
    return "repeat";
  }
  // A settled (or settlement-claimed) answer is frozen: nothing replaces it.
  if (frozen) return "answered";
  if (prior == null) return "take";
  // Completed outranks failed — only while the answer is unsettled.
  if (prior.status !== "completed" && incoming.status === "completed") return "replace";
  return "answered";
}

/** Signature step: resolve the signer's key and verify. */
async function verifySignature(
  deps: AnswerDeps,
  taskId: string,
  receipt: ExecutionReceipt,
  door: AnswerDoor,
): Promise<{ refusal: AnswerRefusal } | { key: string }> {
  const { db, identityManager } = deps;
  if (typeof receipt.signature !== "string" || receipt.signature === "") {
    return { refusal: "bad_signature" };
  }
  const regRow = db
    .prepare("SELECT public_key FROM agent_registry WHERE motebit_id = ?")
    .get(receipt.motebit_id) as { public_key: string } | undefined;
  // Holder, else main's registry read (§5f verification reader).
  let pubKeyHex: string | undefined =
    verificationKeyFor(db, receipt.motebit_id, regRow?.public_key) ?? undefined;
  let keySource = "local_registry";
  if (pubKeyHex === undefined) {
    const devices = await identityManager.listDevices(asMotebitId(receipt.motebit_id));
    const device =
      (door.kind !== "federation_result" && receipt.device_id != null
        ? devices.find((d) => d.device_id === receipt.device_id)
        : undefined) ?? devices.find((d) => d.public_key);
    if (device?.public_key) {
      pubKeyHex = device.public_key;
      keySource = "local_device";
    }
  }
  // The executor relay forwards the worker's key (the worker is registered
  // THERE): only the federation door may use it.
  if (pubKeyHex === undefined && door.kind === "federation_result" && door.peerKey) {
    pubKeyHex = door.peerKey;
    keySource = "peer_forwarded";
  }
  if (pubKeyHex === undefined) {
    logger.error("receipt.verification_failed", {
      correlationId: taskId,
      executingAgentId: receipt.motebit_id,
      reason: "no public key found for executing agent",
      door: door.kind,
    });
    return { refusal: "no_key" };
  }

  let valid = await deps.verifyReceipt(receipt, pubKeyHex);

  // Local doors only: reconcile the registry from the key embedded in the
  // receipt — but ONLY when that embedded key is ALREADY a registered device
  // of receipt.motebit_id (never an arbitrary self-signed key: a
  // cross-identity hijack). Legitimate rotation is /rotate-key.
  if (
    !valid &&
    door.kind !== "federation_result" &&
    deps.healRegistryKey != null &&
    typeof receipt.public_key === "string" &&
    receipt.public_key !== "" &&
    receipt.public_key !== pubKeyHex
  ) {
    const devices = await identityManager.listDevices(asMotebitId(receipt.motebit_id));
    if (devices.some((d) => d.public_key === receipt.public_key)) {
      valid = await deps.verifyReceipt(receipt, receipt.public_key);
      if (valid) {
        pubKeyHex = receipt.public_key;
        deps.healRegistryKey(receipt.motebit_id, receipt.public_key);
        logger.info("receipt.public_key_updated", {
          correlationId: taskId,
          motebitId: receipt.motebit_id,
          reason: "embedded key is a registered device, registry reconciled",
        });
      }
    }
  }

  if (!valid) {
    // Emit the canonical bytes the verifier reproduced so the producer can
    // byte-diff against its own sign-time hash (DEBUG_RECEIPT_BYTES=1).
    const detail = await verifyExecutionReceiptDetailed(receipt, hexToBytes(pubKeyHex));
    logger.error("receipt.verification_failed", {
      correlationId: taskId,
      reason: "invalid Ed25519 signature",
      door: door.kind,
      keySource,
      canonical_sha256: detail.canonical_sha256,
      canonical_preview: detail.canonical_preview,
      detail_reason: detail.reason,
    });
    return { refusal: "bad_signature" };
  }
  if (door.kind === "federation_result") {
    // Binding strength (identity-binding-verification.md): observability,
    // never a gate (additive).
    const sovereignlyBound = await verifySovereignBinding(receipt.motebit_id, pubKeyHex);
    logger.info("federation.receipt_verified", {
      correlationId: taskId,
      executingAgent: receipt.motebit_id,
      keySource,
      bindingStrength: sovereignlyBound ? "sovereign" : "peer_attested",
    });
  }
  return { key: pubKeyHex };
}

/**
 * Decide — and, when it takes, write — the answer of `taskId`. See the
 * module comment for the order. `retainMs` extends the entry's life so the
 * answer can be read (the POST door keeps paid results longer).
 */
export async function answerTask(
  deps: AnswerDeps,
  taskId: string,
  receipt: ExecutionReceipt,
  door: AnswerDoor,
  retainMs: number,
): Promise<AnswerVerdict> {
  const { db, taskQueue } = deps;
  const entry = taskQueue.get(taskId);
  if (entry == null) return refuse("gone", `task ${taskId} is not in the queue`);

  // 1. Bound to THIS task.
  const boundTo = receiptRelayTaskId(receipt);
  if (boundTo !== taskId) {
    return refuse("not_bound", `receipt is bound to task ${boundTo || "(none)"}, not ${taskId}`);
  }

  // 2. A P2P task answers only its payee (#959).
  if (entry.settlement_mode === "p2p" && !receiptDischargesP2p(entry, receipt.motebit_id)) {
    logger.error("settlement.p2p_receipt_not_from_payee", {
      correlationId: taskId,
      payee: p2pPayeeOf(entry),
      signer: receipt.motebit_id,
      door: door.kind,
    });
    return refuse(
      "not_payee",
      `receipt is signed by ${receipt.motebit_id}, not by the worker this P2P task was paid to (${p2pPayeeOf(entry)})`,
    );
  }

  // 3. A recorded executor, through the door's peer, on a route of the
  //    task's own origin (#890 r6/r7).
  let routed: boolean;
  if (door.kind === "federation_result") {
    // Only this relay's own admission forwards a task to a peer. A P2P task
    // admitted before the routing record existed carries its route in its
    // admission: the payee (step 2) through the planned peer.
    const admittedRoute =
      entry.settlement_mode === "p2p" &&
      entry.p2p_admission?.planned_peer != null &&
      entry.p2p_admission.planned_peer === door.viaPeer &&
      admittedBeforeTaskRoutes(db, entry.task.submitted_at);
    routed =
      taskRoutes(db, taskId, "admission").length === 0 && admittedRoute
        ? true
        : isRoutedExecutor(db, taskId, receipt.motebit_id, door.viaPeer, null, "admission");
  } else {
    routed = isRoutedExecutor(
      db,
      taskId,
      receipt.motebit_id,
      "",
      { executor: entry.task.motebit_id, submittedAt: entry.task.submitted_at },
      entry.origin_relay != null ? "inbound_forward" : "admission",
    );
  }
  if (!routed) {
    logger.error("receipt.signer_not_routed_executor", {
      correlationId: taskId,
      signer: receipt.motebit_id,
      door: door.kind,
      ...(door.kind === "federation_result" ? { viaPeer: door.viaPeer } : {}),
    });
    return refuse(
      "not_routed",
      door.kind === "federation_result"
        ? `receipt is not from the executor, through the peer, task ${taskId} was forwarded to`
        : `receipt is signed by ${receipt.motebit_id}, which this relay never handed task ${taskId} to`,
    );
  }

  // 4. The signature.
  const sig = await verifySignature(deps, taskId, receipt, door);
  if ("refusal" in sig) {
    return sig.refusal === "no_key"
      ? refuse("no_key", `no public key on file for agent ${receipt.motebit_id}`)
      : refuse(sig.refusal, "invalid Ed25519 signature");
  }

  // 5. Write-once — decided and written against the entry as it is NOW, in
  //    one synchronous turn (no await between the read and the write), and
  //    the answer's SETTLEMENT is claimed in the same write (#890 round 9):
  //    `settling` names this receipt, so the answer is frozen from here on
  //    and every door settles only the entry's own receipt.
  const current = taskQueue.get(taskId);
  if (current == null) return refuse("gone", `task ${taskId} left the queue`);
  // A settlement row names the task but the entry holds no answer (a
  // legacy door paid it without answering it): the entry may take exactly
  // the receipt every row settled — settled in the same write — and nothing
  // else (#890 r9 C1).
  const rows = settlementRowsFor(db, taskId);
  if (current.receipt == null && rows.length > 0) {
    const adoptable =
      rows.every((row) => rowNames(row, receipt)) &&
      (current.settling == null || current.settling === receipt.signature);
    if (!adoptable) {
      logger.warn("task.answer_refused_settled_elsewhere", {
        correlationId: taskId,
        signer: receipt.motebit_id,
        door: door.kind,
      });
      return refuse(
        "answered",
        `task ${taskId} is already settled on another receipt; a settled task is never re-answered`,
      );
    }
    const adopted = taskQueue.writeAnswer(ANSWER_CAP, taskId, current.answer_version ?? 0, (e) => {
      e.receipt = receipt;
      e.task.status = statusOf(receipt);
      e.expiresAt = Math.max(e.expiresAt, Date.now() + retainMs);
      e.settling = receipt.signature;
      e.settled = true;
    });
    if (adopted == null) {
      return refuse("answered", `task ${taskId} changed while its answer was being written`);
    }
    return {
      took: true,
      entry: adopted,
      first: true,
      replaced: false,
      repeat: false,
      publicKeyHex: sig.key,
    };
  }
  const rule = answerRule(current.receipt, answerFrozen(db, current, taskId), receipt);
  if (rule === "answered") {
    logger.warn("task.answer_refused_answered", {
      correlationId: taskId,
      signer: receipt.motebit_id,
      status: receipt.status,
      prior: current.receipt?.status ?? null,
      settled: current.settled === true,
      settling: current.settling != null,
      door: door.kind,
    });
    return {
      took: false,
      refusal: "answered",
      reason: `task ${taskId} is already answered${current.receipt != null ? ` (${current.receipt.status})` : " (settled)"}; a settled answer is never replaced`,
      ...(current.receipt != null ? { answer: current.receipt } : {}),
    };
  }
  if (rule === "repeat") {
    // An entry answered before the settlement claim existed: claim it now,
    // for the receipt it already holds, so the resubmission that recovers
    // its settlement settles THIS answer.
    let entry = current;
    if (current.settled !== true && current.settling == null) {
      entry =
        taskQueue.writeAnswer(ANSWER_CAP, taskId, current.answer_version ?? 0, (e) => {
          e.settling = receipt.signature;
        }) ?? current;
    }
    return {
      took: true,
      entry,
      first: false,
      replaced: false,
      repeat: true,
      publicKeyHex: sig.key,
    };
  }
  const written = taskQueue.writeAnswer(ANSWER_CAP, taskId, current.answer_version ?? 0, (e) => {
    e.receipt = receipt;
    e.task.status = statusOf(receipt);
    e.expiresAt = Math.max(e.expiresAt, Date.now() + retainMs);
    e.settling = receipt.signature;
  });
  if (written == null) {
    // Unreachable in one synchronous turn; never a silent overwrite.
    return refuse("answered", `task ${taskId} changed while its answer was being written`);
  }
  if (rule === "replace") {
    logger.info("task.answer_replaced", {
      correlationId: taskId,
      signer: receipt.motebit_id,
      door: door.kind,
    });
  }
  return {
    took: true,
    entry: written,
    first: rule === "take",
    replaced: rule === "replace",
    repeat: false,
    publicKeyHex: sig.key,
  };
}

/** What a door's settlement step is handed: the ENTRY's claimed answer. */
export interface SettleInput {
  entry: TaskQueueEntry;
  receipt: ExecutionReceipt;
  verdict: Extract<AnswerVerdict, { took: true }>;
  /** `persistReceiptChain` archived this receipt now (not on an earlier pass). */
  newlyArchived: boolean;
}

/**
 * A door's settlement step: `true` once the settlement DECISION is complete
 * (written, or deliberately nothing to write — unfunded, free, deferred to
 * the origin); `false` (or a throw) leaves the answer claimed and unsettled,
 * so the next retry of the same receipt — or the next restart's — settles it.
 */
export type SettleStep = (input: SettleInput) => Promise<boolean>;

export type Admission =
  | Extract<AnswerVerdict, { took: false }>
  | (Extract<AnswerVerdict, { took: true }> & {
      /** The entry's answer (the receipt every effect is bound to). */
      receipt: ExecutionReceipt;
      /** Settled before this call (a repeat, or adopted from a settlement row). */
      alreadySettled: boolean;
      /** The entry is settled now. */
      settled: boolean;
      newlyArchived: boolean;
    });

/**
 * THE door routine (#890 round 9): every door a receipt enters by — the
 * result POST, the MCP forward's callback, the federation result, and a
 * sub-task's receipt embedded in its parent's answer — admits it here, and
 * only here (a static test fails on any other caller of `answerTask` or
 * `markTaskSettled`):
 *
 *   1. `answerTask` decides the answer and claims its settlement in one write;
 *   2. a settled answer is `alreadySettled` — nothing re-runs;
 *   3. an answer claimed but not settled — the first pass, OR a repeat after a
 *      crash or a failed settlement between the claim and the settle — is
 *      settled NOW, on the ENTRY's receipt (`repeat && !settled → settle`);
 *   4. a settlement row already naming the task means it settled (by whichever
 *      door wrote it): marked, never written twice;
 *   5. only a COMPLETED settlement step marks the entry settled.
 *
 * The tables enforce the rest (task-queue.ts `installSettlementGuards`): a
 * settlement row is inserted only for the receipt its task is claimed for,
 * once per task across both settlement tables.
 */
export async function admitReceipt(
  deps: AnswerDeps,
  taskId: string,
  receipt: ExecutionReceipt,
  door: AnswerDoor,
  retainMs: number,
  settle: SettleStep,
): Promise<Admission> {
  const verdict = await answerTask(deps, taskId, receipt, door, retainMs);
  if (!verdict.took) return verdict;
  const entry = verdict.entry;
  const answer = entry.receipt;
  if (answer != null && entry.settled === true) {
    logger.info("settlement.already_settled", { correlationId: taskId, door: door.kind });
    return {
      ...verdict,
      receipt: answer,
      alreadySettled: true,
      settled: true,
      newlyArchived: false,
    };
  }
  if (answer == null || entry.settling !== answer.signature) {
    logger.error("settlement.unclaimed_answer", { correlationId: taskId, door: door.kind });
    return refuse("answered", `task ${taskId}'s answer is not claimed for settlement`) as Extract<
      AnswerVerdict,
      { took: false }
    >;
  }
  // Archive the signed receipt tree (rule 12, insert-only). Before the
  // settlement step, so a re-submission still archives when an earlier
  // write failed; `newlyArchived` keeps trust and credentials once per receipt.
  const newlyArchived = persistReceiptChain(deps.db, answer);
  if (settlementRowsFor(deps.db, taskId).length > 0) {
    markTaskSettled(deps.taskQueue, taskId, answer.signature);
    logger.info("settlement.duplicate", { correlationId: taskId, door: door.kind });
    return {
      ...verdict,
      entry: deps.taskQueue.get(taskId) ?? entry,
      receipt: answer,
      alreadySettled: true,
      settled: true,
      newlyArchived,
    };
  }
  let done = false;
  try {
    done = await settle({ entry, receipt: answer, verdict, newlyArchived });
  } catch (err) {
    logger.error("settlement.step_failed", {
      correlationId: taskId,
      door: door.kind,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  if (done) markTaskSettled(deps.taskQueue, taskId, answer.signature);
  return {
    ...verdict,
    entry: deps.taskQueue.get(taskId) ?? entry,
    receipt: answer,
    alreadySettled: false,
    settled: done,
    newlyArchived,
  };
}

/**
 * Mark `taskId` settled — against the entry as it is NOW, and only when its
 * settlement claim names `receiptSignature` (the receipt the caller settled).
 */
export function markTaskSettled(
  taskQueue: AnswerQueue,
  taskId: string,
  receiptSignature: string,
): void {
  const current = taskQueue.get(taskId);
  if (current == null || current.settled === true) return;
  // Only the claim counts: a receipt the entry was never claimed for is
  // never marked settled (#890 r9).
  const claimedFor = current.settling;
  if (claimedFor !== receiptSignature) {
    logger.error("settlement.mark_for_unclaimed_receipt", {
      correlationId: taskId,
      claimedFor: claimedFor ?? null,
    });
    return;
  }
  taskQueue.writeAnswer(ANSWER_CAP, taskId, current.answer_version ?? 0, (e) => {
    e.settled = true;
    e.settling = receiptSignature;
  });
}
