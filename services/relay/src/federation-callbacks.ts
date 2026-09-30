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
import { verifySovereignBinding } from "@motebit/crypto";
import { getRelayKeypair } from "./credentials.js";
import { creditAccount } from "./accounts.js";
import type { RelayIdentity, VerifiedSettlement } from "./federation.js";
import type { TaskQueueEntry } from "./tasks.js";
import type { ConnectedDevice } from "./index.js";
import { createLogger } from "./logger.js";
import { verificationKeyFor } from "./identity-keys.js";
import { sendToEach } from "./ws-send.js";
import { routeToSockets } from "./task-presentation.js";
import { bindP2pProofToTask, p2pProofKey } from "./idempotency.js";
import { persistReceiptChain } from "./receipts-store.js";
import {
  recordTaskRoute,
  isRoutedExecutor,
  receiptRelayTaskId,
  taskRoutes,
  admittedBeforeTaskRoutes,
} from "./task-routing.js";
import {
  localWorkerAdmission,
  p2pPayeeOf,
  p2pWorkerLegScope,
  receiptDischargesP2p,
  type P2pAdmission,
} from "./p2p-payee.js";

const logger = createLogger({ service: "federation-callbacks" });

export interface FederationCallbackDeps {
  moteDb: MotebitDatabase;
  identityManager: IdentityManager;
  relayIdentity: RelayIdentity;
  connections: Map<string, ConnectedDevice[]>;
  taskQueue: Map<string, TaskQueueEntry>;
  issueCredentials: boolean;
  maxTaskQueueSize: number;
  maxTasksPerSubmitter: number;
  taskTtlMs: number;
  /** Platform fee rate (0–1). Defaults to SDK constant (0.05). */
  platformFeeRate?: number;
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
      // Idempotency: reject duplicate task_id to prevent double-execution
      // when the origin relay retries after a timeout.
      if (taskQueue.has(verified.taskId)) {
        return { status: "duplicate" as const, task_id: verified.taskId };
      }

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
        recordTaskRoute(moteDb.db, verified.taskId, verified.targetAgent);
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

      // A federated result answers a task only when the receipt is bound to
      // THAT task and signed by the executor this relay forwarded it to,
      // through the peer it forwarded it through (#890 round 6). Any other
      // active peer — or the right peer vouching for an invented signer — is
      // refused before the entry, the submitter's socket, trust or
      // settlement is touched. A task routed locally has no peer on its
      // route, so no peer can answer it at all.
      const boundTo = receiptRelayTaskId(verified.receipt);
      if (boundTo !== verified.taskId) {
        logger.error("federation.result_bound_to_other_task", {
          correlationId: verified.taskId,
          boundTo,
          originRelay: verified.originRelay,
        });
        throw new HTTPException(400, {
          message: `Federated receipt is bound to task ${boundTo}, not ${verified.taskId}`,
        });
      }
      // A P2P task admitted before the routing record existed (in flight
      // across the deploy) carries its route in its admission: the payee
      // (checked below) through the planned peer (checked below).
      const admittedRoute =
        entry.settlement_mode === "p2p" &&
        entry.p2p_admission?.planned_peer != null &&
        admittedBeforeTaskRoutes(moteDb.db, entry.task.submitted_at);
      const routed =
        taskRoutes(moteDb.db, verified.taskId).length === 0 && admittedRoute
          ? true
          : isRoutedExecutor(
              moteDb.db,
              verified.taskId,
              verified.receipt.motebit_id,
              verified.originRelay,
              null,
            );
      if (!routed) {
        logger.error("federation.result_not_from_routed_executor", {
          correlationId: verified.taskId,
          signer: verified.receipt.motebit_id,
          originRelay: verified.originRelay,
        });
        throw new HTTPException(403, {
          message:
            "Federated result is not from the executor, through the peer, this task was forwarded to",
        });
      }

