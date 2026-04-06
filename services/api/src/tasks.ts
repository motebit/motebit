/**
 * Task submission, polling, receipt ingestion, and settlement routes.
 *
 * handleReceiptIngestion is the unified receipt pipeline (~760 lines).
 * All three call sites (HTTP result POST, MCP forward callback, HTTP MCP
 * fallback callback) live within registerTaskRoutes. Exported in case
 * future refactoring moves the WebSocket or federation receipt paths here.
 */

import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { MotebitDatabase } from "@motebit/persistence";
import type { IdentityManager } from "@motebit/core-identity";
import type { EventStore } from "@motebit/event-log";
import {
  AgentTaskStatus,
  asMotebitId,
  asAllocationId,
  asSettlementId,
  asGoalId,
  PLATFORM_FEE_RATE as DEFAULT_PLATFORM_FEE_RATE,
  AgentTrustLevel,
  EventType,
} from "@motebit/sdk";
import { evaluateTrustTransition, trustLevelToScore } from "@motebit/market";
import type {
  ExecutionReceipt,
  AgentTask,
  CapabilityPrice,
  BudgetAllocation,
  AgentTrustRecord,
} from "@motebit/sdk";
/* eslint-disable no-restricted-imports -- Relay service generates its own keypair (not a user surface) */
import {
  verifyExecutionReceipt,
  hexPublicKeyToDidKey,
  issueReputationCredential,
  sign,
  canonicalJson,
  bytesToHex,
  hexToBytes,
} from "@motebit/crypto";
/* eslint-enable no-restricted-imports */
import {
  explainedRankCandidates,
  settleOnReceipt,
  allocateBudget,
  computeGrossAmount,
  weightedSumComposite,
  lexicographicComposite,
} from "@motebit/market";
import type { CandidateProfile, CompositeFunction } from "@motebit/market";
import { getAccountBalance, creditAccount, debitAccount, toMicro } from "./accounts.js";
import { attemptPushWake } from "./push-adapter.js";
import { getRelayKeypair } from "./credentials.js";
import type { RelayIdentity } from "./federation.js";
import { forwardTaskViaMcp, type ReceiptCandidate } from "./task-routing.js";
import type { TaskRouter } from "./task-routing.js";
import type { ConnectedDevice } from "./index.js";
import { checkIdempotency, completeIdempotency } from "./idempotency.js";
import { createLogger } from "./logger.js";
import {
  RelayError,
  AuthenticationError,
  AuthorizationError,
  InsufficientFundsError,
  SettlementError,
  AllocationError,
  TaskError,
} from "./errors.js";

const logger = createLogger({ service: "tasks" });

// --- Constants ---
const TASK_TTL_MS = 10 * 60 * 1000; // 10 minutes
const MAX_TASK_QUEUE_SIZE = 100_000; // Hard cap prevents memory exhaustion

/** Shape of each entry in the in-memory task queue. */
export type TaskQueueEntry = {
  task: AgentTask;
  receipt?: ExecutionReceipt;
  expiresAt: number;
  submitted_by?: string;
  /** Gross amount x402 charged at submission time (from listing price). */
  price_snapshot?: number;
  /** x402 on-chain transaction hash captured from the payment settlement. */
  x402_tx_hash?: string;
  /** x402 network (CAIP-2) captured from the payment settlement. */
  x402_network?: string;
  /** When set, this task was forwarded from a peer relay and the result should be returned there. */
  origin_relay?: string;
  /** Set to true after receipt settlement completes — prevents double-settlement. */
  settled?: boolean;
};

/**
 * Platform fee rate — configurable per-relay deployment.
 * Defaults to SDK constant (0.05 / 5%). Set by registerTaskRoutes from config.
 * The protocol supports any fee structure; this is the reference deployment setting.
 */
let PLATFORM_FEE_RATE = DEFAULT_PLATFORM_FEE_RATE;

