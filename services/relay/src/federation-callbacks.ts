/**
 * Federation callback implementations for task forwarding, receipt handling,
 * and settlement. These are the business logic hooks that registerFederationRoutes
 * invokes when verified federation messages arrive from peer relays.
 *
 * Extracted from index.ts to reduce its size and isolate the federation
 * business logic (task queue, trust, credentials, settlement) from the
 * protocol logic (peer validation, signature verification) in federation.ts.
 */

import { HTTPException } from "hono/http-exception";
import type { MotebitDatabase } from "@motebit/persistence";
import type { IdentityManager } from "@motebit/core-identity";
import {
  AgentTaskStatus,
  asMotebitId,
  PLATFORM_FEE_RATE as SDK_DEFAULT_PLATFORM_FEE_RATE,
  AgentTrustLevel,
} from "@motebit/sdk";
import { evaluateTrustTransition, trustLevelToScore } from "@motebit/market";
import type { AgentTask, AgentTrustRecord } from "@motebit/sdk";
/* eslint-disable no-restricted-imports -- Relay service generates its own keypair (not a user surface) */
import {
  verifyExecutionReceipt,
  hexPublicKeyToDidKey,
  issueReputationCredential,
  sign,
  signFederationSettlement,
  signSettlement,
  canonicalJson,
  bytesToHex,
  hexToBytes,
} from "@motebit/encryption";
/* eslint-enable no-restricted-imports */
import { getRelayKeypair } from "./credentials.js";
import {
  AllocationMoneyRefused,
  markForwardDelivered,
  beginForwardSend,
  moveAllocationMoney,
  recordInboundFederatedSettlement,
  recordP2pSettlementAudit,
} from "./allocation-escrow.js";
import type { PeerFetch, RelayIdentity, VerifiedSettlement } from "./federation.js";
import { defaultPeerFetch } from "./federation.js";
import type { TaskQueueEntry } from "./tasks.js";
import type { ConnectedDevice } from "./index.js";
import { createLogger } from "./logger.js";
import { sendToEach } from "./ws-send.js";
import { routeToSockets } from "./task-presentation.js";
import { bindP2pProofToTask, p2pProofKey } from "./idempotency.js";
import { admitReceipt, claimStoredAnswer } from "./task-answer.js";
import type { AnswerQueue } from "./task-answer.js";
import { recordTaskRoute, inboundTaskIdCollision } from "./task-routing.js";
import {
  localWorkerAdmission,
  p2pPayeeOf,
  p2pWorkerLegScope,
  type P2pAdmission,
} from "./p2p-payee.js";

const logger = createLogger({ service: "federation-callbacks" });

export interface FederationCallbackDeps {
  moteDb: MotebitDatabase;
  identityManager: IdentityManager;
  relayIdentity: RelayIdentity;
  connections: Map<string, ConnectedDevice[]>;
  taskQueue: Map<string, TaskQueueEntry> & AnswerQueue;
  issueCredentials: boolean;
  maxTaskQueueSize: number;
  maxTasksPerSubmitter: number;
  taskTtlMs: number;
  /** Platform fee rate (0–1). Defaults to SDK constant (0.05). */
  platformFeeRate?: number;
  /** The peer transport (`PeerFetch`); omitted, the global `fetch`. */
  peerFetch?: PeerFetch;
}

/**
 * Build the three federation callback functions that registerFederationRoutes expects.
 * These close over the shared relay state (taskQueue, connections, moteDb, etc.)
 * and implement the business logic for federated task forwarding, receipt handling,
 * and settlement.
 */