      // A P2P task was paid to ONE worker (#959): a result whose receipt is
      // signed by anyone else is not the work paid for. Refused before the
      // entry is touched — it neither overwrites the delivered result nor
      // reaches the submitter, trust, or the settlement record.
      if (
        entry.settlement_mode === "p2p" &&
        !receiptDischargesP2p(entry, verified.receipt.motebit_id)
      ) {
        logger.error("settlement.federated_p2p_receipt_not_from_payee", {
          correlationId: verified.taskId,
          payee: p2pPayeeOf(entry),
          signer: verified.receipt.motebit_id,
          originRelay: verified.originRelay,
        });
        throw new HTTPException(403, {
          message: "Federated P2P result is not signed by the worker the task was paid to",
        });
      }

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

      // Verify executing agent's Ed25519 receipt signature (sibling of direct receipt path).
      // Without this, a malicious peer relay could forge or tamper with receipts.
      if (verified.receipt.signature) {
        let pubKeyHex: string | undefined;
        let keySource: "local_registry" | "local_device" | "peer_forwarded" | undefined;
        const regRow = moteDb.db
          .prepare("SELECT public_key FROM agent_registry WHERE motebit_id = ?")
          .get(verified.receipt.motebit_id) as { public_key: string } | undefined;
        // Holder, else main's registry read (§5f verification reader).
        const localKey = verificationKeyFor(
          moteDb.db,
          verified.receipt.motebit_id,
          regRow?.public_key,
        );
        if (localKey !== null) {
          pubKeyHex = localKey;
          keySource = "local_registry";
        } else {
          const devices = await identityManager.listDevices(
            asMotebitId(verified.receipt.motebit_id),
          );
          const device = devices.find((d) => d.public_key);
          if (device?.public_key) {
            pubKeyHex = device.public_key;
            keySource = "local_device";
          }
        }
        // Fallback: the executor relay forwards the worker's key (the worker is
        // registered THERE, not here). This closes federation.receipt_key_missing
        // for cross-relay results — the origin can now verify the worker's inner
        // receipt instead of trusting only the peer-envelope signature.
        if (!pubKeyHex && verified.agentPublicKey) {
          pubKeyHex = verified.agentPublicKey;
          keySource = "peer_forwarded";
        }
        if (pubKeyHex) {
          const sigValid = await verifyExecutionReceipt(verified.receipt, hexToBytes(pubKeyHex));
          if (!sigValid) {
            logger.error("federation.receipt_signature_invalid", {
              correlationId: verified.taskId,
              executingAgent: verified.receipt.motebit_id,
              originRelay: verified.originRelay,
              keySource,
            });
            throw new HTTPException(403, {
              message: "Federated receipt signature verification failed",
            });
          }
          // Binding strength (identity-binding-verification.md ladder): for a
          // sovereign motebit_id the presented key MUST derive the id — proven
          // offline, no trust in the peer. Legacy/random ids can't be checked
          // this way; the signature is verified and we trust the peer envelope
          // for the key. Recorded for observability, never a gate (additive).
          const sovereignlyBound = await verifySovereignBinding(
            verified.receipt.motebit_id,
            pubKeyHex,
          );
          logger.info("federation.receipt_verified", {
            correlationId: verified.taskId,
            executingAgent: verified.receipt.motebit_id,
            keySource,
            bindingStrength: sovereignlyBound ? "sovereign" : "peer_attested",
          });
        } else {
          logger.warn("federation.receipt_key_missing", {
            correlationId: verified.taskId,
            executingAgent: verified.receipt.motebit_id,
          });
          // Unverifiable is not an answer (#890 r6): with no key to check
          // the executor's signature, the receipt could be anyone's.
          throw new HTTPException(403, {
            message: "Federated receipt could not be verified: no key for its signer",
          });
        }
      } else {
        throw new HTTPException(403, { message: "Federated receipt is unsigned" });
      }

      // Archive the verified receipt tree (#890 r6): the queue forgets the
      // task, and the delegator that holds its id learns how it ended from
      // the archive — which answers only a recorded executor's receipt.
      persistReceiptChain(moteDb.db, verified.receipt);

      // Update task
      entry.receipt = verified.receipt;
      entry.expiresAt = Math.max(entry.expiresAt, Date.now() + taskTtlMs);
      entry.task.status =
        verified.receipt.status === "completed"
          ? AgentTaskStatus.Completed
          : verified.receipt.status === "denied"
            ? AgentTaskStatus.Denied
            : AgentTaskStatus.Failed;
      // The durable queue hands out copies: without this write the poll never
      // saw a federated result (#890 r6 — the delegator's poll is its
      // fallback when the socket push is lost).
      taskQueue.set(verified.taskId, entry);

