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
  canonicalJson,
  bytesToHex,
  hexToBytes,
} from "@motebit/encryption";
/* eslint-enable no-restricted-imports */
import { getRelayKeypair } from "./credentials.js";
import type { RelayIdentity } from "./federation.js";
import type { TaskQueueEntry } from "./tasks.js";
import type { ConnectedDevice } from "./index.js";
import { createLogger } from "./logger.js";

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

      taskQueue.set(verified.taskId, {
        task,
        expiresAt: Date.now() + taskTtlMs,
        submitted_by: task.submitted_by,
        origin_relay: verified.originRelay,
      });

      const agentPeers = connections.get(verified.targetAgent);
      if (agentPeers && agentPeers.length > 0) {
        const payload = JSON.stringify({ type: "task_request", task });
        for (const p of agentPeers) p.ws.send(payload);
        return { status: "routed" as const };
      }
      return { status: "pending" as const };
    },

    async onTaskResultReceived(verified: {
      taskId: string;
      originRelay: string;
      receipt: import("@motebit/sdk").ExecutionReceipt;
    }) {
      const entry = taskQueue.get(verified.taskId);
      if (!entry) throw new HTTPException(404, { message: "Task not found or expired" });

      // Verify executing agent's Ed25519 receipt signature (sibling of direct receipt path).
      // Without this, a malicious peer relay could forge or tamper with receipts.
      if (verified.receipt.signature) {
        let pubKeyHex: string | undefined;
        const regRow = moteDb.db
          .prepare("SELECT public_key FROM agent_registry WHERE motebit_id = ?")
          .get(verified.receipt.motebit_id) as { public_key: string } | undefined;
        if (regRow?.public_key) {
          pubKeyHex = regRow.public_key;
        } else {
          const devices = await identityManager.listDevices(
            asMotebitId(verified.receipt.motebit_id),
          );
          const device = devices.find((d) => d.public_key);
          if (device?.public_key) pubKeyHex = device.public_key;
        }
        if (pubKeyHex) {
          const sigValid = await verifyExecutionReceipt(verified.receipt, hexToBytes(pubKeyHex));
          if (!sigValid) {
            logger.error("federation.receipt_signature_invalid", {
              correlationId: verified.taskId,
              executingAgent: verified.receipt.motebit_id,
              originRelay: verified.originRelay,
            });
            throw new HTTPException(403, {
              message: "Federated receipt signature verification failed",
            });
          }
        } else {
          logger.warn("federation.receipt_key_missing", {
            correlationId: verified.taskId,
            executingAgent: verified.receipt.motebit_id,
          });
        }
      }

      // Update task
      entry.receipt = verified.receipt;
      entry.expiresAt = Math.max(entry.expiresAt, Date.now() + taskTtlMs);
      entry.task.status =
        verified.receipt.status === "completed"
          ? AgentTaskStatus.Completed
          : verified.receipt.status === "denied"
            ? AgentTaskStatus.Denied
            : AgentTaskStatus.Failed;

      // Fan out to submitter
      const submittedBy = entry.submitted_by ?? entry.task.submitted_by;
      if (submittedBy) {
        const peers = connections.get(submittedBy);
        if (peers) {
          const msg = JSON.stringify({
            type: "task_result",
            task_id: verified.taskId,
            receipt: verified.receipt,
          });
          for (const p of peers) p.ws.send(msg);
        }
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

      // Settlement forwarding
      try {
        if (entry.price_snapshot != null && entry.price_snapshot > 0) {
          const grossAmount = entry.price_snapshot;
          const feeAmount = Math.round(grossAmount * platformFeeRate);
          const netAmount = grossAmount - feeAmount;
          const receiptHash = verified.receipt.result_hash ?? verified.receipt.signature ?? "";
          const settlementId = crypto.randomUUID();

          moteDb.db
            .prepare(
              `INSERT OR IGNORE INTO relay_federation_settlements (settlement_id, task_id, upstream_relay_id, downstream_relay_id, agent_id, gross_amount, fee_amount, net_amount, fee_rate, settled_at, receipt_hash, x402_tx_hash, x402_network) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
              Date.now(),
              receiptHash,
              entry.x402_tx_hash ?? null,
              entry.x402_network ?? null,
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

    onSettlementReceived(verified: {
      taskId: string;
      settlementId: string;
      originRelay: string;
      grossAmount: number;
      receiptHash: string;
      x402TxHash?: string;
      x402Network?: string;
    }) {
      const feeAmount = Math.round(verified.grossAmount * platformFeeRate);
      const netAmount = verified.grossAmount - feeAmount;
      moteDb.db
        .prepare(
          `INSERT OR IGNORE INTO relay_federation_settlements (settlement_id, task_id, upstream_relay_id, downstream_relay_id, agent_id, gross_amount, fee_amount, net_amount, fee_rate, settled_at, receipt_hash, x402_tx_hash, x402_network) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          verified.settlementId,
          verified.taskId,
          verified.originRelay,
          null,
          null,
          verified.grossAmount,
          feeAmount,
          netAmount,
          platformFeeRate,
          Date.now(),
          verified.receiptHash,
          verified.x402TxHash ?? null,
          verified.x402Network ?? null,
        );
      return { feeAmount, netAmount };
    },
  };
}