export function createFederationCallbacks(deps: FederationCallbackDeps) {
  const {
    moteDb,
    identityManager,
    relayIdentity,
    connections,
    taskQueue,
    issueCredentials,
    maxTaskQueueSize,
    maxTasksPerSubmitter,
    taskTtlMs,
  } = deps;

  // Platform fee rate lives in closure over the callback set — NOT in a
  // module-level variable. This guarantees every callback returned from
  // this factory sees the same rate for its entire lifetime, and different
  // relay instances (in tests or in a multi-tenant deployment) can have
  // different rates without clobbering each other's module state.
  const platformFeeRate = deps.platformFeeRate ?? SDK_DEFAULT_PLATFORM_FEE_RATE;
  const peerFetch = deps.peerFetch ?? defaultPeerFetch;

  /** The executor relay's admission record for a federated P2P task's hosted worker (#959). */
  // The executor relay HOSTS the worker, so its scope is always `local`
  // (#959 round 3). The recorded address is the worker's own registered one
  // — the only address a worker opts into being paid at P2P (#959 round 4:
  // no registered address ⇒ not P2P-payable, as eligibility rules). With
  // none, no address is admitted and the verifier checks the worker leg
  // against the derived-bound rung alone.
  const executorWorkerAdmission = (workerId: string): P2pAdmission => {
    const reg = moteDb.db
      .prepare("SELECT settlement_address FROM agent_registry WHERE motebit_id = ?")
      .get(workerId) as { settlement_address: string | null } | undefined;
    return reg?.settlement_address
      ? localWorkerAdmission(moteDb.db, workerId, reg.settlement_address)
      : { worker_leg: "local" };
  };

  const collision = (taskId: string, originRelay: string, where: "queued" | "stored") => {
    logger.warn("federation.forward_task_id_in_use", { correlationId: taskId, originRelay, where });
    return { status: "rejected" as const, reason: "task_id_in_use" };
  };

  return {
    onTaskForwarded(verified: {
      taskId: string;
      originRelay: string;
      targetAgent: string;
      payload: {
        prompt: string;
        required_capabilities?: string[];
        submitted_by?: string;
        wall_clock_ms?: number;
      };
      paymentProof?: {
        tx_hash: string;
        chain: string;
        network: string;
        to_address: string;
        amount_micro: number;
        fee_to_address: string;
        fee_amount_micro: number;
        b_fee_to_address?: string;
        b_fee_amount_micro?: number;
      };
    }) {
      // A task id is relay-minted: a peer never gets to choose one that
      // already means something here (#890 round 7). Refused (409) in ANY
      // local form — the task queue, a route, an Idempotency-Key, an
      // archived receipt — never enqueued beside it: an inbound route under
      // a re-used id would otherwise stand as the id's executor after the
      // queue forgot the owner's task. The same peer re-forwarding a task
      // this relay holds for it is its retry (`duplicate` — held, never run
      // twice); anything else is a collision.
      const queued = taskQueue.get(verified.taskId);
      if (queued != null) {
        if (queued.origin_relay === verified.originRelay) {
          return { status: "duplicate" as const, task_id: verified.taskId };
        }
        return collision(verified.taskId, verified.originRelay, "queued");
      }
      // `duplicate` only to the peer whose own forward holds the id (#890
      // r8): routes record the forwarding peer (v52).
      const known = inboundTaskIdCollision(moteDb.db, verified.taskId, verified.originRelay);
      if (known === "inbound_held") {
        return { status: "duplicate" as const, task_id: verified.taskId };
      }
      if (known === "in_use") return collision(verified.taskId, verified.originRelay, "stored");

      // Global queue capacity check (sibling of direct task submission path)
      if (taskQueue.size >= maxTaskQueueSize) {
        return { status: "rejected" as const, reason: "queue_full" };
      }

      // Per-submitter fairness (sibling of direct task submission path)
      const federatedSubmitter = verified.payload.submitted_by ?? `relay:${verified.originRelay}`;
      let submitterCount = 0;
      for (const entry of taskQueue.values()) {
        if (entry.submitted_by === federatedSubmitter) submitterCount++;
        if (submitterCount >= maxTasksPerSubmitter) {
          logger.warn("task.per_submitter_limit_federation", {
            correlationId: verified.taskId,
            submittedBy: federatedSubmitter,
            originRelay: verified.originRelay,
            limit: maxTasksPerSubmitter,
          });
          return { status: "rejected" as const, reason: "per_submitter_limit" };
        }
      }

      const task: AgentTask = {
        task_id: verified.taskId,
        motebit_id: asMotebitId(verified.targetAgent),
        prompt: verified.payload.prompt,
        submitted_at: Date.now(),
        submitted_by: verified.payload.submitted_by ?? `relay:${verified.originRelay}`,
        wall_clock_ms: verified.payload.wall_clock_ms,
        status: AgentTaskStatus.Pending,
        required_capabilities: verified.payload
          .required_capabilities as AgentTask["required_capabilities"],
      };

      const enqueue = (): void => {
        // The executor relay hands the task to its own agent: that agent is
        // the one executor whose receipt this relay accepts for it (#890 r6).
        recordTaskRoute(
          moteDb.db,
          verified.taskId,
          verified.targetAgent,
          "",
          "inbound_forward",
          verified.originRelay,
        );
        taskQueue.set(verified.taskId, {
          task,
          expiresAt: Date.now() + taskTtlMs,
          submitted_by: task.submitted_by,
          origin_relay: verified.originRelay,
          // Cross-operator federated P2P: the origin relay forwarded the
          // delegator's 3-leg proof. The executor relay settles
          // `settlement_mode='p2p'` (worker leg + its own executor-fee leg) and
          // NEVER credits the worker on a virtual account — money already moved
          // onchain. Absent for free/relay-coordinated federated tasks.
          ...(verified.paymentProof
            ? {
                settlement_mode: "p2p" as const,
                p2p_payment_proof: verified.paymentProof,
                // This relay hosts the worker, so it verifies the worker leg
                // (#959). The address is the one this relay holds for its
                // worker at admission; with none, the verifier falls back to
                // the derived address and the current registry address.
                p2p_admission: executorWorkerAdmission(verified.targetAgent),
              }
            : {}),
        });
      };

      if (verified.paymentProof == null) {
        enqueue();
      } else {
        // One proof admits one task on THIS relay too (#918). The executor
        // relay is its own admission door: a peer (an older origin relay, or
        // a misbehaving one) that forwards the same proof under a second
        // task_id would otherwise get the worker to execute twice for one
        // payment; the unique settlement index stops only the second
        // settlement. The claim and the queued task commit together; the
        // same task_id re-forwarded is idempotent (the duplicate check above
        // answers it first while the task is queued).
        const proof = verified.paymentProof;
        let refused = false;
        moteDb.db.exec("BEGIN");
        try {
          const binding = bindP2pProofToTask(
            moteDb.db,
            proof.tx_hash,
            verified.taskId,
            federatedSubmitter,
            // Asserted by the peer, never token-verified on this relay.
            false,
          );
          if (binding.bound) {
            enqueue();
          } else {
            refused = true;
          }
          if (refused) moteDb.db.exec("ROLLBACK");
          else moteDb.db.exec("COMMIT");
        } catch (err) {
          moteDb.db.exec("ROLLBACK");
          throw err;
        }
        if (refused) {
          logger.warn("task.federated_p2p_proof_already_admitted", {
            correlationId: verified.taskId,
            originRelay: verified.originRelay,
            txHash: proof.tx_hash,
          });
          return { status: "rejected" as const, reason: "p2p_proof_already_admitted" };
        }
      }

      // "routed" only when an OPEN socket took the frame (#811). Sockets that
      // are all CLOSING/CLOSED are held for reconnect recovery — this relay
      // has no other door here, on main or now — and answer "pending", as
      // when none is connected: the task stays queued and is re-dispatched
      // when the agent reconnects. The same socket rule as every dispatch
      // site (`routeToSockets`, task-presentation.ts).
      const payload = JSON.stringify({ type: "task_request", task });
      if (routeToSockets(connections.get(verified.targetAgent), payload) === "delivered") {
        return { status: "routed" as const };
      }
      return { status: "pending" as const };
    },

    async onTaskResultReceived(verified: {
      taskId: string;
      originRelay: string;
      receipt: import("@motebit/sdk").ExecutionReceipt;
      /** Executor relay's copy of the worker's public key (hex). See VerifiedTaskResult. */
      agentPublicKey?: string;
    }) {
      const entry = taskQueue.get(verified.taskId);
      if (!entry) throw new HTTPException(404, { message: "Task not found or expired" });

      // A P2P task this relay admitted is settled from a federation result
      // only when that result comes from the executor relay its plan chose
      // (#959 round 4): the origin row records the worker leg as that
      // executor's to verify, so a result from any other peer — or for a
      // task this relay planned for no peer at all — must not settle as
      // 'remote'. Entries admitted before the admission record existed carry
      // none and are not held to it (their row reads 'local', fail-closed).
      const admission = entry.p2p_admission;
      if (
        entry.settlement_mode === "p2p" &&
        admission != null &&
        (admission.planned_peer == null || admission.planned_peer !== verified.originRelay)
      ) {
        logger.error("settlement.federated_p2p_result_from_unplanned_peer", {
          correlationId: verified.taskId,
          plannedPeer: admission.planned_peer ?? null,
          sender: verified.originRelay,
        });
        throw new HTTPException(403, {
          message:
            "Federated P2P result did not come from the executor relay this task was planned for",
        });
      }

      // The answer is decided at ONE chokepoint (#890 r8): the receipt is
      // bound to THIS task, a P2P task's payee signed it, the signer is an
      // executor this relay forwarded the task to THROUGH this peer (an
      // `admission` route — only an own admission forwards outward), its
      // signature verifies (the peer's forwarded key only as a fallback), and
      // the write-once rule holds: a settled or answered task is never
      // re-answered, except a verified completed over a failed. The door
      // answers 200 only when the entry took this receipt.
      const queuedEntry: TaskQueueEntry = entry;
      const admitted = await admitReceipt(
        {
          db: moteDb.db,
          identityManager,
          taskQueue,
          // Without this, a malicious peer relay could forge or tamper with
          // receipts: the executing agent's own signature is verified.
          verifyReceipt: (r, keyHex) => verifyExecutionReceipt(r, hexToBytes(keyHex)),
        },
        verified.taskId,
        verified.receipt,
        {
          kind: "federation_result",
          viaPeer: verified.originRelay,
          ...(verified.agentPublicKey != null ? { peerKey: verified.agentPublicKey } : {}),
        },
        taskTtlMs,
        // The settlement step, on the ENTRY'S claimed answer (#890 round 9) —
        // on the first pass and on a repeat whose settlement never completed
        // (the peer's retry after this relay died between claim and settle).
        ({ receipt: answer, verdict, newlyArchived }) =>
          settleFederatedAnswer(answer, verdict.replaced, newlyArchived),
      );
      if (!admitted.took) {
        logger.error("federation.result_not_taken", {
          correlationId: verified.taskId,
          signer: verified.receipt.motebit_id,
          originRelay: verified.originRelay,
          refusal: admitted.refusal,
        });
        const status =
          admitted.refusal === "gone"
            ? 404
            : admitted.refusal === "not_bound"
              ? 400
              : admitted.refusal === "answered"
                ? 409
                : 403;
        throw new HTTPException(status, {
          message: `Federated result not accepted: ${admitted.reason}${admitted.answer != null ? ` — the task's answer is ${admitted.answer.status}, signed by ${admitted.answer.motebit_id}` : ""}`,
        });
      }
      return;

      /**
       * The federation door's settlement step: fan-out, peer trust, and the
       * origin's settlement (the P2P origin audit row, or the §7 federation
       * settlement + its forward). `true` once the decision is complete.
       */
      async function settleFederatedAnswer(
        answer: import("@motebit/sdk").ExecutionReceipt,
        replaced: boolean,
        newlyArchived: boolean,
      ): Promise<boolean> {
        const entry = queuedEntry;
        // Fan out to submitter
        const submittedBy = entry.submitted_by ?? entry.task.submitted_by;
        if (submittedBy) {
          sendToEach(
            connections.get(submittedBy),
            JSON.stringify({
              type: "task_result",
              task_id: verified.taskId,
              receipt: answer,
            }),
          );
        }

        // Trust update via evaluateTrustTransition — once per task: a completed
        // that replaced an unsettled failed (#890 r8/r9) was counted already.
        try {
          if (replaced) throw new Error("replacement: peer trust already counted");
          if (!newlyArchived) throw new Error("repeat: peer trust already counted");
          const peerRow = moteDb.db
            .prepare(
              "SELECT trust_level, successful_forwards, failed_forwards FROM relay_peers WHERE peer_relay_id = ?",
            )
            .get(verified.originRelay) as
            | { trust_level: AgentTrustLevel; successful_forwards: number; failed_forwards: number }
            | undefined;

          if (peerRow) {
            const isSuccess = answer.status === "completed";
            const newSuccessful = peerRow.successful_forwards + (isSuccess ? 1 : 0);
            const newFailed = peerRow.failed_forwards + (isSuccess ? 0 : 1);

            const trustRecord: AgentTrustRecord = {
              motebit_id: asMotebitId(relayIdentity.relayMotebitId),
              remote_motebit_id: asMotebitId(verified.originRelay),
              trust_level: peerRow.trust_level,
              first_seen_at: 0,
              last_seen_at: Date.now(),
              interaction_count: newSuccessful + newFailed,
              successful_tasks: newSuccessful,
              failed_tasks: newFailed,
            };

            const newLevel = evaluateTrustTransition(trustRecord);
            const trustLevel = newLevel ?? peerRow.trust_level;
            const trustScore = trustLevelToScore(trustLevel);

            moteDb.db
              .prepare(
                "UPDATE relay_peers SET successful_forwards = ?, failed_forwards = ?, trust_level = ?, trust_score = ? WHERE peer_relay_id = ?",
              )
              .run(newSuccessful, newFailed, trustLevel, trustScore, verified.originRelay);

            // Issue credential on trust level transition (only when relay credential issuance is enabled)
            if (issueCredentials && newLevel != null && newLevel !== peerRow.trust_level) {
              try {
                const relayKeys = getRelayKeypair(relayIdentity);
                const peerDid = hexPublicKeyToDidKey(
                  (
                    moteDb.db
                      .prepare("SELECT public_key FROM relay_peers WHERE peer_relay_id = ?")
                      .get(verified.originRelay) as { public_key: string }
                  ).public_key,
                );
                const vc = await issueReputationCredential(
                  {
                    success_rate: newSuccessful / Math.max(1, newSuccessful + newFailed),
                    avg_latency_ms: 0,
                    task_count: newSuccessful + newFailed,
                    trust_score: trustScore,
                    availability: 1.0,
                    measured_at: Date.now(),
                  },
                  relayKeys.privateKey,
                  relayKeys.publicKey,
                  peerDid,
                );
                const credentialType =
                  vc.type.find((t) => t !== "VerifiableCredential") ?? "VerifiableCredential";
                moteDb.db
                  .prepare(
                    "INSERT INTO relay_credentials (credential_id, subject_motebit_id, issuer_did, credential_type, credential_json, issued_at) VALUES (?, ?, ?, ?, ?, ?)",
                  )
                  .run(
                    crypto.randomUUID(),
                    verified.originRelay,
                    vc.issuer,
                    credentialType,
                    JSON.stringify(vc),
                    Date.now(),
                  );
              } catch {
                /* best-effort */
              }
            }
          }
        } catch {
          /* best-effort trust update */
        }

        // Cross-operator federated P2P: the delegator paid all three legs
        // onchain (worker net + origin-fee + executor-fee) in one atomic tx. The
        // ORIGIN relay records its OWN p2p audit row — the origin-fee leg landing
        // in A's treasury — and does NOT run the §7 relay-custody settlement
        // chain (no relay_federation_settlements row, no settlement forward, no
        // worker credit). The executor relay records the mirror p2p row (worker +
        // executor-fee leg) in handleReceiptIngestion. Across both, all three legs
        // are recorded + verified, and the relay's transmitter surface stays zero.
        // See docs/doctrine/off-ramp-as-user-action.md § federated P2P.
        if (entry.settlement_mode === "p2p" && entry.p2p_payment_proof) {
          try {
            const proof = entry.p2p_payment_proof;
            // Payee = the worker the delegator's proof paid: the pinned
            // `target_agent` this relay admitted and forwarded (#959); the
            // receipt's signer was checked against it at the top.
            const workerId = p2pPayeeOf(entry);
            const settlementId = crypto.randomUUID();
            const settledAt = Date.now();
            // This relay's recorded fee = the origin-fee leg (→ A's treasury). The
            // gross at A's hop is the full budget (worker net + both fee legs);
            // platform_fee_rate is the relay's configured rate.
            const originFee = proof.fee_amount_micro;
            const signed = await signSettlement(
              {
                settlement_id: settlementId,
                allocation_id: `p2p-${verified.taskId}` as never,
                motebit_id: workerId,
                receipt_hash: answer.result_hash ?? "",
                ledger_hash: null,
                amount_settled: proof.amount_micro,
                platform_fee: originFee,
                platform_fee_rate: platformFeeRate,
                settlement_mode: "p2p",
                status: "completed",
                settled_at: settledAt,
                issuer_relay_id: relayIdentity.relayMotebitId,
              },
              relayIdentity.privateKey,
            );
            recordP2pSettlementAudit(moteDb.db, {
              settlement_id: settlementId,
              allocation_id: `p2p-${verified.taskId}`,
              task_id: verified.taskId,
              motebit_id: workerId,
              receipt_hash: answer.result_hash ?? "",
              amount_settled: proof.amount_micro,
              platform_fee: originFee,
              platform_fee_rate: platformFeeRate,
              status: "completed",
              settled_at: settledAt,
              settlement_mode: "p2p",
              p2p_tx_hash: p2pProofKey(proof.tx_hash),
              payment_verification_status: "pending",
              delegator_id: entry.submitted_by ?? null,
              // The origin relay verifies only its own fee leg; the worker leg
              // is the executor relay's (the worker is hosted there).
              p2p_worker_leg: p2pWorkerLegScope(entry),
              p2p_worker_address: entry.p2p_admission?.worker_address ?? null,
              p2p_worker_address_rung: entry.p2p_admission?.worker_address_rung ?? null,
              issuer_relay_id: signed.issuer_relay_id,
              suite: signed.suite,
              signature: signed.signature,
              record_json: canonicalJson(signed),
              receipt_signature: answer.signature,
            });
            logger.info("settlement.federated_p2p_origin_audit", {
              correlationId: verified.taskId,
              worker: workerId,
              originFee,
              workerNet: proof.amount_micro,
              txHash: proof.tx_hash,
            });
          } catch (auditErr) {
            logger.error("settlement.federated_p2p_origin_audit_failed", {
              correlationId: verified.taskId,
              error: auditErr instanceof Error ? auditErr.message : String(auditErr),
            });
            // Unsettled: the peer's retry of this result settles it (#890 r9 C2).
            return false;
          }
          return true;
        }

        // Settlement forwarding — through the escrow chokepoint, with an
        // explicit lifecycle (forwardOriginSettlement).
        try {
          if (entry.price_snapshot != null && entry.price_snapshot > 0) {
            await forwardOriginSettlement(moteDb.db, relayIdentity, {
              taskId: verified.taskId,
              peerRelayId: verified.originRelay,
              grossAmount: entry.price_snapshot,
              platformFeeRate,
              receiptHash: answer.result_hash ?? answer.signature ?? "",
              receiptSignature: answer.signature,
              x402TxHash: entry.x402_tx_hash ?? null,
              x402Network: entry.x402_network ?? null,
              peerFetch,
            });
          }
        } catch (settleErr) {
          logger.error("settlement.federated_failed", {
            correlationId: verified.taskId,
            error: settleErr instanceof Error ? settleErr.message : String(settleErr),
          });
          // Unsettled: the peer's retry of this result settles it (#890 r9 C2).
          return false;
        }
        return true;
      }
    },

    async onSettlementReceived(verified: VerifiedSettlement) {
      const feeAmount = Math.round(verified.grossAmount * platformFeeRate);
      const netAmount = verified.grossAmount - feeAmount;
      const settledAt = Date.now();

      // This is the FINAL hop (spec relay-federation-v1 §7.2: agent_id present
      // on the final hop only; downstream_relay_id null). The executing agent is
      // local to this relay — it ran the forwarded task — so the queue entry
      // created by onTaskForwarded names the worker. The forward body does NOT
      // carry agent_id (§7.3); the receiving relay resolves it locally.
      //
      // The receipt this relay's answer is claimed for (#890 r9): the row
      // names it, and the table refuses any other for a task it knows. An
      // entry answered BEFORE the claim existed (a pre-deploy answer whose
      // origin's forward — or its §7.4 retry — lands after the deploy) adopts
      // the claim for exactly its stored answer now, the legacy repeat's rule
      // (#890 r10); an entry the queue already forgot is read from its
      // archived answer (its executor and its claim), unless the task is one
      // of this relay's OWN admissions (a peer's forward never pays those).
      let workerEntry = taskQueue.get(verified.taskId);
      if (workerEntry?.receipt != null && (workerEntry.settling ?? "") === "") {
        workerEntry =
          claimStoredAnswer(taskQueue, verified.taskId, { kind: "result_post" }) ?? workerEntry;
      }
      const archived =
        workerEntry == null
          ? (moteDb.db
              .prepare("SELECT executor_id, settling FROM relay_task_answers WHERE task_id = ?")
              .get(verified.taskId) as { executor_id: string; settling: string | null } | undefined)
          : undefined;
      const ownAdmission =
        archived != null &&
        moteDb.db
          .prepare("SELECT 1 FROM relay_task_routes WHERE task_id = ? AND origin = 'admission'")
          .get(verified.taskId) != null;
      const archivedWorker =
        archived != null && (archived.settling ?? "") !== "" && !ownAdmission
          ? archived.executor_id
          : null;
      const workerId = workerEntry?.task.motebit_id ?? archivedWorker;
      const receiptSignature = workerEntry?.settling ?? archived?.settling ?? null;

      // This relay signs its OWN copy of the received settlement (issuer = this
      // relay), persisting the verbatim signed record for the §9.1 anchor leaf —
      // symmetric with the sent path. `settledAt` is shared with the row's
      // `settled_at` column so anchor reconstruction and the record agree.
      const signedRecord = await signFederationSettlement(
        {
          settlement_id: verified.settlementId,
          task_id: verified.taskId,
          upstream_relay_id: verified.originRelay,
          downstream_relay_id: null,
          agent_id: workerId,
          gross_amount: verified.grossAmount,
          fee_amount: feeAmount,
          net_amount: netAmount,
          fee_rate: platformFeeRate,
          receipt_hash: verified.receiptHash,
          settled_at: settledAt,
          ...(verified.x402TxHash != null ? { x402_tx_hash: verified.x402TxHash } : {}),
          ...(verified.x402Network != null ? { x402_network: verified.x402Network } : {}),
          issuer_relay_id: relayIdentity.relayMotebitId,
        },
        relayIdentity.privateKey,
      );

      // Record the row AND pay the agent atomically (spec §7.3: "records its own
      // settlement entry, and pays the agent"). The unique index on
      // (task_id, upstream_relay_id) makes the INSERT idempotent; we credit the
      // worker ONLY when this row was newly inserted (changes > 0), so a
      // re-delivered settlement forward (the §7.4 retry path) never double-pays.
      // Signing is async and stays OUTSIDE the transaction (sibling discipline
      // to the main settlement path — an await inside BEGIN/COMMIT interleaves).
      // A re-delivered forward (the §7.4 retry path) is a no-op: the row it
      // wrote stands, and pays once. Checked before the INSERT — the
      // one-settlement-per-task guard refuses a second row outright.
      const delivered = moteDb.db
        .prepare(
          "SELECT 1 FROM relay_federation_settlements WHERE task_id = ? AND upstream_relay_id = ?",
        )
        .get(verified.taskId, verified.originRelay);
      if (delivered != null) return { feeAmount, netAmount };

      moteDb.db.exec("BEGIN");
      try {
        recordInboundFederatedSettlement(
          moteDb.db,
          {
            settlement_id: verified.settlementId,
            task_id: verified.taskId,
            upstream_relay_id: verified.originRelay,
            downstream_relay_id: null,
            agent_id: workerId,
            gross_amount: verified.grossAmount,
            fee_amount: feeAmount,
            net_amount: netAmount,
            fee_rate: platformFeeRate,
            settled_at: settledAt,
            receipt_hash: verified.receiptHash,
            x402_tx_hash: verified.x402TxHash ?? null,
            x402_network: verified.x402Network ?? null,
            record_json: canonicalJson(signedRecord),
            receipt_signature: receiptSignature,
          },
          {
            worker: workerId,
            amount: netAmount,
            description: `Federated settlement for task ${verified.taskId}`,
          },
        );
        moteDb.db.exec("COMMIT");
      } catch (settlementErr) {
        moteDb.db.exec("ROLLBACK");
        throw settlementErr;
      }
      return { feeAmount, netAmount };
    },
  };
}

