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
 *      answered or settled entry is never re-answered, except that a
 *      verified `completed` replaces a `failed`/`denied` — the archive's
 *      completed-outranks-failed rule (`getArchivedReceiptForKeyOwner`),
 *      applied identically. The same receipt again is a repeat: the entry
 *      already holds it.
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
import { verificationKeyFor } from "./identity-keys.js";
import { p2pPayeeOf, receiptDischargesP2p } from "./p2p-payee.js";
import {
  admittedBeforeTaskRoutes,
  isRoutedExecutor,
  receiptRelayTaskId,
  taskRoutes,
} from "./task-routing.js";
import { createLogger } from "./logger.js";

const logger = createLogger({ service: "relay", module: "task-answer" });

/** The door a receipt arrived by. */
export type AnswerDoor =
  | { kind: "result_post" }
  | { kind: "mcp_forward" }
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
  | { took: false; refusal: AnswerRefusal; reason: string };

export interface AnswerDeps {
  db: DatabaseDriver;
  identityManager: IdentityManager;
  taskQueue: {
    get(taskId: string): TaskQueueEntry | undefined;
    set(taskId: string, e: TaskQueueEntry): unknown;
  };
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

/**
 * The write-once rule, alone: may `incoming` become the answer of an entry
 * that holds `prior` (and is `settled`)? `repeat` when the entry already
 * holds this receipt.
 */
export function answerRule(
  prior: ExecutionReceipt | undefined,
  settled: boolean,
  incoming: ExecutionReceipt,
): "take" | "replace" | "repeat" | "answered" {
  if (
    prior != null &&
    prior.signature === incoming.signature &&
    prior.motebit_id === incoming.motebit_id
  ) {
    return "repeat";
  }
  if (prior == null && !settled) return "take";
  // Completed outranks failed — the archive's rule, identically.
  if (prior != null && prior.status !== "completed" && incoming.status === "completed") {
    return "replace";
  }
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
  //    one synchronous turn (no await between the read and the write).
  const current = taskQueue.get(taskId);
  if (current == null) return refuse("gone", `task ${taskId} left the queue`);
  const rule = answerRule(current.receipt, current.settled === true, receipt);
  if (rule === "answered") {
    logger.warn("task.answer_refused_answered", {
      correlationId: taskId,
      signer: receipt.motebit_id,
      status: receipt.status,
      prior: current.receipt?.status ?? null,
      settled: current.settled === true,
      door: door.kind,
    });
    return refuse(
      "answered",
      `task ${taskId} is already answered${current.receipt != null ? ` (${current.receipt.status})` : " (settled)"}; an answer is replaced only by a completed receipt over a failed one`,
    );
  }
  if (rule === "repeat") {
    return {
      took: true,
      entry: current,
      first: false,
      replaced: false,
      repeat: true,
      publicKeyHex: sig.key,
    };
  }
  current.receipt = receipt;
  current.task.status = statusOf(receipt);
  current.expiresAt = Math.max(current.expiresAt, Date.now() + retainMs);
  taskQueue.set(taskId, current); // Persist to the durable queue
  if (rule === "replace") {
    logger.info("task.answer_replaced", {
      correlationId: taskId,
      signer: receipt.motebit_id,
      door: door.kind,
    });
  }
  return {
    took: true,
    entry: current,
    first: rule === "take",
    replaced: rule === "replace",
    repeat: false,
    publicKeyHex: sig.key,
  };
}

/**
 * Mark `taskId` settled against the entry as it is NOW — never by writing
 * back a copy read before an await, which could carry a stale answer over a
 * replacement written meanwhile.
 */
export function markTaskSettled(taskQueue: AnswerDeps["taskQueue"], taskId: string): void {
  const current = taskQueue.get(taskId);
  if (current == null || current.settled === true) return;
  current.settled = true;
  taskQueue.set(taskId, current);
}