      // Fan out to submitter
      const submittedBy = entry.submitted_by ?? entry.task.submitted_by;
      if (submittedBy) {
        sendToEach(
          connections.get(submittedBy),
          JSON.stringify({
            type: "task_result",
            task_id: verified.taskId,
            receipt: verified.receipt,
          }),
        );
      }

      // Trust update via evaluateTrustTransition
      try {
        const peerRow = moteDb.db
          .prepare(
            "SELECT trust_level, successful_forwards, failed_forwards FROM relay_peers WHERE peer_relay_id = ?",
          )
          .get(verified.originRelay) as
          | { trust_level: AgentTrustLevel; successful_forwards: number; failed_forwards: number }
          | undefined;

        if (peerRow) {
          const isSuccess = verified.receipt.status === "completed";
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
              receipt_hash: verified.receipt.result_hash ?? "",
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
          moteDb.db
            .prepare(
              `INSERT OR IGNORE INTO relay_settlements
               (settlement_id, allocation_id, task_id, motebit_id, receipt_hash,
                amount_settled, platform_fee, platform_fee_rate, status, settled_at,
                settlement_mode, p2p_tx_hash, payment_verification_status, delegator_id,
                p2p_worker_leg, p2p_worker_address, p2p_worker_address_rung, issuer_relay_id, suite, signature, record_json)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              settlementId,
              `p2p-${verified.taskId}`,
              verified.taskId,
              workerId,
              verified.receipt.result_hash ?? "",
              proof.amount_micro,
              originFee,
              platformFeeRate,
              "completed",
              settledAt,
              "p2p",
              p2pProofKey(proof.tx_hash),
              "pending",
              entry.submitted_by ?? null,
              // The origin relay verifies only its own fee leg; the worker leg
              // is the executor relay's (the worker is hosted there).
              p2pWorkerLegScope(entry),
              entry.p2p_admission?.worker_address ?? null,
              entry.p2p_admission?.worker_address_rung ?? null,
              signed.issuer_relay_id,
              signed.suite,
              signed.signature,
              canonicalJson(signed),
            );
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
        }
        return;
      }

      // Settlement forwarding
      try {
        if (entry.price_snapshot != null && entry.price_snapshot > 0) {
          const grossAmount = entry.price_snapshot;
          const feeAmount = Math.round(grossAmount * platformFeeRate);
          const netAmount = grossAmount - feeAmount;
          const receiptHash = verified.receipt.result_hash ?? verified.receipt.signature ?? "";
          const settlementId = crypto.randomUUID();
          const settledAt = Date.now();

          // Mint + sign the canonical FederationSettlementRecord (§9.1
          // verbatim-leaf convergence): the relay signs its own copy of this
          // settlement; the persisted `record_json` is the exact bytes the
          // anchor leaf hashes, so a peer holding the record reproduces the leaf
          // with `verifyFederationSettlementAnchor`. The `settledAt` value here
          // is the SAME one written to the row's `settled_at` column, so the
          // anchor's reconstruction order and the record agree.
          const signedRecord = await signFederationSettlement(
            {
              settlement_id: settlementId,
              task_id: verified.taskId,
              upstream_relay_id: relayIdentity.relayMotebitId,
              downstream_relay_id: verified.originRelay,
              agent_id: null,
              gross_amount: grossAmount,
              fee_amount: feeAmount,
              net_amount: netAmount,
              fee_rate: platformFeeRate,
              receipt_hash: receiptHash,
              settled_at: settledAt,
              ...(entry.x402_tx_hash != null ? { x402_tx_hash: entry.x402_tx_hash } : {}),
              ...(entry.x402_network != null ? { x402_network: entry.x402_network } : {}),
              issuer_relay_id: relayIdentity.relayMotebitId,
            },
            relayIdentity.privateKey,
          );

          moteDb.db
            .prepare(
              `INSERT OR IGNORE INTO relay_federation_settlements (settlement_id, task_id, upstream_relay_id, downstream_relay_id, agent_id, gross_amount, fee_amount, net_amount, fee_rate, settled_at, receipt_hash, x402_tx_hash, x402_network, record_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              settlementId,
              verified.taskId,
              relayIdentity.relayMotebitId,
              verified.originRelay,
              null,
              grossAmount,
              feeAmount,
              netAmount,
              platformFeeRate,
              settledAt,
              receiptHash,
              entry.x402_tx_hash ?? null,
              entry.x402_network ?? null,
              // Rule 11 analogue: store the exact canonical signed bytes. The
              // anchor leaf is SHA-256 of THIS, so it equals the peer's bytes.
              canonicalJson(signedRecord),
            );

          const peerInfo = moteDb.db
            .prepare("SELECT endpoint_url FROM relay_peers WHERE peer_relay_id = ?")
            .get(verified.originRelay) as { endpoint_url: string } | undefined;
          if (peerInfo) {
            const settlementBody = {
              task_id: verified.taskId,
              settlement_id: settlementId,
              origin_relay: relayIdentity.relayMotebitId,
              gross_amount: netAmount,
              receipt_hash: receiptHash,
              timestamp: Date.now(),
              x402_tx_hash: entry.x402_tx_hash ?? undefined,
              x402_network: entry.x402_network ?? undefined,
            };
            const settlementSig = await sign(
              new TextEncoder().encode(canonicalJson(settlementBody)),
              relayIdentity.privateKey,
            );
            try {
              const resp = await fetch(
                `${peerInfo.endpoint_url}/federation/v1/settlement/forward`,
                {
                  method: "POST",
                  headers: {
                    "Content-Type": "application/json",
                    "X-Correlation-ID": verified.taskId,
                  },
                  body: JSON.stringify({ ...settlementBody, signature: bytesToHex(settlementSig) }),
                  signal: AbortSignal.timeout(10000),
                },
              );
              if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            } catch {
              // Settlement forward failed — queue for retry with exponential backoff.
              // First retry at baseDelayMs (5s) per DEFAULT_RETRY_POLICY.
              moteDb.db
                .prepare(
                  `INSERT INTO relay_settlement_retries (retry_id, settlement_id, task_id, peer_relay_id, payload_json, attempts, max_attempts, next_retry_at, status, created_at) VALUES (?, ?, ?, ?, ?, 0, 8, ?, 'pending', ?)`,
                )
                .run(
                  crypto.randomUUID(),
                  settlementId,
                  verified.taskId,
                  verified.originRelay,
                  JSON.stringify(settlementBody),
                  Date.now() + 5_000,
                  Date.now(),
                );
            }
          }
        }
      } catch {
        /* best-effort settlement */
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
      const workerEntry = taskQueue.get(verified.taskId);
      const workerId = workerEntry?.task.motebit_id ?? null;

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
      moteDb.db.exec("BEGIN");
      try {
        const ins = moteDb.db
          .prepare(
            `INSERT OR IGNORE INTO relay_federation_settlements (settlement_id, task_id, upstream_relay_id, downstream_relay_id, agent_id, gross_amount, fee_amount, net_amount, fee_rate, settled_at, receipt_hash, x402_tx_hash, x402_network, record_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            verified.settlementId,
            verified.taskId,
            verified.originRelay,
            null,
            workerId,
            verified.grossAmount,
            feeAmount,
            netAmount,
            platformFeeRate,
            settledAt,
            verified.receiptHash,
            verified.x402TxHash ?? null,
            verified.x402Network ?? null,
            canonicalJson(signedRecord),
          );

        if (ins.changes > 0 && workerId != null && netAmount > 0) {
          creditAccount(
            moteDb.db,
            workerId,
            netAmount,
            "settlement_credit",
            verified.settlementId,
            `Federated settlement for task ${verified.taskId}`,
          );
        }
        moteDb.db.exec("COMMIT");
      } catch (settlementErr) {
        moteDb.db.exec("ROLLBACK");
        throw settlementErr;
      }
      return { feeAmount, netAmount };
    },
  };
}