export interface TasksDeps {
  app: Hono;
  moteDb: MotebitDatabase;
  identityManager: IdentityManager;
  eventStore: EventStore;
  relayIdentity: RelayIdentity;
  connections: Map<string, ConnectedDevice[]>;
  taskQueue: Map<string, TaskQueueEntry>;
  taskRouter: TaskRouter;
  issueCredentials: boolean;
  apiToken?: string;
  enableDeviceAuth: boolean;
  maxTasksPerSubmitter: number;
  x402Config: {
    payToAddress: string;
    network: string;
    facilitatorUrl?: string;
    testnet?: boolean;
  };
  /** Auth helpers from relay auth layer */
  parseTokenPayloadUnsafe: (token: string) => import("./auth.js").TokenPayload | null;
  verifySignedTokenForDevice: (
    token: string,
    motebitId: string,
    identityManager: IdentityManager,
    expectedAudience: string,
    blacklistCheck?: (jti: string, motebitId: string) => boolean,
    agentRevokedCheck?: (motebitId: string) => boolean,
  ) => Promise<boolean>;
  isTokenBlacklisted: (jti: string, motebitId: string) => boolean;
  isAgentRevoked: (motebitId: string) => boolean;
  /** Platform fee rate (0–1). Defaults to SDK constant (0.05) if not provided. */
  platformFeeRate?: number;
  /** Settlement rail registry — for attaching payment proofs through the rail boundary. */
  railRegistry?: import("./settlement-rails/index.js").SettlementRailRegistry;
  /** Push adapter for waking offline mobile devices. */
  pushAdapter?: import("./push-adapter.js").PushAdapter;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function extractMotebitIdFromPath(path: string): string | null {
  const match = path.match(/\/agent\/([^/]+)\/task/);
  return match ? match[1]! : null;
}

function getListingUnitCost(moteDb: MotebitDatabase, agentId: string): number {
  const row = moteDb.db
    .prepare(
      "SELECT pricing FROM relay_service_listings WHERE motebit_id = ? ORDER BY updated_at DESC LIMIT 1",
    )
    .get(agentId) as { pricing: string } | undefined;
  if (!row) return 0;
  try {
    const pricing = JSON.parse(row.pricing) as CapabilityPrice[];
    return pricing.reduce((sum, p) => sum + (p.unit_cost ?? 0), 0);
  } catch {
    return 0;
  }
}

function getAgentPricing(
  moteDb: MotebitDatabase,
  agentId: string,
): { unitCost: number; payTo: string } | null {
  const row = moteDb.db
    .prepare(
      "SELECT pricing, pay_to_address FROM relay_service_listings WHERE motebit_id = ? ORDER BY updated_at DESC LIMIT 1",
    )
    .get(agentId) as { pricing: string; pay_to_address: string | null } | undefined;
  if (!row || !row.pay_to_address) return null;
  try {
    const pricing = JSON.parse(row.pricing) as CapabilityPrice[];
    const totalCost = pricing.reduce((sum, p) => sum + (p.unit_cost ?? 0), 0);
    if (totalCost <= 0) return null;
    return { unitCost: totalCost, payTo: row.pay_to_address };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Unified receipt ingestion pipeline
// ---------------------------------------------------------------------------
// ALL receipts — regardless of transport (HTTP POST, MCP forward, WebSocket,
// federation) — flow through this single function. It handles:
//   1. Idempotency (DB settlement check + in-memory settled flag)
//   2. Ed25519 signature verification
//   3. Trust record update (evaluateTrustTransition)
//   4. Delegation edge caching (multi-hop routing intelligence)
//   5. Multi-hop settlement (nested delegation_receipts)
//   6. Latency recording
//   7. Main settlement (settleOnReceipt) + virtual account credits
//   8. Credential issuance (AgentReputationCredential)
//   9. WebSocket fan-out
//  10. Federation result forwarding
//
// Returns { verified: true } on success, { verified: false, reason } on failure.
// Callers decide how to surface the failure (HTTP 403, log warning, etc.).
export async function handleReceiptIngestion(
  receipt: ExecutionReceipt,
  taskId: string,
  motebitId: string,
  entry: TaskQueueEntry,
  deps: {
    moteDb: MotebitDatabase;
    identityManager: IdentityManager;
    eventStore: EventStore;
    relayIdentity: RelayIdentity;
    connections: Map<string, ConnectedDevice[]>;
    taskQueue: Map<string, TaskQueueEntry>;
    issueCredentials: boolean;
    /** Maximum delegation chain depth for multi-hop settlement. Default: 10. */
    maxSettlementDepth?: number;
  },
): Promise<
  | { verified: true; credential_id: string | null; already_settled?: boolean }
  | { verified: false; reason: string }
> {
  const {
    moteDb,
    identityManager,
    eventStore,
    relayIdentity,
    connections,
    taskQueue,
    issueCredentials,
  } = deps;

  // --- Idempotency: settled flag (persisted in durable queue) ---
  if (entry.settled) {
    logger.info("settlement.already_settled", { correlationId: taskId });
    return { verified: true, credential_id: null, already_settled: true };
  }

  // --- Ed25519 verification ---
  let pubKeyHex: string | undefined;
  const regRow = moteDb.db
    .prepare("SELECT public_key FROM agent_registry WHERE motebit_id = ?")
    .get(receipt.motebit_id) as { public_key: string } | undefined;
  if (regRow?.public_key) {
    pubKeyHex = regRow.public_key;
  } else {
    const devices = await identityManager.listDevices(asMotebitId(receipt.motebit_id as string));
    const device =
      (receipt.device_id != null
        ? devices.find((d) => d.device_id === receipt.device_id)
        : undefined) ?? devices.find((d) => d.public_key);
    if (device?.public_key) {
      pubKeyHex = device.public_key;
    }
  }

  if (!pubKeyHex) {
    const executingId = receipt.motebit_id as string;
    logger.error("receipt.verification_failed", {
      correlationId: taskId,
      executingAgentId: executingId,
      reason: "no public key found for executing agent",
    });
    return { verified: false, reason: `no public key on file for agent ${executingId}` };
  }

  let receiptValid = await verifyExecutionReceipt(receipt, hexToBytes(pubKeyHex));

  // Fallback: try the public key embedded in the receipt itself.
  if (
    !receiptValid &&
    receipt.public_key &&
    typeof receipt.public_key === "string" &&
    receipt.public_key !== pubKeyHex
  ) {
    receiptValid = await verifyExecutionReceipt(receipt, hexToBytes(receipt.public_key));
    if (receiptValid) {
      moteDb.db
        .prepare("UPDATE agent_registry SET public_key = ? WHERE motebit_id = ?")
        .run(receipt.public_key, receipt.motebit_id);
      logger.info("receipt.public_key_updated", {
        correlationId: taskId,
        motebitId: receipt.motebit_id,
        reason: "embedded key verified, registry updated",
      });
    }
  }

  if (!receiptValid) {
    logger.error("receipt.verification_failed", {
      correlationId: taskId,
      reason: "invalid Ed25519 signature",
    });
    return { verified: false, reason: "invalid Ed25519 signature" };
  }

  logger.info("receipt.verified", {
    correlationId: taskId,
    status: receipt.status,
    motebitId: receipt.motebit_id as string,
  });

  // --- Idempotency: DB settlement check ---
  const existingSettlement = moteDb.db
    .prepare("SELECT settlement_id FROM relay_settlements WHERE task_id = ? AND motebit_id = ?")
    .get(taskId, motebitId) as { settlement_id: string } | undefined;
  if (existingSettlement) {
    entry.settled = true;
    taskQueue.set(taskId, entry); // Persist settled flag to durable queue
    logger.info("settlement.duplicate", { correlationId: taskId });
    return { verified: true, credential_id: null, already_settled: true };
  }

  // --- Trust record update ---
  const taskSubmitter = entry.submitted_by ?? entry.task.submitted_by;
  const isSelfDelegation =
    taskSubmitter != null && taskSubmitter === (receipt.motebit_id as string);
  if (isSelfDelegation) {
    logger.info("trust.self_delegation_skipped", {
      correlationId: taskId,
      motebitId,
      reason: "submitter === executor — no trust signal or credential issued",
    });
  }
  if (!isSelfDelegation) {
    try {
      const executingAgentId = receipt.motebit_id as string;
      const taskSucceeded = receipt.status === "completed";
      const taskFailed = receipt.status === "failed";
      const now = Date.now();

      // Quality gate: reclassify low-quality completions as failures
      let resultQuality = 1.0;
      if (taskSucceeded) {
        const resultStr = typeof receipt.result === "string" ? receipt.result : "";
        const lengthScore = Math.min(resultStr.length, 500) / 500;
        const toolScore = Math.min(receipt.tools_used?.length ?? 0, 3) / 3;
        const latencyMs = (receipt.completed_at ?? 0) - (receipt.submitted_at ?? 0);
        const latencyScore = latencyMs > 0 ? Math.min(Math.max(latencyMs, 500), 5000) / 5000 : 0.5;
        resultQuality = 0.6 * lengthScore + 0.3 * toolScore + 0.1 * latencyScore;
      }
      const effectiveSuccess = taskSucceeded && resultQuality >= 0.2;
      const effectiveFailure = taskFailed || (taskSucceeded && resultQuality < 0.2);

      const existing = await moteDb.agentTrustStore.getAgentTrust(motebitId, executingAgentId);

      if (existing) {
        const alpha = 0.3;
        const prevQuality = existing.avg_quality ?? 1.0;
        const newQuality = alpha * resultQuality + (1 - alpha) * prevQuality;

        const updated: AgentTrustRecord = {
          ...existing,
          last_seen_at: now,
          interaction_count: existing.interaction_count + 1,
          successful_tasks: (existing.successful_tasks ?? 0) + (effectiveSuccess ? 1 : 0),
          failed_tasks: (existing.failed_tasks ?? 0) + (effectiveFailure ? 1 : 0),
          avg_quality: newQuality,
          quality_sample_count: (existing.quality_sample_count ?? 0) + 1,
        };
        const newLevel = evaluateTrustTransition(updated);
        if (newLevel != null) {
          const previousLevel = existing.trust_level;
          updated.trust_level = newLevel;
          try {
            const clock = await eventStore.getLatestClock(asMotebitId(motebitId));
            await eventStore.append({
              event_id: crypto.randomUUID(),
              motebit_id: asMotebitId(motebitId),
              timestamp: now,
              event_type: EventType.TrustLevelChanged,
              payload: {
                remote_motebit_id: executingAgentId,
                previous_level: previousLevel,
                new_level: newLevel,
                successful_tasks: updated.successful_tasks,
                failed_tasks: updated.failed_tasks,
                source: "relay_receipt_verification",
              },
              version_clock: clock + 1,
              tombstoned: false,
            });
          } catch {
            // Event emission is best-effort
          }
        }
        await moteDb.agentTrustStore.setAgentTrust(updated);
      } else {
        await moteDb.agentTrustStore.setAgentTrust({
          motebit_id: asMotebitId(motebitId),
          remote_motebit_id: asMotebitId(executingAgentId),
          trust_level: AgentTrustLevel.FirstContact,
          first_seen_at: now,
          last_seen_at: now,
          interaction_count: 1,
          successful_tasks: effectiveSuccess ? 1 : 0,
          failed_tasks: effectiveFailure ? 1 : 0,
          avg_quality: resultQuality,
          quality_sample_count: 1,
        });
      }
    } catch {
      // Trust update is best-effort — don't block receipt delivery
    }
  }

  // --- Delegation edge caching ---
  if (receipt.delegation_receipts && receipt.delegation_receipts.length > 0) {
    try {
      const insertEdge = moteDb.db.prepare(
        `INSERT INTO relay_delegation_edges
         (from_motebit_id, to_motebit_id, trust, cost, latency_ms, reliability, regulatory_risk, recorded_at, receipt_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );

      const walkReceipts = async (
        parentMotebitId: string,
        receipts: ExecutionReceipt[],
      ): Promise<void> => {
        for (const sub of receipts) {
          if (sub.signature) {
            let subPubKey: string | undefined;
            const subReg = moteDb.db
              .prepare("SELECT public_key FROM agent_registry WHERE motebit_id = ?")
              .get(sub.motebit_id) as { public_key: string } | undefined;
            if (subReg?.public_key) {
              subPubKey = subReg.public_key;
            } else {
              const subDevices = await identityManager.listDevices(asMotebitId(sub.motebit_id));
              subPubKey = subDevices.find((d) => d.public_key)?.public_key;
            }
            if (subPubKey) {
              const subValid = await verifyExecutionReceipt(sub, hexToBytes(subPubKey));
              if (!subValid) {
                logger.warn("delegation_receipt.signature_invalid", {
                  correlationId: taskId,
                  parentAgent: parentMotebitId,
                  delegatedAgent: sub.motebit_id,
                });
                continue;
              }
            }
          }

          const latency =
            sub.completed_at && sub.submitted_at ? sub.completed_at - sub.submitted_at : 5000;
          const reliability = sub.status === "completed" ? 0.9 : 0.3;
          const trustRow = moteDb.db
            .prepare(
              "SELECT trust_level FROM agent_trust WHERE motebit_id = ? AND remote_motebit_id = ?",
            )
            .get(motebitId, sub.motebit_id) as { trust_level: string } | undefined;
          const trust = trustRow ? trustLevelToScore(trustRow.trust_level as AgentTrustLevel) : 0.1;

          insertEdge.run(
            parentMotebitId,
            sub.motebit_id,
            trust,
            0,
            latency > 0 ? latency : 5000,
            reliability,
            0,
            Date.now(),
            sub.result_hash ?? null,
          );

          if (sub.delegation_receipts && sub.delegation_receipts.length > 0) {
            await walkReceipts(sub.motebit_id as string, sub.delegation_receipts);
          }
        }
      };

      await walkReceipts(receipt.motebit_id as string, receipt.delegation_receipts);
    } catch {
      // Best-effort edge caching
    }
  }

  // --- Multi-hop settlement (recursive) ---
  const delegationReceipts = receipt.delegation_receipts ?? [];
  if (delegationReceipts.length > 0) {
    const MAX_SETTLEMENT_DEPTH = deps.maxSettlementDepth ?? 10;

    const settleSubReceipt = async (
      sub: ExecutionReceipt,
      parentTaskId: string,
      depth: number,
    ): Promise<void> => {
      if (depth > MAX_SETTLEMENT_DEPTH) {
        const subRelayTaskId = (sub as unknown as Record<string, unknown>).relay_task_id;
        logger.error("multihop.settlement.depth_limit_exceeded", {
          correlationId: parentTaskId,
          subAgent: sub.motebit_id,
          subTaskId: typeof subRelayTaskId === "string" ? subRelayTaskId : null,
          depth,
          maxDepth: MAX_SETTLEMENT_DEPTH,
          reason: "depth_limit_exceeded",
          action: "unsettled — agent will not be paid for this sub-delegation",
        });
        return;
      }

      const subRelayTaskId = (sub as unknown as Record<string, unknown>).relay_task_id;
      if (typeof subRelayTaskId !== "string" || subRelayTaskId === "") return;

      try {
        const subEntry = taskQueue.get(subRelayTaskId);
        if (!subEntry) {
          logger.warn("multihop.settlement.task_not_found", {
            correlationId: parentTaskId,
            subTaskId: subRelayTaskId,
            subAgent: sub.motebit_id,
          });
          return;
        }

        let subPubKey: string | undefined;
        const subReg = moteDb.db
          .prepare("SELECT public_key FROM agent_registry WHERE motebit_id = ?")
          .get(sub.motebit_id) as { public_key: string } | undefined;
        if (subReg?.public_key) subPubKey = subReg.public_key;
        else {
          const subDevices = await identityManager.listDevices(asMotebitId(sub.motebit_id));
          subPubKey = subDevices.find((d) => d.public_key)?.public_key;
        }
        if (!subPubKey) return;

        const subValid = await verifyExecutionReceipt(sub, hexToBytes(subPubKey));
        if (!subValid) {
          logger.warn("multihop.settlement.sig_invalid", {
            correlationId: parentTaskId,
            subTaskId: subRelayTaskId,
            subAgent: sub.motebit_id,
          });
          return;
        }

        const subExisting = moteDb.db
          .prepare(
            "SELECT settlement_id FROM relay_settlements WHERE task_id = ? AND motebit_id = ?",
          )
          .get(subRelayTaskId, sub.motebit_id) as { settlement_id: string } | undefined;
        if (subExisting) {
          // Already settled at this level — still recurse into nested receipts
          const nestedReceipts = sub.delegation_receipts ?? [];
          for (const nested of nestedReceipts) {
            await settleSubReceipt(nested, parentTaskId, depth + 1);
          }
          return;
        }

        const subUnitCost = getListingUnitCost(moteDb, sub.motebit_id as string);
        const subGross =
          subEntry.price_snapshot ??
          (subUnitCost > 0 ? toMicro(computeGrossAmount(subUnitCost, PLATFORM_FEE_RATE)) : 0);
        if (subGross <= 0) {
          // No cost — still recurse into nested receipts
          const nestedReceipts = sub.delegation_receipts ?? [];
          for (const nested of nestedReceipts) {
            await settleSubReceipt(nested, parentTaskId, depth + 1);
          }
          return;
        }

        const subSettlementId = asSettlementId(crypto.randomUUID());
        const subAllocationId = asAllocationId(`x402-${subRelayTaskId}`);
        const subAllocation: BudgetAllocation = {
          allocation_id: subAllocationId,
          goal_id: asGoalId(subRelayTaskId),
          candidate_motebit_id: sub.motebit_id,
          amount_locked: subGross,
          currency: "USDC",
          created_at: sub.submitted_at ?? Date.now(),
          status: "settled",
        };

        const subSettlement = settleOnReceipt(subAllocation, sub, null, subSettlementId);
        subSettlement.amount_settled = Math.round(subSettlement.amount_settled);
        subSettlement.platform_fee = Math.round(subSettlement.platform_fee);

        try {
          moteDb.db.exec("BEGIN");
          moteDb.db
            .prepare(
              `INSERT OR IGNORE INTO relay_settlements
             (settlement_id, allocation_id, task_id, motebit_id, receipt_hash, ledger_hash, amount_settled, platform_fee, platform_fee_rate, status, settled_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              subSettlement.settlement_id,
              subSettlement.allocation_id,
              subRelayTaskId,
              sub.motebit_id,
              subSettlement.receipt_hash,
              subSettlement.ledger_hash,
              subSettlement.amount_settled,
              subSettlement.platform_fee,
              subSettlement.platform_fee_rate,
              subSettlement.status,
              subSettlement.settled_at,
            );

          moteDb.db
            .prepare(
              "UPDATE relay_allocations SET status = 'settled', settled_at = ? WHERE task_id = ?",
            )
            .run(Date.now(), subRelayTaskId);

          if (subSettlement.amount_settled > 0) {
            creditAccount(
              moteDb.db,
              sub.motebit_id as string,
              subSettlement.amount_settled,
              "settlement_credit",
              subSettlement.settlement_id,
              `Payment for sub-delegated task ${subRelayTaskId}`,
            );
          }

          moteDb.db.exec("COMMIT");
          logger.info("multihop.settlement.created", {
            correlationId: parentTaskId,
            subTaskId: subRelayTaskId,
            subAgent: sub.motebit_id,
            net: subSettlement.amount_settled,
            fee: subSettlement.platform_fee,
            depth,
          });
        } catch (txnErr) {
          moteDb.db.exec("ROLLBACK");
          logger.warn("multihop.settlement.failed", {
            correlationId: parentTaskId,
            subTaskId: subRelayTaskId,
            error: txnErr instanceof Error ? txnErr.message : String(txnErr),
          });
        }
      } catch (subErr: unknown) {
        logger.warn("multihop.settlement.sub_error", {
          correlationId: parentTaskId,
          subRelayTaskId,
          error: subErr instanceof Error ? subErr.message : String(subErr),
        });
      }

      // Recurse into nested delegation_receipts
      const nestedReceipts = sub.delegation_receipts ?? [];
      for (const nested of nestedReceipts) {
        await settleSubReceipt(nested, parentTaskId, depth + 1);
      }
    };

    logger.info("multihop.settlement.start", {
      correlationId: taskId,
      count: delegationReceipts.length,
    });
    for (const sub of delegationReceipts) {
      await settleSubReceipt(sub, taskId, 1);
    }
  }

  // --- Latency recording ---
  if (receipt.completed_at && entry.task.submitted_at) {
    const elapsed = receipt.completed_at - entry.task.submitted_at;
    if (elapsed > 0 && receipt.motebit_id != null) {
      try {
        moteDb.db
          .prepare(
            `INSERT INTO relay_latency_stats (motebit_id, remote_motebit_id, latency_ms, recorded_at)
             VALUES (?, ?, ?, ?)`,
          )
          .run(motebitId, receipt.motebit_id, elapsed, Date.now());
      } catch {
        // Best-effort latency recording
      }
    }
  }

  // --- Main settlement + credential issuance ---
  let credential_id: string | null = null;
  {
    try {
      const persistentAlloc = moteDb.db
        .prepare("SELECT * FROM relay_allocations WHERE task_id = ? AND status = 'locked'")
        .get(taskId) as
        | { allocation_id: string; amount_locked: number; motebit_id: string }
        | undefined;

      const fallbackUnitCost = getListingUnitCost(moteDb, receipt.motebit_id as string);
      const grossAmount =
        entry.price_snapshot ??
        persistentAlloc?.amount_locked ??
        (fallbackUnitCost > 0
          ? toMicro(computeGrossAmount(fallbackUnitCost, PLATFORM_FEE_RATE))
          : 0);

      const settlementId = asSettlementId(crypto.randomUUID());
      const allocationId = persistentAlloc
        ? asAllocationId(persistentAlloc.allocation_id)
        : asAllocationId(`x402-${taskId}`);
      const allocation: BudgetAllocation = {
        allocation_id: allocationId,
        goal_id: asGoalId(taskId),
        candidate_motebit_id: receipt.motebit_id,
        amount_locked: grossAmount,
        currency: "USDC",
        created_at: receipt.submitted_at ?? Date.now(),
        status: "settled",
      };

      const settlement = settleOnReceipt(allocation, receipt, null, settlementId);
      // Round to integer micro-units for DB storage
      settlement.amount_settled = Math.round(settlement.amount_settled);
      settlement.platform_fee = Math.round(settlement.platform_fee);

      let credentialRow: {
        credential_id: string;
        subject: string;
        issuer: string;
        type: string;
        json: string;
        issued_at: number;
      } | null = null;

      if (issueCredentials && receipt.status === "completed" && !isSelfDelegation) {
        const latencyRows = moteDb.db
          .prepare(
            "SELECT latency_ms FROM relay_latency_stats WHERE remote_motebit_id = ? ORDER BY recorded_at DESC LIMIT 100",
          )
          .all(receipt.motebit_id as string) as Array<{ latency_ms: number }>;
        const avgLatency =
          latencyRows.length > 0
            ? latencyRows.reduce((a, r) => a + r.latency_ms, 0) / latencyRows.length
            : receipt.completed_at && receipt.submitted_at
              ? receipt.completed_at - receipt.submitted_at
              : 0;

        const subjectDid = pubKeyHex
          ? hexPublicKeyToDidKey(pubKeyHex)
          : `did:motebit:${receipt.motebit_id as string}`;

        const relayKeys = getRelayKeypair(relayIdentity);
        const vc = await issueReputationCredential(
          {
            success_rate: 1.0,
            avg_latency_ms: avgLatency,
            task_count: latencyRows.length + 1,
            trust_score: 1.0,
            availability: 1.0,
            measured_at: Date.now(),
          },
          relayKeys.privateKey,
          relayKeys.publicKey,
          subjectDid,
        );

        const credType =
          vc.type.find((t) => t !== "VerifiableCredential") ?? "VerifiableCredential";
        credentialRow = {
          credential_id: crypto.randomUUID(),
          subject: receipt.motebit_id as string,
          issuer: vc.issuer,
          type: credType,
          json: JSON.stringify(vc),
          issued_at: Date.now(),
        };
      }

      moteDb.db.exec("BEGIN");
      try {
        moteDb.db
          .prepare(
            `INSERT OR IGNORE INTO relay_settlements
             (settlement_id, allocation_id, task_id, motebit_id, receipt_hash, ledger_hash, amount_settled, platform_fee, platform_fee_rate, status, settled_at, x402_tx_hash, x402_network)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            settlement.settlement_id,
            settlement.allocation_id,
            taskId,
            motebitId,
            settlement.receipt_hash,
            settlement.ledger_hash,
            settlement.amount_settled,
            settlement.platform_fee,
            settlement.platform_fee_rate,
            settlement.status,
            settlement.settled_at,
            entry.x402_tx_hash ?? null,
            entry.x402_network ?? null,
          );

        if (persistentAlloc) {
          moteDb.db
            .prepare(
              "UPDATE relay_allocations SET status = 'settled', settled_at = ? WHERE task_id = ?",
            )
            .run(Date.now(), taskId);
        }

        {
          const workerMotebitId = receipt.motebit_id as string;

          if (settlement.status === "refunded") {
            const delegatorId = entry.submitted_by ?? entry.task.submitted_by ?? motebitId;
            creditAccount(
              moteDb.db,
              delegatorId,
              settlement.amount_settled + settlement.platform_fee,
              "allocation_release",
              settlement.settlement_id,
              `Refund for task ${taskId} (${receipt.status})`,
            );
          } else {
            if (settlement.amount_settled > 0) {
              creditAccount(
                moteDb.db,
                workerMotebitId,
                settlement.amount_settled,
                "settlement_credit",
                settlement.settlement_id,
                `Payment for task ${taskId}`,
              );
            }

            if (settlement.status === "partial" && persistentAlloc) {
              const grossSettled = settlement.amount_settled + settlement.platform_fee;
              const remainder = persistentAlloc.amount_locked - grossSettled;
              if (remainder > 0) {
                const delegatorId = entry.submitted_by ?? entry.task.submitted_by ?? motebitId;
                creditAccount(
                  moteDb.db,
                  delegatorId,
                  remainder,
                  "allocation_release",
                  settlement.settlement_id,
                  `Partial release for task ${taskId}`,
                );
              }
            }
          }
        }

        if (credentialRow) {
          moteDb.db
            .prepare(
              `INSERT INTO relay_credentials (credential_id, subject_motebit_id, issuer_did, credential_type, credential_json, issued_at)
               VALUES (?, ?, ?, ?, ?, ?)`,
            )
            .run(
              credentialRow.credential_id,
              credentialRow.subject,
              credentialRow.issuer,
              credentialRow.type,
              credentialRow.json,
              credentialRow.issued_at,
            );
          credential_id = credentialRow.credential_id;
        }

        moteDb.db.exec("COMMIT");

        // Release surplus from risk buffer back to delegator
        if (persistentAlloc && persistentAlloc.amount_locked > grossAmount) {
          const surplus = persistentAlloc.amount_locked - grossAmount;
          const delegatorId = entry.submitted_by ?? entry.task.submitted_by ?? motebitId;
          try {
            creditAccount(
              moteDb.db,
              delegatorId,
              surplus,
              "allocation_release",
              settlement.settlement_id,
              `Risk buffer surplus release for task ${taskId}`,
            );
            logger.info("settlement.surplus_released", {
              correlationId: taskId,
              surplus,
              delegator: delegatorId,
            });
          } catch {
            // Best-effort surplus release — don't block receipt delivery
          }
        }

        logger.info("settlement.created", {
          correlationId: taskId,
          gross: settlement.amount_settled + settlement.platform_fee,
          fee: settlement.platform_fee,
          net: settlement.amount_settled,
          x402TxHash: entry.x402_tx_hash ?? null,
        });
        if (credentialRow) {
          logger.info("credential.issued", {
            correlationId: taskId,
            motebitId: credentialRow.subject,
            type: credentialRow.type,
          });
        }
      } catch (txnErr) {
        moteDb.db.exec("ROLLBACK");
        throw txnErr;
      }
    } catch (settlementErr) {
      logger.warn("settlement.failed", {
        correlationId: taskId,
        error: settlementErr instanceof Error ? settlementErr.message : String(settlementErr),
      });
      // Best-effort settlement — don't block receipt delivery on accounting errors
    }
  }

  // Mark settled and persist to durable queue
  entry.settled = true;
  taskQueue.set(taskId, entry);

  // --- WebSocket fan-out ---
  const peers = connections.get(motebitId);
  if (peers) {
    const payload = JSON.stringify({ type: "task_result", task_id: taskId, receipt });
    for (const peer of peers) {
      peer.ws.send(payload);
    }
  }

  // --- Federation result forwarding ---
  if (entry.origin_relay) {
    try {
      const originPeer = moteDb.db
        .prepare("SELECT endpoint_url, public_key FROM relay_peers WHERE peer_relay_id = ?")
        .get(entry.origin_relay) as { endpoint_url: string } | undefined;
      if (originPeer) {
        const resultBody = {
          task_id: taskId,
          origin_relay: relayIdentity.relayMotebitId,
          receipt,
          timestamp: Date.now(),
        };
        const resultBytes = new TextEncoder().encode(canonicalJson(resultBody));
        const resultSig = await sign(resultBytes, relayIdentity.privateKey);

        await fetch(`${originPeer.endpoint_url}/federation/v1/task/result`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Correlation-ID": taskId },
          body: JSON.stringify({ ...resultBody, signature: bytesToHex(resultSig) }),
          signal: AbortSignal.timeout(10000),
        });
      }
    } catch {
      // Best-effort federation result return — receipt is already stored locally
    }

    // Update trust for the originating relay
    try {
      const peerRow = moteDb.db
        .prepare(
          "SELECT trust_level, successful_forwards, failed_forwards FROM relay_peers WHERE peer_relay_id = ?",
        )
        .get(entry.origin_relay) as
        | { trust_level: string; successful_forwards: number; failed_forwards: number }
        | undefined;

      if (peerRow) {
        const isSuccess = receipt.status === "completed";
        const newSuccessful = peerRow.successful_forwards + (isSuccess ? 1 : 0);
        const newFailed = peerRow.failed_forwards + (isSuccess ? 0 : 1);

        const trustRecord: AgentTrustRecord = {
          motebit_id: asMotebitId(relayIdentity.relayMotebitId),
          remote_motebit_id: asMotebitId(entry.origin_relay),
          trust_level: peerRow.trust_level as AgentTrustLevel,
          first_seen_at: 0,
          last_seen_at: Date.now(),
          interaction_count: newSuccessful + newFailed,
          successful_tasks: newSuccessful,
          failed_tasks: newFailed,
        };

        const newLevel = evaluateTrustTransition(trustRecord);
        const trustLevel = newLevel ?? peerRow.trust_level;
        const trustScore = trustLevelToScore(trustLevel as AgentTrustLevel);

        moteDb.db
          .prepare(
            `UPDATE relay_peers SET
            successful_forwards = ?, failed_forwards = ?,
            trust_level = ?, trust_score = ?
            WHERE peer_relay_id = ?`,
          )
          .run(newSuccessful, newFailed, trustLevel, trustScore, entry.origin_relay);
      }
    } catch {
      // Best-effort trust update
    }
  }

  return { verified: true, credential_id };
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export async function registerTaskRoutes(deps: TasksDeps): Promise<void> {
  const {
    app,
    moteDb,
    identityManager,
    eventStore,
    relayIdentity,
    connections,
    taskQueue,
    taskRouter,
    issueCredentials,
    apiToken,
    enableDeviceAuth,
    maxTasksPerSubmitter,
    x402Config,
    parseTokenPayloadUnsafe,
    verifySignedTokenForDevice,
    isTokenBlacklisted,
    isAgentRevoked,
    pushAdapter,
  } = deps;

  // Apply configured fee rate (affects module-level PLATFORM_FEE_RATE used by handleReceiptIngestion)
  if (deps.platformFeeRate != null) {
    PLATFORM_FEE_RATE = deps.platformFeeRate;
  }

  const ingestionDeps = {
    moteDb,
    identityManager,
    eventStore,
    relayIdentity,
    connections,
    taskQueue,
    issueCredentials,
  };

  // Capture x402 settlement proof so the task handler can link it to the task queue entry.
  // Same single-threaded pattern as currentPricing — set by hook, read by handler, no interleaving.
  let lastSettleTxHash: string | undefined;
  let lastSettleNetwork: string | undefined;

  {
    const { paymentMiddlewareFromHTTPServer, x402HTTPResourceServer, x402ResourceServer } =
      await import("@x402/hono");
    const { ExactEvmScheme } = await import("@x402/evm/exact/server");
    const { HTTPFacilitatorClient } = await import("@x402/core/server");

    const facilitatorClient = new HTTPFacilitatorClient({
      url: x402Config.facilitatorUrl ?? "https://x402.org/facilitator",
    });

    const network = x402Config.network as `${string}:${string}`;
    const resourceServer = new x402ResourceServer(facilitatorClient).register(
      network,
      new ExactEvmScheme(),
    );

    resourceServer.onAfterSettle((ctx): Promise<void> => {
      lastSettleTxHash = ctx.result.transaction;
      lastSettleNetwork = ctx.result.network;
      return Promise.resolve();
    });

    // Single DB lookup per request. The wrapper sets currentPricing before
    // calling x402Gate; the price/payTo callbacks read it synchronously within
    // the same tick (x402 resolves route config before any await). Safe in
    // Node's single-threaded model — no interleaving between set and read.
    let currentPricing: { unitCost: number; payTo: string } | null = null;

    const x402Routes = {
      "POST /agent/*/task": {
        accepts: {
          scheme: "exact" as const,
          network,
          price: () => {
            if (!currentPricing) return "$0";
            const gross = computeGrossAmount(currentPricing.unitCost, PLATFORM_FEE_RATE);
            return `$${gross.toFixed(6)}`;
          },
          payTo: () => {
            return currentPricing?.payTo ?? x402Config.payToAddress;
          },
        },
        description: "Submit a task to a motebit agent",
        mimeType: "application/json",
        unpaidResponseBody: (ctx: { path: string }) => {
          const agentId = extractMotebitIdFromPath(ctx.path);
          return {
            contentType: "application/json",
            body: {
              error: "payment_required",
              message: "Task submission requires USDC payment via x402",
              agent: agentId,
              estimated_cost: currentPricing?.unitCost ?? 0,
              platform_fee_rate: PLATFORM_FEE_RATE,
              network: x402Config.network,
            },
          };
        },
      },
    };

    // Construct HTTP server ourselves so we control initialization lifecycle.
    // syncFacilitatorOnStart=false prevents an unhandled rejection when the
    // facilitator is unreachable (test env, cold start, network partition).
    // We fire initialization manually with .catch() so the promise rejection
    // is always handled. The x402 gate is fail-closed: if the facilitator
    // is unreachable, paid requests get 402 (correct behavior). Virtual
    // account bypass still works regardless.
    const httpServer = new x402HTTPResourceServer(resourceServer, x402Routes);
    let x402Initialized = false;
    const x402InitPromise = httpServer
      .initialize()
      .then(() => {
        x402Initialized = true;
      })
      .catch((err: unknown) =>
        logger.warn("x402.facilitator.init_failed", {
          error: err instanceof Error ? err.message : String(err),
          facilitator: x402Config.facilitatorUrl ?? "https://x402.org/facilitator",
        }),
      );
    const x402Gate = paymentMiddlewareFromHTTPServer(
      httpServer,
      { testnet: x402Config.testnet ?? true },
      undefined, // paywall
      false, // syncFacilitatorOnStart — already initialized above with error handling
    );

    // Wrap x402: single getAgentPricing() call per request.
    // Free tasks (no listing / zero price) bypass payment gate entirely.
    // Virtual account bypass: if the delegator has sufficient virtual balance,
    // skip x402 — the task handler will debit the virtual account directly.
    app.use("*", async (c, next) => {
      const isTaskPost = c.req.method === "POST" && /\/agent\/[^/]+\/task/.test(c.req.path);
      if (!isTaskPost) return next();
      const agentId = extractMotebitIdFromPath(c.req.path);
      currentPricing = agentId ? getAgentPricing(moteDb, agentId) : null;
      if (!currentPricing) return next(); // Free — no x402

      // Virtual account bypass: check if the delegator has sufficient virtual
      // balance to cover the cost. If so, skip x402 and let the handler debit
      // the virtual account directly.
      //
      // Step 1: Try the auth token (signed tokens contain the caller's motebit_id).
      // Step 2: If master token (no caller identity in token), peek at the body
      //         using arrayBuffer() which allows re-reading via a fresh Request.
      try {
        let delegatorId: string | undefined;
        const authHeader = c.req.header("authorization");
        if (authHeader?.startsWith("Bearer ")) {
          const token = authHeader.slice(7);
          const claims = parseTokenPayloadUnsafe(token);
          if (claims?.mid) {
            delegatorId = claims.mid;
          }
        }

        // If token didn't yield a delegator, peek at body for submitted_by
        if (!delegatorId) {
          const buf = await c.req.raw.arrayBuffer();
          const bodyText = new TextDecoder().decode(buf);
          // Reconstruct the request with the same body so x402 and handler can read it
          const newReq = new Request(c.req.raw.url, {
            method: c.req.raw.method,
            headers: c.req.raw.headers,
            body: bodyText,
          });
          // Replace the raw request on the context so downstream can re-read body
          // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any -- Hono internals: replacing raw request for body re-read
          (c.req as any).raw = newReq;
          const body = JSON.parse(bodyText) as { submitted_by?: string };
          delegatorId = body.submitted_by;
        }

        if (delegatorId) {
          const grossMicro = toMicro(
            computeGrossAmount(currentPricing.unitCost, PLATFORM_FEE_RATE),
          );
          const account = getAccountBalance(moteDb.db, delegatorId);
          if (account && account.balance >= grossMicro) {
            return next();
          }
        }
      } catch {
        // Parse failed — fall through to x402
      }

      // Guard: if facilitator is unreachable, the x402 gate throws (500) instead
      // of returning a proper 402. Only task submission (/agent/*/task, no further
      // path segments) goes through x402 — receipt endpoints pass through to next().
      const isExactTaskSubmission = /\/agent\/[^/]+\/task$/.test(c.req.path);
      if (isExactTaskSubmission) {
        await x402InitPromise;
        if (!x402Initialized) {
          return c.json(
            {
              error: "payment_required",
              message:
                "Payment facilitator unavailable — deposit to virtual account or retry later",
              estimated_cost: currentPricing?.unitCost ?? 0,
              platform_fee_rate: PLATFORM_FEE_RATE,
              network: x402Config.network,
            },
            402,
          );
        }
      }
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument -- Hono context type variance
      return x402Gate(c, next);
    });
  }

  // --- POST /agent/:motebitId/task — submit a task (master token or signed device token) ---
  app.post("/agent/:motebitId/task", async (c) => {
    const motebitId = asMotebitId(c.req.param("motebitId"));

    // Idempotency key required for task submission (involves budget allocation)
    const idempotencyKey = c.req.header("Idempotency-Key");
    if (!idempotencyKey) {
      throw new TaskError(
        "TASK_INVALID_INPUT",
        "Idempotency-Key header is required for task submission",
        400,
      );
    }

    const idempCheck = checkIdempotency(moteDb.db, idempotencyKey, motebitId);
    if (idempCheck.action === "replay") {
      return c.json(
        JSON.parse(idempCheck.body) as Record<string, unknown>,
        idempCheck.status as 201,
      );
    }
    if (idempCheck.action === "conflict") {
      throw new TaskError(
        "TASK_CONFLICT",
        "A request with this idempotency key is already being processed",
        409,
      );
    }

    const body = await c.req.json<{
      prompt: string;
      submitted_by?: string;
      wall_clock_ms?: number;
      required_capabilities?: string[];
      step_id?: string;
      /** Optional: requesting agent's exploration drive [0-1] from intelligence gradient. */
      exploration_drive?: number;
      /** Optional: agent IDs to exclude from routing (failed on previous attempts). */
      exclude_agents?: string[];
      /** Optional: routing strategy for candidate ranking. */
      routing_strategy?: "cost" | "quality" | "balanced";
    }>();

    if (!body.prompt || typeof body.prompt !== "string" || body.prompt.trim() === "") {
      throw new TaskError("TASK_INVALID_INPUT", "Missing or empty 'prompt' field", 400);
    }
    if (body.required_capabilities != null && !Array.isArray(body.required_capabilities)) {
      throw new TaskError(
        "TASK_INVALID_INPUT",
        "required_capabilities must be an array of strings",
        400,
      );
    }

    const taskId = crypto.randomUUID();
    const now = Date.now();
    const task: AgentTask = {
      task_id: taskId,
      motebit_id: motebitId,
      prompt: body.prompt,
      submitted_at: now,
      submitted_by: body.submitted_by,
      wall_clock_ms: body.wall_clock_ms,
      status: AgentTaskStatus.Pending,
      required_capabilities: Array.isArray(body.required_capabilities)
        ? (body.required_capabilities.filter(
            (c): c is string => typeof c === "string",
          ) as AgentTask["required_capabilities"])
        : undefined,
      step_id: body.step_id,
    };

    // Capture the submitter identity for receipt fan-out and settlement.
    // Prefer callerMotebitId (from dualAuth signed token) over body.submitted_by.
    const callerMotebitId = c.get("callerMotebitId" as never) as string | undefined;
    const submittedBy = callerMotebitId ?? body.submitted_by;

    // Snapshot the listing price at submission time so the settlement audit
    // matches what x402 actually charged. If the agent updates pricing between
    // submission and receipt delivery, the snapshot ensures consistency.
    // unit_cost is in dollars from the listing JSON. Convert to micro-units for accounting.
    const unitCostAtSubmission = getListingUnitCost(moteDb, motebitId);
    const priceSnapshot =
      unitCostAtSubmission > 0
        ? toMicro(computeGrossAmount(unitCostAtSubmission, PLATFORM_FEE_RATE)) // gross in micro-units
        : undefined;

    // Capture x402 payment proof from the settlement hook (set during middleware).
    // Read-and-clear so the next request starts fresh.
    const x402TxHash = lastSettleTxHash;
    const x402Net = lastSettleNetwork;
    lastSettleTxHash = undefined;
    lastSettleNetwork = undefined;

    // Reject if task queue is at capacity (prevents memory exhaustion from flooding)
    if (taskQueue.size >= MAX_TASK_QUEUE_SIZE) {
      throw new TaskError("TASK_QUEUE_FULL", "Task queue at capacity — try again later", 503);
    }

    // Per-submitter fairness: prevent a single agent from monopolizing queue capacity
    if (submittedBy) {
      let submitterCount = 0;
      for (const entry of taskQueue.values()) {
        if (entry.submitted_by === submittedBy) submitterCount++;
        if (submitterCount >= maxTasksPerSubmitter) {
          logger.warn("task.per_submitter_limit", {
            correlationId: taskId,
            submittedBy,
            limit: maxTasksPerSubmitter,
          });
          throw new TaskError(
            "TASK_PER_SUBMITTER_LIMIT",
            "Too many pending tasks for this agent",
            429,
          );
        }
      }
    }

    taskQueue.set(taskId, {
      task,
      expiresAt: now + TASK_TTL_MS,
      submitted_by: submittedBy,
      price_snapshot: priceSnapshot,
      x402_tx_hash: x402TxHash,
      x402_network: x402Net,
    });

    logger.info("task.submitted", {
      correlationId: taskId,
      taskId,
      motebitId,
      capabilities: task.required_capabilities ?? [],
    });

    // Persist budget allocation so settlement can verify the lock exists.
    if (priceSnapshot != null && priceSnapshot > 0) {
      // Determine whether this agent requires payment (has pay_to_address in listing)
      const agentPricingInfo = getAgentPricing(moteDb, motebitId);
      const requiresPayment = agentPricingInfo != null;

      try {
        const delegatorId = submittedBy ?? motebitId;

        // If x402 payment was made, auto-deposit to delegator's virtual account
        if (x402TxHash) {
          moteDb.db.exec("BEGIN");
          try {
            creditAccount(
              moteDb.db,
              delegatorId,
              priceSnapshot,
              "deposit",
              `x402-${taskId}`,
              `x402 payment for task ${taskId}`,
            );
            moteDb.db.exec("COMMIT");
          } catch (depositErr) {
            moteDb.db.exec("ROLLBACK");
            throw new SettlementError("SETTLEMENT_FAILED", "x402 auto-deposit failed", {
              cause: depositErr,
            });
          }

          // Attach proof through the x402 rail — sibling parity with Stripe webhook flow.
          const x402Rail = deps.railRegistry?.get("x402");
          if (x402Rail) {
            await x402Rail.attachProof(`x402-${taskId}`, {
              reference: x402TxHash,
              railType: "protocol",
              network: x402Net,
              confirmedAt: Date.now(),
            });
          }
        }

        // Try to hold funds from virtual account
        const account = getAccountBalance(moteDb.db, delegatorId);
        const virtualBalance = account?.balance ?? 0;

        // Use allocateBudget to compute lock amount with risk buffer
        const allocation = allocateBudget(
          {
            goal_id: asGoalId(taskId),
            candidate_motebit_id: asMotebitId(motebitId),
            estimated_cost: priceSnapshot,
            currency: "USDC",
            risk_factor: 1.0, // 1.2× buffer
          },
          virtualBalance,
          asAllocationId(`x402-${taskId}`),
        );

        if (allocation) {
          // Round to integer micro-units (allocateBudget may produce fractional from risk multiplier)
          allocation.amount_locked = Math.round(allocation.amount_locked);
          // Lock the risk-buffered amount
          moteDb.db.exec("BEGIN");
          try {
            debitAccount(
              moteDb.db,
              delegatorId,
              allocation.amount_locked, // Uses risk-buffered amount (rounded to micro-unit)
              "allocation_hold",
              `x402-${taskId}`,
              `Hold for task ${taskId} to ${motebitId}`,
            );
            moteDb.db
              .prepare(
                "INSERT OR IGNORE INTO relay_allocations (allocation_id, task_id, motebit_id, amount_locked, status, created_at) VALUES (?, ?, ?, ?, 'locked', ?)",
              )
              .run(`x402-${taskId}`, taskId, motebitId, allocation.amount_locked, now);
            moteDb.db.exec("COMMIT");
          } catch (holdErr) {
            moteDb.db.exec("ROLLBACK");
            throw new AllocationError("ALLOCATION_HOLD_FAILED", "Allocation hold failed", {
              cause: holdErr,
            });
          }
        } else if (requiresPayment && !x402TxHash) {
          // Paid agent, no virtual balance, no x402 payment — 402
          throw new InsufficientFundsError(
            "Insufficient funds — deposit to virtual account or pay via x402",
          );
        } else {
          // Either free agent (best-effort allocation) or x402 deposited (balance should be sufficient).
          // Persist allocation record for settlement audit.
          moteDb.db
            .prepare(
              "INSERT OR IGNORE INTO relay_allocations (allocation_id, task_id, motebit_id, amount_locked, status, created_at) VALUES (?, ?, ?, ?, 'locked', ?)",
            )
            .run(`x402-${taskId}`, taskId, motebitId, priceSnapshot, now);
        }
      } catch (err) {
        // Re-throw intentional errors (RelayError, HTTPException)
        if (err instanceof RelayError || err instanceof HTTPException) throw err;
        // For paid agents, accounting errors must not be silently swallowed —
        // allowing the task through without a budget hold means unpaid work.
        if (requiresPayment) {
          logger.error("task.budget_hold_failed", {
            correlationId: taskId,
            taskId,
            motebitId,
            error: err instanceof Error ? err.message : String(err),
          });
          throw new AllocationError(
            "ALLOCATION_HOLD_FAILED",
            "Budget allocation failed — retry or contact support",
          );
        }
        // Free agent — best-effort allocation, don't block task submission
      }
    }

    const requiredCaps = task.required_capabilities ?? [];
    const payload = JSON.stringify({ type: "task_request", task });
    let routed = false;
    let federationAttempted = false;
    let routingChoice:
      | {
          selected_agent: string;
          composite_score: number;
          sub_scores: Record<string, number>;
          routing_paths: string[][];
          alternatives_considered: number;
        }
      | undefined;

    // Phase 1: Scored routing — find best service agents from listings
    if (requiredCaps.length > 0) {
      try {
        const { profiles, requirements } = taskRouter.buildCandidateProfiles(
          requiredCaps[0],
          undefined,
          20,
          callerMotebitId,
        );
        // Narrow to candidates matching ALL required capabilities (not just the first)
        const multiCapProfiles =
          requiredCaps.length > 1
            ? profiles.filter((p) =>
                requiredCaps.every((cap) => p.listing?.capabilities.includes(cap)),
              )
            : profiles;

        // Filter out excluded agents (failed on previous delegation attempts)
        const excludeSet = new Set(
          Array.isArray(body.exclude_agents)
            ? body.exclude_agents.filter((a): a is string => typeof a === "string")
            : [],
        );
        const eligibleProfiles =
          excludeSet.size > 0
            ? multiCapProfiles.filter((p) => !excludeSet.has(p.motebit_id as string))
            : multiCapProfiles;

        // Phase 4: Fetch federated candidates from active peer relays (best-effort, non-blocking)
        let federatedCandidates: { profile: CandidateProfile; _source_relay_endpoint: string }[] =
          [];
        let federationEdges: Array<{
          from: string;
          to: string;
          weight: {
            trust: number;
            cost: number;
            latency: number;
            reliability: number;
            regulatory_risk: number;
          };
        }> = [];
        let peerRelayNodes: Array<{
          peerRelayId: string;
          trust: number;
          latency: number;
          reliability: number;
        }> = [];
        const remoteAgentRelay = new Map<string, string>(); // remote agent motebit_id → peer relay endpoint_url
        try {
          const fedResult = await taskRouter.fetchFederatedCandidates(
            requiredCaps,
            callerMotebitId,
          );
          federatedCandidates = fedResult.candidates;
          federationEdges = fedResult.federationEdges;
          peerRelayNodes = fedResult.peerRelayNodes;
          for (const fc of federatedCandidates) {
            // Filter out excluded agents from federated results too
            if (!excludeSet.has(fc.profile.motebit_id as string)) {
              remoteAgentRelay.set(fc.profile.motebit_id as string, fc._source_relay_endpoint);
            }
          }
        } catch {
          // Federation candidate fetch is best-effort — don't block local routing
        }

        // Merge local and federated candidates before ranking
        const federatedProfiles = federatedCandidates
          .filter((fc) => !excludeSet.has(fc.profile.motebit_id as string))
          .map((fc) => fc.profile);
        const allProfiles = [...eligibleProfiles, ...federatedProfiles];

        if (allProfiles.length > 0) {
          // Apply gradient-informed precision to routing weights when provided
          const explorationWeight =
            typeof body.exploration_drive === "number"
              ? Math.max(0, Math.min(1, body.exploration_drive))
              : undefined;
          const peerEdges = taskRouter.fetchPeerEdges();

          // Build selfId → peerRelay edges and merge with peerRelay → agent edges
          // so the semiring graph composes trust multiplicatively along the full path
          const selfId = callerMotebitId ?? motebitId;
          const federationPeerEdges = peerRelayNodes.map((node) => ({
            from: selfId,
            to: node.peerRelayId,
            weight: {
              trust: node.trust,
              cost: 0,
              latency: node.latency,
              reliability: node.reliability,
              regulatory_risk: 0,
            },
          }));
          const allPeerEdges = [...peerEdges, ...federationPeerEdges, ...federationEdges];

          // Map routing_strategy to semiring composite function
          const compositeFunction: CompositeFunction | undefined =
            body.routing_strategy === "cost"
              ? (_route, scores) => scores.costScore * 1e6 + scores.reliability * 1e3 + scores.trust
              : body.routing_strategy === "quality"
                ? lexicographicComposite
                : body.routing_strategy === "balanced"
                  ? weightedSumComposite
                  : undefined;

          // Look up caller's guardian key for organizational trust baseline
          const callerGuardianRow = moteDb.db
            .prepare("SELECT guardian_public_key FROM agent_registry WHERE motebit_id = ?")
            .get(callerMotebitId ?? motebitId) as
            | { guardian_public_key: string | null }
            | undefined;

          const ranked = explainedRankCandidates(
            asMotebitId(callerMotebitId ?? motebitId),
            allProfiles,
            {
              ...requirements,
              required_capabilities: requiredCaps,
            },
            {
              maxCandidates: 10,
              explorationWeight,
              peerEdges: allPeerEdges,
              compositeFunction,
              callerGuardianPublicKey: callerGuardianRow?.guardian_public_key ?? undefined,
            },
          );
          const selected = ranked.filter((r) => r.selected && r.composite > 0);

          if (selected.length > 0) {
            // Capture routing provenance from the top-ranked agent for the response
            const topScore = selected[0]!;
            routingChoice = {
              selected_agent: topScore.motebit_id as string,
              composite_score: topScore.composite,
              sub_scores: topScore.sub_scores,
              routing_paths: topScore.routing_paths,
              alternatives_considered: topScore.alternatives_considered,
            };

            // Route to selected agents — local via WebSocket, remote via federation forward
            for (const sel of selected) {
              const selId = sel.motebit_id as string;
              if (remoteAgentRelay.has(selId)) {
                // Remote agent: forward task to peer relay
                const peerEndpoint = remoteAgentRelay.get(selId)!;

                // Circuit breaker: skip forwarding if the peer's circuit is open
                if (!taskRouter.canForward(peerEndpoint)) {
                  logger.info("task.forward_circuit_open", {
                    correlationId: taskId,
                    peerRelay: peerEndpoint,
                    targetAgent: selId,
                  });
                  continue;
                }

                federationAttempted = true;
                try {
                  const forwardBody = {
                    task_id: taskId,
                    origin_relay: relayIdentity.relayMotebitId,
                    target_agent: selId,
                    task_payload: {
                      prompt: body.prompt,
                      required_capabilities: requiredCaps,
                      submitted_by: submittedBy,
                      wall_clock_ms: body.wall_clock_ms,
                    },
                    routing_choice: routingChoice,
                    timestamp: Date.now(),
                  };
                  const forwardBytes = new TextEncoder().encode(canonicalJson(forwardBody));
                  const forwardSig = await sign(forwardBytes, relayIdentity.privateKey);

                  const resp = await fetch(`${peerEndpoint}/federation/v1/task/forward`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json", "X-Correlation-ID": taskId },
                    body: JSON.stringify({
                      ...forwardBody,
                      signature: bytesToHex(forwardSig),
                    }),
                    signal: AbortSignal.timeout(10000),
                  });

                  if (resp.ok) {
                    routed = true;
                    taskRouter.recordPeerForwardResult(peerEndpoint, true);
                    logger.info("task.forwarded", {
                      correlationId: taskId,
                      peerRelay: peerEndpoint,
                      targetAgent: selId,
                    });
                  } else {
                    taskRouter.recordPeerForwardResult(peerEndpoint, false);
                  }
                } catch (fwdErr) {
                  taskRouter.recordPeerForwardResult(peerEndpoint, false);
                  logger.warn("task.forward_failed", {
                    correlationId: taskId,
                    peerRelay: peerEndpoint,
                    targetAgent: selId,
                    error: fwdErr instanceof Error ? fwdErr.message : String(fwdErr),
                  });
                }
              } else {
                // Local agent: route via WebSocket first, HTTP MCP fallback
                const localPeers = connections.get(selId);
                if (localPeers && localPeers.length > 0) {
                  for (const peer of localPeers) {
                    peer.ws.send(payload);
                  }
                  routed = true;
                } else {
                  // No WebSocket — try HTTP MCP forwarding via registered endpoint_url
                  const regRow = moteDb.db
                    .prepare(
                      "SELECT endpoint_url FROM agent_registry WHERE motebit_id = ? AND expires_at > ?",
                    )
                    .get(selId, Date.now()) as { endpoint_url: string } | undefined;
                  if (regRow?.endpoint_url?.trim()) {
                    void forwardTaskViaMcp(
                      regRow.endpoint_url,
                      taskId,
                      body.prompt,
                      selId,
                      taskQueue as Map<string, { task: { status: string }; receipt?: unknown }>,
                      logger,
                      apiToken,
                      async (receiptCandidate: ReceiptCandidate) => {
                        const mcpEntry = taskQueue.get(taskId);
                        if (!mcpEntry || mcpEntry.settled) return;
                        await handleReceiptIngestion(
                          receiptCandidate as unknown as ExecutionReceipt,
                          taskId,
                          mcpEntry.task.motebit_id,
                          mcpEntry,
                          ingestionDeps,
                        );
                      },
                    );
                    routed = true;
                  }
                }
              }
            }
          }
        }
      } catch (err) {
        // Re-throw intentional HTTP errors (e.g. 402 insufficient budget)
        if (err instanceof HTTPException) throw err;
        // Scoring failed — fall through to broadcast
      }
    }

    // Phase 2: Broadcast fallback — original behavior.
    // Skip if a federation forward was attempted (even if it timed out) — the peer relay
    // may have accepted the task, and broadcasting locally would cause double-execution.
    if (!routed && !federationAttempted) {
      const peers = connections.get(motebitId);
      if (peers) {
        for (const peer of peers) {
          if (requiredCaps.length > 0 && peer.capabilities) {
            const hasAll = requiredCaps.every((c) => peer.capabilities!.includes(c));
            if (!hasAll) continue;
          }
          peer.ws.send(payload);
          routed = true;
        }
      }
    }

    // Phase 3: HTTP MCP fallback — when no WebSocket routed the task,
    // find a registered agent with matching capabilities and forward via HTTP.
    if (!routed && !federationAttempted && requiredCaps.length > 0) {
      const now = Date.now();
      const capFilter = requiredCaps[0]!;
      const httpCandidate = moteDb.db
        .prepare(
          `SELECT r.motebit_id, r.endpoint_url FROM agent_registry r
           WHERE r.expires_at > ? AND r.endpoint_url != ''
             AND EXISTS (SELECT 1 FROM json_each(r.capabilities) WHERE value = ?)
           LIMIT 1`,
        )
        .get(now, capFilter) as { motebit_id: string; endpoint_url: string } | undefined;
      if (httpCandidate?.endpoint_url?.trim()) {
        void forwardTaskViaMcp(
          httpCandidate.endpoint_url,
          taskId,
          body.prompt,
          httpCandidate.motebit_id,
          taskQueue as Map<string, { task: { status: string }; receipt?: unknown }>,
          logger,
          apiToken,
          async (receiptCandidate: ReceiptCandidate) => {
            const mcpEntry = taskQueue.get(taskId);
            if (!mcpEntry || mcpEntry.settled) return;
            await handleReceiptIngestion(
              receiptCandidate as unknown as ExecutionReceipt,
              taskId,
              mcpEntry.task.motebit_id,
              mcpEntry,
              ingestionDeps,
            );
          },
        );
        routed = true;
      }
    }

    // Phase 4: Push wake — when no WebSocket, no HTTP MCP, and no federation routed the task,
    // attempt to wake a mobile device via push notification. Fire-and-forget — the task stays
    // in queue regardless. The device will reconnect via WebSocket and claim the task.
    if (!routed && !federationAttempted && pushAdapter) {
      void attemptPushWake(motebitId, { pushAdapter, db: moteDb.db });
    }

    const responseBody = {
      task_id: taskId,
      status: task.status,
      routing_choice: routingChoice ?? null,
    };
    completeIdempotency(moteDb.db, idempotencyKey, motebitId, 201, JSON.stringify(responseBody));
    return c.json(responseBody, 201);
  });

  // --- GET /agent/:motebitId/task/:taskId — poll task status ---
  app.get("/agent/:motebitId/task/:taskId", async (c) => {
    const motebitId = asMotebitId(c.req.param("motebitId"));
    const taskId = c.req.param("taskId");

    // Device auth: require signed token or master token
    const authHeader = c.req.header("authorization");
    if (authHeader == null || !authHeader.startsWith("Bearer ")) {
      throw new AuthenticationError("AUTH_MISSING_TOKEN", "Authorization required");
    }
    const token = authHeader.slice(7);
    let callerMotebitId: string | undefined;
    if (apiToken != null && apiToken !== "" && token === apiToken) {
      // Master token bypass — caller identity unknown but trusted
    } else if (enableDeviceAuth && token.includes(".")) {
      // Verify device token against the CALLER's identity (from token claims),
      // not the target agent's motebitId from the URL. The submitter polls for
      // tasks they submitted to another agent — their token carries their own mid.
      const claims = parseTokenPayloadUnsafe(token);
      if (!claims?.mid) {
        throw new AuthenticationError("AUTH_INVALID_TOKEN", "Invalid token");
      }
      const verified = await verifySignedTokenForDevice(
        token,
        claims.mid,
        identityManager,
        "task:query",
        isTokenBlacklisted,
        isAgentRevoked,
      );
      if (!verified) {
        throw new AuthorizationError("AUTHZ_DEVICE_NOT_AUTHORIZED", "Device not authorized");
      }
      callerMotebitId = claims.mid;
    } else {
      throw new AuthorizationError("AUTHZ_INVALID_CREDENTIALS", "Invalid authorization");
    }

    const entry = taskQueue.get(taskId);

    if (!entry) {
      throw new TaskError(
        "TASK_NOT_FOUND",
        `Task not found — it may have expired (TTL ${Math.round(TASK_TTL_MS / 60_000)}min) or the task_id is invalid`,
        404,
      );
    }
    if (entry.task.motebit_id !== motebitId) {
      throw new TaskError(
        "TASK_NOT_FOUND",
        "Task not found — motebit_id in URL does not match the task's target agent",
        404,
      );
    }

    // Authorization: caller must be the submitter or the target agent
    if (callerMotebitId) {
      const submitter = entry.submitted_by ?? entry.task.submitted_by;
      if (callerMotebitId !== motebitId && callerMotebitId !== submitter) {
        throw new AuthorizationError(
          "AUTHZ_NOT_TASK_PARTICIPANT",
          "Not authorized to poll this task — caller is neither the submitter nor the target agent",
        );
      }
    }

    return c.json({ task: entry.task, receipt: entry.receipt ?? null });
  });

  // --- POST /agent/:motebitId/task/:taskId/result — device posts signed receipt ---
  app.post("/agent/:motebitId/task/:taskId/result", async (c) => {
    const motebitId = asMotebitId(c.req.param("motebitId"));
    const taskId = c.req.param("taskId");

    // Device auth: require signed token or master token
    const authHeader = c.req.header("authorization");
    if (authHeader == null || !authHeader.startsWith("Bearer ")) {
      throw new AuthenticationError("AUTH_MISSING_TOKEN", "Authorization required");
    }
    const token = authHeader.slice(7);
    if (apiToken == null || token !== apiToken) {
      // Verify as device signed token
      if (enableDeviceAuth && token.includes(".")) {
        const verified = await verifySignedTokenForDevice(
          token,
          motebitId,
          identityManager,
          "task:result",
          isTokenBlacklisted,
          isAgentRevoked,
        );
        if (!verified) {
          throw new AuthorizationError("AUTHZ_DEVICE_NOT_AUTHORIZED", "Device not authorized");
        }
      } else {
        throw new AuthorizationError("AUTHZ_INVALID_CREDENTIALS", "Invalid authorization");
      }
    }

    const entry = taskQueue.get(taskId);
    if (!entry) {
      throw new TaskError(
        "TASK_NOT_FOUND",
        `Task not found — it may have expired (TTL ${Math.round(TASK_TTL_MS / 60_000)}min) or the task_id is invalid`,
        404,
      );
    }
    if (entry.task.motebit_id !== motebitId) {
      throw new TaskError(
        "TASK_NOT_FOUND",
        "Task not found — motebit_id in URL does not match the task's target agent",
        404,
      );
    }

    const receipt = await c.req.json<ExecutionReceipt>();

    // Structural validation: require essential receipt fields
    const validStatuses = ["completed", "failed", "denied"];
    if (
      typeof receipt.task_id !== "string" ||
      receipt.task_id === "" ||
      typeof receipt.motebit_id !== "string" ||
      receipt.motebit_id === "" ||
      typeof receipt.signature !== "string" ||
      receipt.signature === "" ||
      typeof receipt.status !== "string" ||
      !validStatuses.includes(receipt.status)
    ) {
      throw new TaskError(
        "TASK_INVALID_INPUT",
        "Invalid receipt: must include non-empty task_id, motebit_id, signature, and valid status",
        400,
      );
    }

    // Reject stale receipts — completed_at must be within 1 hour of submitted_at
    if (receipt.completed_at && entry.task.submitted_at) {
      const elapsed = receipt.completed_at - entry.task.submitted_at;
      if (elapsed > 3_600_000 || elapsed < -60_000) {
        // 1 hour max, 1 min clock skew tolerance
        throw new TaskError(
          "TASK_INVALID_INPUT",
          `Receipt timestamp outside acceptable window (elapsed=${Math.round(elapsed / 1000)}s, allowed=-60s to +3600s) — check agent clock synchronization`,
          400,
        );
      }
    }

    // Task-receipt binding (dual invariant):
    // 1. Primary: relay_task_id — cryptographic binding to the economic identity of the task.
    // 2. Secondary: prompt_hash — semantic binding to the task content.
    const receiptRelayTaskId = (receipt as unknown as Record<string, unknown>).relay_task_id;
    if (typeof receiptRelayTaskId === "string" && receiptRelayTaskId !== "") {
      if (receiptRelayTaskId !== taskId) {
        throw new TaskError(
          "TASK_INVALID_INPUT",
          `Receipt relay_task_id "${receiptRelayTaskId}" does not match task "${taskId}" — receipt is bound to a different economic contract`,
          400,
        );
      }
    } else {
      // No relay_task_id — reject. This field is required for cryptographic binding.
      logger.error("receipt.missing_relay_task_id", {
        correlationId: taskId,
        reason: "receipt does not include relay_task_id — required for economic binding",
        motebitId: receipt.motebit_id as string,
      });
      throw new TaskError(
        "TASK_INVALID_INPUT",
        "Receipt missing relay_task_id — cryptographic task binding is required. Ensure your motebit runtime is up to date.",
        400,
      );
    }

    // Update task status and store receipt before settlement
    entry.receipt = receipt;
    entry.expiresAt = Math.max(entry.expiresAt, Date.now() + TASK_TTL_MS);
    entry.task.status =
      receipt.status === "completed"
        ? AgentTaskStatus.Completed
        : receipt.status === "denied"
          ? AgentTaskStatus.Denied
          : AgentTaskStatus.Failed;
    taskQueue.set(taskId, entry); // Persist to durable queue

    // Unified receipt ingestion: Ed25519 verification → settlement → trust → credentials
    const ingestionResult = await handleReceiptIngestion(
      receipt,
      taskId,
      motebitId,
      entry,
      ingestionDeps,
    );
    if (!ingestionResult.verified) {
      throw new AuthorizationError(
        "AUTHZ_INVALID_CREDENTIALS",
        `Receipt verification failed: ${ingestionResult.reason}`,
      );
    }

    if (ingestionResult.already_settled) {
      return c.json({ status: "already_settled" });
    }
    return c.json({ status: entry.task.status, credential_id: ingestionResult.credential_id });
  });
}