/**
 * The ORIGIN relay's settlement forward (relay-federation-v1 §7.2): the task's
 * gross leaves this relay's escrow for the executing peer. Recorded through
 * the escrow chokepoint as a `pending` forward of the task's allocation, in
 * ONE transaction with its retry row (#890 r9 C2: a process that dies after
 * the row still forwards it) — it counts as moved while the peer may still
 * acknowledge it. The peer's 2xx retires the retry row and marks the forward
 * `delivered`; otherwise the retry loop carries it, and retry exhaustion (or
 * a peer that no longer exists) turns it `failed` and refunds the escrow in
 * one transaction (`refundExhaustedForward`, index.ts). A task with no local
 * allocation, or whose escrow no longer holds the gross, forwards nothing —
 * the relay never sends money it does not hold.
 *
 * Exported so the conservation harness drives this exact function.
 */
export async function forwardOriginSettlement(
  db: MotebitDatabase["db"],
  relayIdentity: RelayIdentity,
  args: {
    taskId: string;
    peerRelayId: string;
    grossAmount: number;
    platformFeeRate: number;
    receiptHash: string;
    receiptSignature?: string | null;
    x402TxHash: string | null;
    x402Network: string | null;
    /** The peer-relay transport (federation.ts `PeerFetch`); defaults to the global fetch. */
    peerFetch?: PeerFetch;
  },
): Promise<"delivered" | "queued" | "refused"> {
  const grossAmount = args.grossAmount;
  const feeAmount = Math.round(grossAmount * args.platformFeeRate);
  const netAmount = grossAmount - feeAmount;
  const settlementId = crypto.randomUUID();
  const settledAt = Date.now();
  const alloc = db
    .prepare("SELECT allocation_id FROM relay_allocations WHERE task_id = ?")
    .get(args.taskId) as { allocation_id: string } | undefined;
  if (!alloc) {
    logger.warn("federation.settlement_forward.no_allocation", {
      correlationId: args.taskId,
      reason: "no local escrow funds this task — nothing to forward",
    });
    return "refused";
  }

  // Mint + sign the canonical FederationSettlementRecord (§9.1
  // verbatim-leaf convergence): the persisted `record_json` is the exact
  // bytes the anchor leaf hashes; `settledAt` is the SAME value written to
  // the row's `settled_at` column.
  const signedRecord = await signFederationSettlement(
    {
      settlement_id: settlementId,
      task_id: args.taskId,
      upstream_relay_id: relayIdentity.relayMotebitId,
      downstream_relay_id: args.peerRelayId,
      agent_id: null,
      gross_amount: grossAmount,
      fee_amount: feeAmount,
      net_amount: netAmount,
      fee_rate: args.platformFeeRate,
      receipt_hash: args.receiptHash,
      settled_at: settledAt,
      ...(args.x402TxHash != null ? { x402_tx_hash: args.x402TxHash } : {}),
      ...(args.x402Network != null ? { x402_network: args.x402Network } : {}),
      issuer_relay_id: relayIdentity.relayMotebitId,
    },
    relayIdentity.privateKey,
  );

  const peerInfo = db
    .prepare("SELECT endpoint_url FROM relay_peers WHERE peer_relay_id = ?")
    .get(args.peerRelayId) as { endpoint_url: string } | undefined;
  const settlementBody = {
    task_id: args.taskId,
    settlement_id: settlementId,
    origin_relay: relayIdentity.relayMotebitId,
    gross_amount: netAmount,
    receipt_hash: args.receiptHash,
    timestamp: Date.now(),
    x402_tx_hash: args.x402TxHash ?? undefined,
    x402_network: args.x402Network ?? undefined,
  };
  const retryId = crypto.randomUUID();
  db.exec("BEGIN");
  try {
    moveAllocationMoney(db, {
      kind: "federated_forward",
      allocationId: alloc.allocation_id,
      amount: grossAmount,
      forward: {
        settlement_id: settlementId,
        task_id: args.taskId,
        upstream_relay_id: relayIdentity.relayMotebitId,
        downstream_relay_id: args.peerRelayId,
        agent_id: null,
        gross_amount: grossAmount,
        fee_amount: feeAmount,
        net_amount: netAmount,
        fee_rate: args.platformFeeRate,
        settled_at: settledAt,
        receipt_hash: args.receiptHash,
        x402_tx_hash: args.x402TxHash,
        x402_network: args.x402Network,
        // Rule 11 analogue: store the exact canonical signed bytes. The
        // anchor leaf is SHA-256 of THIS, so it equals the peer's bytes.
        record_json: canonicalJson(signedRecord),
        receipt_signature: args.receiptSignature ?? null,
      },
    });
    // The retry row commits with the forward — always, even when the peer
    // row is gone: the retry loop's peer-gone path then fails the forward
    // and refunds the escrow (a pending forward with no retry would hold the
    // delegator's money forever). First retry at baseDelayMs (5s).
    db.prepare(
      `INSERT INTO relay_settlement_retries (retry_id, settlement_id, task_id, peer_relay_id, payload_json, attempts, max_attempts, next_retry_at, status, created_at) VALUES (?, ?, ?, ?, ?, 0, 8, ?, 'pending', ?)`,
    ).run(
      retryId,
      settlementId,
      args.taskId,
      args.peerRelayId,
      JSON.stringify(settlementBody),
      Date.now() + 5_000,
      Date.now(),
    );
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    if (err instanceof AllocationMoneyRefused) {
      logger.error("federation.settlement_forward.refused", {
        correlationId: args.taskId,
        allocationId: alloc.allocation_id,
        reason: err.reason,
      });
      return "refused";
    }
    throw err;
  }

  if (peerInfo) {
    const settlementSig = await sign(
      new TextEncoder().encode(canonicalJson(settlementBody)),
      relayIdentity.privateKey,
    );
    // The forward lifecycle's send claim, in the same turn as the send: a
    // freeze that landed during the signing await refuses it, and the
    // committed retry row carries the send to after unfreeze.
    try {
      if (!beginForwardSend(db, settlementId)) return "queued";
    } catch (err) {
      logger.warn("federation.settlement_forward.send_deferred", {
        correlationId: args.taskId,
        error: err instanceof Error ? err.message : String(err),
      });
      return "queued";
    }
    try {
      const resp = await (args.peerFetch ?? defaultPeerFetch)(
        `${peerInfo.endpoint_url}/federation/v1/settlement/forward`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Correlation-ID": args.taskId },
          body: JSON.stringify({ ...settlementBody, signature: bytesToHex(settlementSig) }),
          signal: AbortSignal.timeout(10000),
        },
      );
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      // Delivered: the retry row is retired and the forward is `delivered`,
      // together.
      db.exec("BEGIN");
      try {
        db.prepare(
          "DELETE FROM relay_settlement_retries WHERE retry_id = ? AND status = 'pending' AND attempts = 0",
        ).run(retryId);
        markForwardDelivered(db, settlementId);
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
      return "delivered";
    } catch {
      // Settlement forward failed — the committed retry row carries it,
      // with exponential backoff; the forward stays `pending`.
    }
  }
  return "queued";
}
