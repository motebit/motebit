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
  PLATFORM_FEE_RATE as SDK_DEFAULT_PLATFORM_FEE_RATE,
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
  signSettlement,
  canonicalJson,
  bytesToHex,
  hexToBytes,
  verifyExecutionReceiptDetailed,
} from "@motebit/encryption";
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
import {
  forwardTaskViaMcp,
  evaluateSettlementEligibility,
  type ReceiptCandidate,
} from "./task-routing.js";
import type { TaskRouter } from "./task-routing.js";
import { persistReceiptChain } from "./receipts-store.js";
import {
  MAX_SETTLEMENT_DEPTH,
  exceedsSettlementDepth,
  settlementTreeDepths,
} from "./multihop-depth.js";
import type { ConnectedDevice } from "./index.js";
import { checkIdempotency, completeIdempotency } from "./idempotency.js";
import { createLogger } from "./logger.js";
import { ExecutionReceiptSchema } from "@motebit/wire-schemas";
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
  /** Settlement mode: "relay" (default) or "p2p" (direct onchain). */
  settlement_mode?: "relay" | "p2p";
  /**
   * P2P payment proof (when settlement_mode === "p2p"). After Arc 2 of
   * the off-ramp arc, carries the fee-leg fields so the relay can
   * record and verify both delegator→worker and delegator→treasury
   * transfers from the same atomic multi-output Solana tx.
   */
  p2p_payment_proof?: {
    tx_hash: string;
    chain: string;
    network: string;
    to_address: string;
    amount_micro: number;
    fee_to_address: string;
    fee_amount_micro: number;
    /** Executor-relay (B) fee leg — cross-operator federated P2P only. */
    b_fee_to_address?: string;
    b_fee_amount_micro?: number;
  };
  /** Target agent for p2p tasks (pinned routing). */
  target_agent?: string;
};

// Platform fee rate is no longer a module-level variable. It lives in the
// closure of `registerTaskRoutes` (see the function body below), guaranteeing
// every registered handler sees the same rate and different relay instances
// don't clobber each other's state. SDK_DEFAULT_PLATFORM_FEE_RATE is the
// fallback when `deps.platformFeeRate` is omitted.

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
  railRegistry?: import("@motebit/settlement-rails").SettlementRailRegistry;
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

/**
 * Arc 3.5 P2P-by-default gate predicate. Returns `true` ⟺ a submission must be
 * rejected with `TASK_P2P_PROOF_REQUIRED` (402): paid direct delegation to a
 * DIFFERENT worker, settling relay-custody, with no P2P proof and no x402 proof.
 *
 * Pure and exported so the carve-out matrix is unit-testable as a truth table.
 * The x402-paid carve-out in particular is not integration-drivable — `x402TxHash`
 * is set only by the x402 `resourceServer.onAfterSettle` hook on a real onchain
 * payment (a module closure, not a spyable relay method), so a pure-function test
 * is the only way to exercise that branch. The three carve-outs (false return):
 * zero-cost (`unitCostAtSubmission === 0`), self-delegation (`submittedBy === workerId`),
 * and x402-paid (`x402TxHash != null`). See docs/doctrine/off-ramp-as-user-action.md
 * § "Arc 3.5".
 */
export function requiresP2pProof(args: {
  settlementMode: "relay" | "p2p";
  x402TxHash: string | null | undefined;
  unitCostAtSubmission: number;
  submittedBy: string | null | undefined;
  workerId: string;
}): boolean {
  return (
    args.settlementMode === "relay" &&
    args.x402TxHash == null &&
    args.unitCostAtSubmission > 0 &&
    args.submittedBy != null &&
    args.submittedBy !== args.workerId
  );
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
    /**
     * Platform fee rate (0–1) for this relay instance. Passed explicitly
     * so there is no module-level global state — every caller provides the
     * rate, every handler sees the one it was called with. Previous code
     * used a module-level `let PLATFORM_FEE_RATE` which could be clobbered
     * by concurrent relay instantiations.
     */
    platformFeeRate: number;
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
    platformFeeRate,
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
    const devices = await identityManager.listDevices(receipt.motebit_id);
    const device =
      (receipt.device_id != null
        ? devices.find((d) => d.device_id === receipt.device_id)
        : undefined) ?? devices.find((d) => d.public_key);
    if (device?.public_key) {
      pubKeyHex = device.public_key;
    }
  }

  if (!pubKeyHex) {
    const executingId = receipt.motebit_id;
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
    // Diagnostic: emit the canonical bytes the verifier reproduced so the
    // producer can byte-diff against its own sign-time hash. The producer
    // logs the same hash via signExecutionReceipt's debug path when
    // DEBUG_RECEIPT_BYTES=1. A hash mismatch localizes the bug to the wire
    // path; a hash match would localize it to the signature primitive
    // (which standalone tests rule out). See
    // packages/crypto/src/__tests__/device-registration.test.ts and
    // packages/mcp-server/src/__tests__/build-receipt.test.ts for the
    // contract this gate defends.
    const detail = await verifyExecutionReceiptDetailed(receipt, hexToBytes(pubKeyHex));
    logger.error("receipt.verification_failed", {
      correlationId: taskId,
      reason: "invalid Ed25519 signature",
      canonical_sha256: detail.canonical_sha256,
      canonical_preview: detail.canonical_preview,
      detail_reason: detail.reason,
      chain_length: Array.isArray(
        (receipt as unknown as Record<string, unknown>).delegation_receipts,
      )
        ? ((receipt as unknown as Record<string, unknown>).delegation_receipts as unknown[]).length
        : 0,
    });
    return { verified: false, reason: "invalid Ed25519 signature" };
  }

  logger.info("receipt.verified", {
    correlationId: taskId,
    status: receipt.status,
    motebitId: receipt.motebit_id,
  });

  // --- Archive the signed receipt tree ---
  // INSERT OR IGNORE keyed by (motebit_id, task_id). Runs before the
  // settlement duplicate short-circuit so re-submissions still
  // archive if the prior write failed; the composite PK keeps
  // double-writes safe. See services/relay/src/receipts-store.ts.
  persistReceiptChain(moteDb.db, receipt);

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
  const isSelfDelegation = taskSubmitter != null && taskSubmitter === receipt.motebit_id;
  if (isSelfDelegation) {
    logger.info("trust.self_delegation_skipped", {
      correlationId: taskId,
      motebitId,
      reason: "submitter === executor — no trust signal or credential issued",
    });
  }
  if (!isSelfDelegation) {
    try {
      const executingAgentId = receipt.motebit_id;
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
            await walkReceipts(sub.motebit_id, sub.delegation_receipts);
          }
        }
      };

      await walkReceipts(receipt.motebit_id, receipt.delegation_receipts);
    } catch {
      // Best-effort edge caching
    }
  }

  // --- Multi-hop settlement (recursive) ---
  const delegationReceipts = receipt.delegation_receipts ?? [];
  if (delegationReceipts.length > 0) {
    const maxSettlementDepth = deps.maxSettlementDepth ?? MAX_SETTLEMENT_DEPTH;

    const settleSubReceipt = async (
      sub: ExecutionReceipt,
      parentTaskId: string,
      depth: number,
    ): Promise<void> => {
      if (exceedsSettlementDepth(depth, maxSettlementDepth)) {
        const subRelayTaskId = (sub as unknown as Record<string, unknown>).relay_task_id;
        logger.error("multihop.settlement.depth_limit_exceeded", {
          correlationId: parentTaskId,
          subAgent: sub.motebit_id,
          subTaskId: typeof subRelayTaskId === "string" ? subRelayTaskId : null,
          depth,
          maxDepth: maxSettlementDepth,
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

        const subUnitCost = getListingUnitCost(moteDb, sub.motebit_id);
        const subGross =
          subEntry.price_snapshot ??
          (subUnitCost > 0 ? toMicro(computeGrossAmount(subUnitCost, platformFeeRate)) : 0);
        if (subGross <= 0) {
          // No cost — still recurse into nested receipts
          const nestedReceipts = sub.delegation_receipts ?? [];
          for (const nested of nestedReceipts) {
            await settleSubReceipt(nested, parentTaskId, depth + 1);
          }
          return;
        }

        // ARC-MARKER(multi-hop-as-P2P): we are about to perform the relay-mode
        // multi-hop settlement WRITE — the deferred residual (services/relay/CLAUDE.md
        // rule 8). Post Arc-3.5 (P2P-by-default gate, live 2026-05-17) a paid
        // cross-agent sub-delegation is gated like any direct delegation, so this
        // write is reachable only for (a) legacy nested settlements submitted
        // before the cutoff and only now completing, or (b) the x402-paid carve-out
        // (which `requiresP2pProof`'s own doc notes is not integration-drivable).
        // It is instrumented LOUDLY rather than thrown: at ~8 days post-cutoff a
        // legacy in-flight nested settlement can still legitimately land here, and
        // a throw would regress exactly the state this residual was preserved for.
        // The multi-hop-as-P2P arc INVERTS this marker to a hard throw when it
        // replaces the branch wholesale. The error-level event name below is the
        // metric (the relay's observability surface is structured logs, not a
        // counter facility) — alerting keys on `multihop.settlement.relay_residual_fired`.
        logger.error("multihop.settlement.relay_residual_fired", {
          correlationId: parentTaskId,
          subTaskId: subRelayTaskId,
          subAgent: sub.motebit_id,
          depth,
          amountLocked: subGross,
          marker: "ARC:multi-hop-as-P2P",
        });

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

        // Self-attesting sub-settlement. Sign BEFORE the synchronous
        // BEGIN/COMMIT block — see the canonical settlement site for the
        // concurrency rationale (await inside transaction interleaves).
        const signedSubSettlement = await signSettlement(
          {
            settlement_id: subSettlement.settlement_id,
            allocation_id: subSettlement.allocation_id,
            // Payee = the sub-agent named on the sub-receipt.
            motebit_id: subSettlement.motebit_id,
            receipt_hash: subSettlement.receipt_hash,
            ledger_hash: subSettlement.ledger_hash,
            amount_settled: subSettlement.amount_settled,
            platform_fee: subSettlement.platform_fee,
            platform_fee_rate: subSettlement.platform_fee_rate,
            // Multi-hop sub-receipt settlement-write. NOTE the precise
            // scope: the sub-task SUBMISSION (B→C) is a real
            // `POST /agent/C/task` and, once Arc 3.5's gate lands, a *paid*
            // sub-hop is gated exactly like a direct delegation (it needs
            // its own P2P proof). This relay-mode WRITE is therefore a
            // residual of the pre-gate topology — reachable only for a
            // paid sub-receipt that has no settlement of its own (e.g. the
            // sub-agent's receipt was nested in the parent's rather than
            // posted directly). Reconciling this write to honor the
            // sub-task's submitted settlement_mode (so a p2p-submitted
            // sub-hop settles p2p, not relay) is the deferred
            // multi-hop-as-P2P arc. See
            // `docs/doctrine/off-ramp-as-user-action.md` § "Arc 3.5".
            settlement_mode: "relay",
            status: subSettlement.status,
            settled_at: subSettlement.settled_at,
            issuer_relay_id: relayIdentity.relayMotebitId,
          },
          relayIdentity.privateKey,
        );

        try {
          moteDb.db.exec("BEGIN");
          moteDb.db
            .prepare(
              `INSERT OR IGNORE INTO relay_settlements
             (settlement_id, allocation_id, task_id, motebit_id, receipt_hash, ledger_hash, amount_settled, platform_fee, platform_fee_rate, status, settled_at, settlement_mode, issuer_relay_id, suite, signature, record_json)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              signedSubSettlement.settlement_id,
              signedSubSettlement.allocation_id,
              subRelayTaskId,
              sub.motebit_id,
              signedSubSettlement.receipt_hash,
              signedSubSettlement.ledger_hash,
              signedSubSettlement.amount_settled,
              signedSubSettlement.platform_fee,
              signedSubSettlement.platform_fee_rate,
              signedSubSettlement.status,
              signedSubSettlement.settled_at,
              signedSubSettlement.settlement_mode,
              signedSubSettlement.issuer_relay_id,
              signedSubSettlement.suite,
              signedSubSettlement.signature,
              // Rule 11: store the exact canonical signed bytes. The anchor
              // leaf is SHA-256 of THIS, so it equals the bytes the worker holds.
              canonicalJson(signedSubSettlement),
            );

          moteDb.db
            .prepare(
              "UPDATE relay_allocations SET status = 'settled', settled_at = ? WHERE task_id = ?",
            )
            .run(Date.now(), subRelayTaskId);

          if (subSettlement.amount_settled > 0) {
            creditAccount(
              moteDb.db,
              sub.motebit_id,
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

    const treeNodes = settlementTreeDepths(receipt, maxSettlementDepth);
    logger.info("multihop.settlement.start", {
      correlationId: taskId,
      count: delegationReceipts.length,
      treeDepth: treeNodes.reduce((m, n) => Math.max(m, n.depth), 0),
      depthBlockedCount: treeNodes.filter((n) => n.depthBlocked).length,
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
      // P2P tasks: audit record only, no fund movement.
      // Inserted inside the settlement try-block so it shares the error boundary (#10).
      if (entry.settlement_mode === "p2p") {
        const p2pSettlementId = crypto.randomUUID();
        const p2pSettledAt = Date.now();

        // P2P settlement after Arc 2 of the off-ramp arc: money moves
        // delegator→worker AND delegator→relay_treasury in a single
        // atomic Solana multi-output tx. The relay never held the
        // worker's earnings OR the fee; both legs settle on-chain as
        // the delegator's principal action.
        //
        // The signed audit record commits the relay to "I observed
        // this task settle peer-to-peer at worker_amount + fee with
        // status completed" — the p2p-verifier walks transfers[] on
        // `p2p_tx_hash` to validate both legs against the recorded
        // `amount_settled` and `platform_fee`.
        //
        // Resolves the sibling-doc contradiction the settlement_mode
        // arc surfaced: `platform_fee` is now non-zero on P2P,
        // matching the top-level "5% applies through both lanes"
        // claim. `services/relay/CLAUDE.md` rule 8 amends in the
        // same arc commit.
        const p2pProof = entry.p2p_payment_proof;
        const p2pWorkerAmount = p2pProof?.amount_micro ?? 0;
        // Which fee leg funds THIS relay's treasury? For a single-operator P2P
        // task it is the only fee leg (`fee_amount_micro`). For a cross-operator
        // FEDERATED task this relay is the EXECUTOR (origin_relay set) — its
        // treasury is funded by the executor-fee leg (`b_fee_amount_micro`); the
        // origin relay records the origin-fee leg separately in
        // onTaskResultReceived. This keeps each relay's recorded fee equal to the
        // onchain leg landing in its OWN treasury (the verifier + reconciler both
        // key on `platform_fee` → treasury).
        const isFederatedExecutorP2p = entry.origin_relay != null;
        const p2pFeeAmount = isFederatedExecutorP2p
          ? (p2pProof?.b_fee_amount_micro ?? 0)
          : (p2pProof?.fee_amount_micro ?? 0);
        // Gross at this relay's hop = worker net + this relay's fee.
        const p2pGrossAmount = p2pWorkerAmount + p2pFeeAmount;
        const p2pFeeRate =
          p2pGrossAmount > 0 ? Math.round((p2pFeeAmount / p2pGrossAmount) * 10000) / 10000 : 0;

        const signedP2pAudit = await signSettlement(
          {
            settlement_id: p2pSettlementId as never,
            allocation_id: `p2p-${taskId}` as never,
            // Payee = the worker that executed and was paid onchain.
            motebit_id: motebitId,
            receipt_hash: receipt.result_hash ?? "",
            ledger_hash: null,
            amount_settled: p2pWorkerAmount,
            platform_fee: p2pFeeAmount,
            platform_fee_rate: p2pFeeRate,
            // P2P audit record: relay never held the funds. Money moved
            // onchain delegator → worker AND delegator → treasury in a
            // single atomic tx. Lane is part of the signed body so the
            // relay's custody posture is committed-to, not derivable.
            settlement_mode: "p2p",
            status: "completed",
            settled_at: p2pSettledAt,
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
              issuer_relay_id, suite, signature, record_json)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            p2pSettlementId,
            `p2p-${taskId}`,
            taskId,
            motebitId,
            receipt.result_hash ?? "",
            p2pWorkerAmount,
            p2pFeeAmount,
            p2pFeeRate,
            "completed",
            p2pSettledAt,
            "p2p",
            p2pProof?.tx_hash ?? null,
            "pending",
            entry.submitted_by ?? null,
            signedP2pAudit.issuer_relay_id,
            signedP2pAudit.suite,
            signedP2pAudit.signature,
            canonicalJson(signedP2pAudit),
          );
      }

      // P2P tasks: settlement audit already recorded above. Skip relay settlement,
      // jump to credential issuance.
      const isP2pTask = entry.settlement_mode === "p2p";

      // Federated-executor dedupe (spec relay-federation-v1 §7.3): when THIS
      // relay executed a task forwarded by a peer (origin_relay set), the local
      // relay-settlement money path must NOT fire. Settlement is origin-driven —
      // the originating relay extracts its fee and forwards the remainder via
      // /settlement/forward, and this relay credits the worker exactly once in
      // onSettlementReceived. Settling locally here would pay the worker the
      // wrong local-price amount AND double-pay once the forwarded settlement
      // arrives. The result is still forwarded back to origin below (see the
      // `entry.origin_relay` block); only the fund movement is skipped.
      const isFederatedExecutor = entry.origin_relay != null;

      const persistentAlloc = isP2pTask
        ? undefined
        : (moteDb.db
            .prepare("SELECT * FROM relay_allocations WHERE task_id = ? AND status = 'locked'")
            .get(taskId) as
            | { allocation_id: string; amount_locked: number; motebit_id: string }
            | undefined);

      const fallbackUnitCost = isP2pTask ? 0 : getListingUnitCost(moteDb, receipt.motebit_id);
      const grossAmount =
        entry.price_snapshot ??
        persistentAlloc?.amount_locked ??
        (fallbackUnitCost > 0 ? toMicro(computeGrossAmount(fallbackUnitCost, platformFeeRate)) : 0);

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
          .all(receipt.motebit_id) as Array<{ latency_ms: number }>;
        const avgLatency =
          latencyRows.length > 0
            ? latencyRows.reduce((a, r) => a + r.latency_ms, 0) / latencyRows.length
            : receipt.completed_at && receipt.submitted_at
              ? receipt.completed_at - receipt.submitted_at
              : 0;

        const subjectDid = pubKeyHex
          ? hexPublicKeyToDidKey(pubKeyHex)
          : `did:motebit:${receipt.motebit_id}`;

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
          subject: receipt.motebit_id,
          issuer: vc.issuer,
          type: credType,
          json: JSON.stringify(vc),
          issued_at: Date.now(),
        };
      }

      // Self-attesting settlement (audit follow-up #1, delegation-v1
      // §6.4): the relay signs the canonical body so a worker (or any
      // auditor) can prove what was claimed without trusting the
      // relay's word about it. SettlementRecord wire format MUST carry
      // signature/suite/issuer_relay_id; the columns are persisted so
      // the audit-emission path can reconstruct + verify.
      //
      // CRITICAL: signSettlement is async (Ed25519 over canonical bytes).
      // Compute it OUTSIDE the synchronous BEGIN/COMMIT block — placing
      // an await inside the transaction lets concurrent receipts
      // interleave their transactions and corrupts INSERT-OR-IGNORE
      // semantics (caught by the money-loop-concurrency test on first
      // attempt; signed-but-uninserted settlements would silently drop).
      const signedSettlement =
        !isP2pTask && !isFederatedExecutor
          ? await signSettlement(
              {
                settlement_id: settlement.settlement_id,
                allocation_id: settlement.allocation_id,
                // Payee = the executing agent named on the receipt
                // (settleOnReceipt sets it to receipt.motebit_id).
                motebit_id: settlement.motebit_id,
                receipt_hash: settlement.receipt_hash,
                ledger_hash: settlement.ledger_hash,
                amount_settled: settlement.amount_settled,
                platform_fee: settlement.platform_fee,
                platform_fee_rate: settlement.platform_fee_rate,
                // !isP2pTask branch — runs only for Arc 3 carve-outs:
                // self-delegation (worker is the delegator, same-party),
                // zero-cost direct delegation (unit_cost = 0, no real
                // funds), or legacy non-P2P paths that pre-date the
                // TASK_P2P_PROOF_REQUIRED submission gate. Paid direct
                // delegation to a different worker can no longer reach
                // this branch — submission rejects without a
                // payment_proof. `settlement_mode: "relay"` here is the
                // documented carve-out; the structural enforcement is at
                // submission, not at this write site. See
                // `docs/doctrine/off-ramp-as-user-action.md` § "Arc 3
                // carve-outs".
                settlement_mode: "relay",
                status: settlement.status,
                settled_at: settlement.settled_at,
                ...(entry.x402_tx_hash != null ? { x402_tx_hash: entry.x402_tx_hash } : {}),
                ...(entry.x402_network != null ? { x402_network: entry.x402_network } : {}),
                issuer_relay_id: relayIdentity.relayMotebitId,
              },
              relayIdentity.privateKey,
            )
          : null;

      moteDb.db.exec("BEGIN");
      try {
        // Relay settlement: INSERT record + credit/refund virtual accounts.
        // P2P tasks skip this — their audit record was inserted above.
        if (!isP2pTask && signedSettlement != null) {
          moteDb.db
            .prepare(
              `INSERT OR IGNORE INTO relay_settlements
               (settlement_id, allocation_id, task_id, motebit_id, receipt_hash, ledger_hash, amount_settled, platform_fee, platform_fee_rate, status, settled_at, settlement_mode, x402_tx_hash, x402_network, issuer_relay_id, suite, signature, record_json)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              signedSettlement.settlement_id,
              signedSettlement.allocation_id,
              taskId,
              motebitId,
              signedSettlement.receipt_hash,
              signedSettlement.ledger_hash,
              signedSettlement.amount_settled,
              signedSettlement.platform_fee,
              signedSettlement.platform_fee_rate,
              signedSettlement.status,
              signedSettlement.settled_at,
              signedSettlement.settlement_mode,
              entry.x402_tx_hash ?? null,
              entry.x402_network ?? null,
              signedSettlement.issuer_relay_id,
              signedSettlement.suite,
              signedSettlement.signature,
              canonicalJson(signedSettlement),
            );

          if (persistentAlloc) {
            moteDb.db
              .prepare(
                "UPDATE relay_allocations SET status = 'settled', settled_at = ? WHERE task_id = ?",
              )
              .run(Date.now(), taskId);
          }

          {
            const workerMotebitId = receipt.motebit_id;

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

        if (isFederatedExecutor) {
          // No local settlement was written — record why for the audit trail.
          logger.info("settlement.federated_deferred", {
            correlationId: taskId,
            originRelay: entry.origin_relay,
            note: "settlement driven by originating relay via /federation/v1/settlement/forward",
          });
        } else {
          logger.info("settlement.created", {
            correlationId: taskId,
            gross: settlement.amount_settled + settlement.platform_fee,
            fee: settlement.platform_fee,
            net: settlement.amount_settled,
            x402TxHash: entry.x402_tx_hash ?? null,
          });
        }
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
        // Propagate the executing worker's public key to the origin relay. The
        // worker is registered HERE (the executor relay), not on the origin, so
        // without this the origin can't verify the worker's inner receipt
        // signature and falls back to trusting only our peer-envelope sig
        // (federation.receipt_key_missing). Carrying the key lets the origin
        // verify the receipt — and, for sovereign motebit_ids, verify the
        // key→motebit_id binding offline (no trust in us required).
        const workerReg = moteDb.db
          .prepare("SELECT public_key FROM agent_registry WHERE motebit_id = ?")
          .get(receipt.motebit_id) as { public_key: string | null } | undefined;
        const resultBody = {
          task_id: taskId,
          origin_relay: relayIdentity.relayMotebitId,
          receipt,
          ...(workerReg?.public_key ? { agent_public_key: workerReg.public_key } : {}),
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

  // Platform fee rate lives in this function's closure — every handler
  // registered below sees the same rate for its lifetime. No module-level
  // mutation; independent relay instances are fully isolated.
  const platformFeeRate = deps.platformFeeRate ?? SDK_DEFAULT_PLATFORM_FEE_RATE;

  const ingestionDeps = {
    moteDb,
    identityManager,
    eventStore,
    relayIdentity,
    connections,
    taskQueue,
    issueCredentials,
    platformFeeRate,
  };

  // Capture x402 settlement proof so the task handler can link it to the task queue entry.
  // Same single-threaded pattern as currentPricing — set by hook, read by handler, no interleaving.
  let lastSettleTxHash: string | undefined;
  let lastSettleNetwork: string | undefined;

  {
    const { paymentMiddlewareFromHTTPServer, x402HTTPResourceServer, x402ResourceServer } =
      await import("@x402/hono");
    const { ExactEvmScheme } = await import("@x402/evm/exact/server");
    // CDP-aware facilitator construction; throws X402ConfigError on mainnet
    // misconfiguration so the route registration fails fast rather than
    // silently leaving the x402 surface broken. See x402-facilitator.ts.
    const { createX402FacilitatorClient } = await import("./x402-facilitator.js");
    const facilitatorClient = (await createX402FacilitatorClient(
      x402Config,
    )) as ConstructorParameters<typeof x402ResourceServer>[0];

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
            const gross = computeGrossAmount(currentPricing.unitCost, platformFeeRate);
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
              platform_fee_rate: platformFeeRate,
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
          const grossMicro = toMicro(computeGrossAmount(currentPricing.unitCost, platformFeeRate));
          const account = getAccountBalance(moteDb.db, delegatorId);
          if (account && account.balance >= grossMicro) {
            return next();
          }
        }

        // P2P bypass: if the body contains payment_proof, money moved onchain — skip x402.
        // This check runs after balance check fails, so p2p is only used when
        // the delegator can't pay through virtual accounts.
        try {
          const buf2 = await c.req.raw.clone().arrayBuffer();
          const peekBody = JSON.parse(new TextDecoder().decode(buf2)) as {
            payment_proof?: unknown;
          };
          if (peekBody.payment_proof != null) {
            return next();
          }
        } catch {
          // Fall through to x402
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
              platform_fee_rate: platformFeeRate,
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
  /** @spec motebit/delegation@1.0 */
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
      /**
       * Invocation provenance discriminator — propagated to the task envelope
       * and, via the agent's receipt builder, onto the signed outer receipt.
       * See `IntentOrigin` in `@motebit/protocol` and
       * `docs/doctrine/surface-determinism.md`. Unknown values are rejected
       * (400) so that surface-determinism callers cannot typo past the gate.
       */
      invocation_origin?: "user-tap" | "ai-loop" | "scheduled" | "agent-to-agent";
      /** P2P: target agent for direct settlement (required with payment_proof). */
      target_agent?: string;
      /**
       * P2P bootstrap acknowledgment — Arc 3 of the off-ramp arc. When
       * set true, unlocks the eligibility gate's new-pair branch (no
       * trust history accumulated yet). The delegator consciously
       * accepts the cold-start risk; transactions accumulate real
       * trust into the graph for future routing decisions. Established
       * pairs (trust ≥ 0.6 + ≥5 interactions) don't need this — the
       * acknowledgment is ignored on the fast path. See
       * `docs/doctrine/off-ramp-as-user-action.md` § Arc 3 and the
       * `trust_as_economic_membrane` memory.
       */
      delegator_acknowledges_no_history_risk?: boolean;
      /** P2P: onchain payment proof (triggers p2p settlement mode). */
      payment_proof?: {
        tx_hash: string;
        chain: string;
        network: string;
        to_address: string;
        amount_micro: number;
        /**
         * Relay treasury Solana address (base58). Required after Arc 2
         * of the off-ramp arc — the delegator's atomic Solana tx
         * composes a fee leg sending `fee_amount_micro` to this
         * address. Discoverable via the relay's published public key
         * (`deriveSolanaAddress(relayPublicKey)`).
         */
        fee_to_address: string;
        /**
         * Fee leg amount in micro-units. Computed as
         * `gross - amount_micro` where `gross = amount_micro / (1 - feeRate)`.
         * For federated P2P this is the ORIGIN relay's (A's) fee leg.
         */
        fee_amount_micro: number;
        /**
         * Executor-relay (B) treasury address + fee leg. Present ONLY for
         * cross-operator federated P2P (delegation to a remote worker). The
         * delegator's atomic tx carries a THIRD leg → relay B's treasury.
         * See `P2pPaymentProof` in `@motebit/protocol` and
         * `docs/doctrine/off-ramp-as-user-action.md` § federated P2P.
         */
        b_fee_to_address?: string;
        b_fee_amount_micro?: number;
      };
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
    const VALID_INVOCATION_ORIGINS = [
      "user-tap",
      "ai-loop",
      "scheduled",
      "agent-to-agent",
    ] as const;
    if (
      body.invocation_origin != null &&
      !VALID_INVOCATION_ORIGINS.includes(body.invocation_origin)
    ) {
      throw new TaskError(
        "TASK_INVALID_INPUT",
        `invocation_origin must be one of: ${VALID_INVOCATION_ORIGINS.join(", ")}`,
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
      invocation_origin: body.invocation_origin,
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
        ? toMicro(computeGrossAmount(unitCostAtSubmission, platformFeeRate)) // gross in micro-units
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

    // === P2P settlement path ===
    let settlementMode: "relay" | "p2p" = "relay";
    let p2pPaymentProof: TaskQueueEntry["p2p_payment_proof"];
    // True when the proof targets a REMOTE worker (cross-operator federated
    // P2P): routing forwards directly to the worker's operator with the proof
    // rather than ranking. Set in the remote branch below.
    let federatedP2pIntent = false;

    if (body.payment_proof && body.target_agent && submittedBy) {
      const proof = body.payment_proof;

      // Validate proof completeness — after Arc 2 of the off-ramp arc,
      // the fee leg fields are required (delegator's atomic tx carries
      // both worker and treasury legs).
      if (
        !proof.tx_hash ||
        !proof.chain ||
        !proof.network ||
        !proof.to_address ||
        !proof.amount_micro ||
        !proof.fee_to_address ||
        proof.fee_amount_micro == null
      ) {
        throw new TaskError(
          "TASK_INVALID_INPUT",
          "Incomplete payment_proof fields (after Arc 2: tx_hash, chain, network, to_address, amount_micro, fee_to_address, fee_amount_micro are all required)",
          400,
        );
      }

      // Tx hash format (Solana signatures are 87-88 char base58)
      if (!/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(proof.tx_hash)) {
        throw new TaskError("TASK_INVALID_INPUT", "Invalid transaction signature format", 400);
      }

      // Proof-replay guard: one onchain payment funds exactly one task. Reject a
      // tx_hash that has ALREADY settled a task on this relay — otherwise a
      // delegator could reuse one payment across many tasks (each a fresh
      // task_id, which the (task_id, *) unique indexes don't catch), getting N
      // workers to execute for ONE payment. Rejecting at SUBMISSION means the
      // worker never does replayed work; the partial UNIQUE index on
      // relay_settlements(p2p_tx_hash) (migration v30) is the structural
      // backstop that also closes the concurrent-submission race. A paid task
      // that was NOT settled (e.g. a federated forward that failed) has no
      // settlement row, so resubmitting the same proof to retry is still
      // allowed — only a SETTLED proof counts as replay.
      const alreadySettled = moteDb.db
        .prepare("SELECT 1 FROM relay_settlements WHERE p2p_tx_hash = ? LIMIT 1")
        .get(proof.tx_hash);
      if (alreadySettled) {
        throw new TaskError(
          "TASK_P2P_PROOF_REPLAYED",
          "This payment proof (tx_hash) has already settled a task — each onchain payment funds exactly one task",
          409,
        );
      }

      // Is the target worker LOCAL to this relay? A local worker has a
      // settlement_address in our agent_registry. A REMOTE worker (hosted
      // on a peer operator, discovered via federation) does not — that is
      // the cross-operator federated P2P path, which carries a third
      // (executor-relay) fee leg and is validated at the forward site
      // (where the worker's address + the peer relay's treasury resolve
      // via discovery). See docs/doctrine/off-ramp-as-user-action.md
      // § federated P2P.
      const workerReg = moteDb.db
        .prepare("SELECT settlement_address FROM agent_registry WHERE motebit_id = ?")
        .get(body.target_agent) as { settlement_address: string | null } | undefined;

      if (workerReg?.settlement_address) {
        // ── Single-operator P2P (local worker): the existing 2-leg path. ──
        // Policy-based eligibility check
        // Arc 3: pass the delegator's cold-start acknowledgment through to
        // the eligibility gate. Established pairs ignore it; new pairs
        // require it set true to unlock the bootstrap branch.
        const eligibility = await evaluateSettlementEligibility(
          moteDb.db,
          submittedBy,
          body.target_agent,
          body.delegator_acknowledges_no_history_risk === true,
        );
        if (!eligibility.allowed) {
          throw new TaskError("TASK_P2P_INELIGIBLE", eligibility.reason, 403);
        }

        // Verify worker's settlement address matches payment proof
        if (proof.to_address !== workerReg.settlement_address) {
          throw new TaskError(
            "TASK_P2P_ADDRESS_MISMATCH",
            "Payment proof to_address does not match worker's settlement address",
            400,
          );
        }

        // Verify fee leg's treasury address matches the relay's
        // identity-derived Solana address. The relay treasury IS the
        // relay's identity key — same address that funds
        // OperatorSolanaTransfer and SolanaMemoSubmitter. Mismatch means
        // the delegator sent the fee leg to a non-relay address — reject.
        const { deriveSolanaAddress } = await import("@motebit/wallet-solana");
        const relayTreasuryAddress = deriveSolanaAddress(relayIdentity.publicKey);
        if (proof.fee_to_address !== relayTreasuryAddress) {
          throw new TaskError(
            "TASK_P2P_FEE_ADDRESS_MISMATCH",
            `Payment proof fee_to_address does not match relay treasury address`,
            400,
          );
        }

        // Exact amount match against the worker's unit cost. The worker
        // earns net = unit_cost; the fee = gross - unit_cost where
        // gross = unit_cost / (1 - platformFeeRate). The delegator's
        // atomic tx pays both.
        const unitCostMicro = unitCostAtSubmission > 0 ? toMicro(unitCostAtSubmission) : undefined;
        if (unitCostMicro != null && proof.amount_micro !== unitCostMicro) {
          throw new TaskError(
            "TASK_P2P_AMOUNT_MISMATCH",
            `Payment amount ${proof.amount_micro} does not match expected ${priceSnapshot}`,
            400,
          );
        }

        // Fee amount must match the expected platform_fee given the
        // worker's unit_cost and the current platform_fee_rate. Computed
        // as `gross - net` where `gross = round(net / (1 - feeRate))`.
        if (unitCostMicro != null && platformFeeRate > 0) {
          const grossMicro = Math.round(unitCostMicro / (1 - platformFeeRate));
          const expectedFeeMicro = grossMicro - unitCostMicro;
          if (proof.fee_amount_micro !== expectedFeeMicro) {
            throw new TaskError(
              "TASK_P2P_FEE_AMOUNT_MISMATCH",
              `Payment fee_amount_micro ${proof.fee_amount_micro} does not match expected ${expectedFeeMicro} (gross ${grossMicro} - net ${unitCostMicro})`,
              400,
            );
          }
        }

        settlementMode = "p2p";
        p2pPaymentProof = proof;

        logger.info("task.p2p_settlement", {
          correlationId: taskId,
          delegator: submittedBy,
          worker: body.target_agent,
          txHash: proof.tx_hash,
          amount: proof.amount_micro,
          reason: eligibility.reason,
        });
      } else {
        // ── Cross-operator federated P2P (remote worker): the 3-leg path. ──
        // The delegator client did federated discovery (P-A surfaces the
        // remote worker's settlement_address), built a single atomic Solana
        // tx with three legs — worker net, origin-relay (A) fee, executor-
        // relay (B) fee — and pinned the worker via `target_agent`. The
        // relay NEVER transmits funds cross-operator: the delegator pays
        // all three legs directly, both relays coordinate + verify only.
        //
        // Full leg validation (addresses + amounts vs the discovered
        // candidate + the peer relay's treasury) happens at the forward
        // site, where discovery has resolved the worker and the hosting
        // peer. Here we require the inputs that path needs.
        if ((task.required_capabilities ?? []).length === 0) {
          throw new TaskError(
            "TASK_P2P_NO_ADDRESS",
            "Federated P2P delegation to a remote worker requires required_capabilities (to locate the worker on its operator)",
            400,
          );
        }
        if (!proof.b_fee_to_address || proof.b_fee_amount_micro == null) {
          throw new TaskError(
            "TASK_INVALID_INPUT",
            "Federated P2P payment_proof requires the executor-relay fee leg (b_fee_to_address, b_fee_amount_micro)",
            400,
          );
        }

        settlementMode = "p2p";
        p2pPaymentProof = proof;
        federatedP2pIntent = true;

        logger.info("task.federated_p2p_pending", {
          correlationId: taskId,
          delegator: submittedBy,
          worker: body.target_agent,
          txHash: proof.tx_hash,
        });
      }
    }

    // === Arc 3.5: P2P-by-default submission gate ===
    // Paid direct delegation to a different worker MUST settle P2P. The
    // predicate is the pure, unit-tested `requiresP2pProof` (truth table in
    // arc-3.5-gate.test.ts). True submission carve-outs (do not reach the gate):
    // zero-cost (`unitCostAtSubmission === 0`), self-delegation
    // (`submittedBy === motebitId`), x402-paid (own onchain proof). Multi-hop is
    // NOT a carve-out — a paid sub-delegation (B→C) is a real `POST /agent/C/task`
    // submission and is gated like any direct delegation; only the
    // `settleSubReceipt` relay-write (~665) is a deferred residual. See
    // off-ramp-as-user-action.md § "Arc 3.5".
    if (
      requiresP2pProof({
        settlementMode,
        x402TxHash,
        unitCostAtSubmission,
        submittedBy,
        workerId: motebitId,
      })
    ) {
      throw new TaskError(
        "TASK_P2P_PROOF_REQUIRED",
        "Paid direct delegation requires a P2P payment_proof: the delegator settles the worker and platform fee onchain in one atomic transaction. Deposit-funded relay-custody settlement is closed for this flow. See off-ramp-as-user-action.md.",
        402,
      );
    }

    taskQueue.set(taskId, {
      task,
      expiresAt: now + TASK_TTL_MS,
      submitted_by: submittedBy,
      price_snapshot: priceSnapshot,
      x402_tx_hash: x402TxHash,
      x402_network: x402Net,
      settlement_mode: settlementMode,
      p2p_payment_proof: p2pPaymentProof,
      target_agent: body.target_agent,
    });

    logger.info("task.submitted", {
      correlationId: taskId,
      taskId,
      motebitId,
      capabilities: task.required_capabilities ?? [],
      invocationOrigin: task.invocation_origin,
    });

    // Persist budget allocation so settlement can verify the lock exists.
    // P2P tasks skip allocation — money already moved onchain.
    if (settlementMode !== "p2p" && priceSnapshot != null && priceSnapshot > 0) {
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
            ? multiCapProfiles.filter((p) => !excludeSet.has(p.motebit_id))
            : multiCapProfiles;

        // Phase 4: Fetch federated candidates from active peer relays (best-effort, non-blocking)
        let federatedCandidates: {
          profile: CandidateProfile;
          _source_relay_endpoint: string;
          _settlement_address: string | null;
        }[] = [];
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
            if (!excludeSet.has(fc.profile.motebit_id)) {
              remoteAgentRelay.set(fc.profile.motebit_id, fc._source_relay_endpoint);
            }
          }
        } catch {
          // Federation candidate fetch is best-effort — don't block local routing
        }

        // Merge local and federated candidates before ranking
        const federatedProfiles = federatedCandidates
          .filter((fc) => !excludeSet.has(fc.profile.motebit_id))
          .map((fc) => fc.profile);
        const allProfiles = [...eligibleProfiles, ...federatedProfiles];

        if (federatedP2pIntent) {
          // ── Cross-operator federated P2P: forward directly to the pinned
          // remote worker WITH the delegator's 3-leg proof. No ranking — the
          // delegator already discovered + paid this worker onchain. The relay
          // validates the three legs against the discovered worker address +
          // both operator treasuries, then forwards. It NEVER transmits funds
          // cross-operator; the delegator paid all legs in one atomic tx.
          // Doctrine: docs/doctrine/off-ramp-as-user-action.md § federated P2P.
          const proof = p2pPaymentProof!;
          const targetId = body.target_agent!;
          const fc = federatedCandidates.find((c) => c.profile.motebit_id === targetId);
          if (fc == null || !remoteAgentRelay.has(targetId)) {
            throw new HTTPException(404, {
              message:
                "Pinned remote worker not discoverable on any active peer — cannot place the paid federated task",
            });
          }
          const peerEndpoint = remoteAgentRelay.get(targetId)!;
          const workerAddr = fc._settlement_address;
          const fedPrice = fc.profile.listing?.pricing.find((p) =>
            (requiredCaps as readonly string[]).includes(p.capability),
          );
          if (!workerAddr) {
            throw new HTTPException(400, {
              message: "Discovered remote worker has no settlement_address",
            });
          }
          if (fedPrice == null || fedPrice.unit_cost <= 0) {
            throw new HTTPException(400, {
              message: "Remote worker has no priced listing for the requested capability",
            });
          }

          // Fee-from-budget split (spec relay-federation-v1 §7.1): the listed
          // unit_cost IS the chain budget. A takes 5% of the budget, forwards
          // the remainder; B takes 5% of that; the worker nets the rest.
          // $1.00 → A $0.05 / B $0.0475 / worker $0.9025.
          const budgetMicro = toMicro(fedPrice.unit_cost);
          const aFeeMicro = Math.round(budgetMicro * platformFeeRate);
          const forwardedMicro = budgetMicro - aFeeMicro;
          const bFeeMicro = Math.round(forwardedMicro * platformFeeRate);
          const workerNetMicro = forwardedMicro - bFeeMicro;

          // Resolve treasuries: A = our identity-derived Solana address; B = the
          // hosting peer's relay-identity-derived address (relay_peers.public_key).
          const { deriveSolanaAddress } = await import("@motebit/wallet-solana");
          const aTreasury = deriveSolanaAddress(relayIdentity.publicKey);
          const peerRow = moteDb.db
            .prepare(
              "SELECT public_key FROM relay_peers WHERE endpoint_url = ? AND state = 'active'",
            )
            .get(peerEndpoint) as { public_key: string } | undefined;
          if (!peerRow?.public_key) {
            throw new HTTPException(400, {
              message: "Cannot resolve executor relay treasury (peer public key missing)",
            });
          }
          const bTreasury = deriveSolanaAddress(hexToBytes(peerRow.public_key));

          // Validate all three legs of the delegator's atomic tx against the
          // resolved addresses + the deterministic fee split. Any mismatch is
          // a fail-closed reject — the relay forwards only a proof it can stand
          // behind (and that the executor relay will independently re-verify).
          const legErr =
            proof.to_address !== workerAddr
              ? "worker leg address"
              : proof.amount_micro !== workerNetMicro
                ? `worker leg amount (${proof.amount_micro} ≠ ${workerNetMicro})`
                : proof.fee_to_address !== aTreasury
                  ? "origin-fee leg address"
                  : proof.fee_amount_micro !== aFeeMicro
                    ? `origin-fee leg amount (${proof.fee_amount_micro} ≠ ${aFeeMicro})`
                    : proof.b_fee_to_address !== bTreasury
                      ? "executor-fee leg address"
                      : proof.b_fee_amount_micro !== bFeeMicro
                        ? `executor-fee leg amount (${proof.b_fee_amount_micro} ≠ ${bFeeMicro})`
                        : null;
          if (legErr) {
            throw new HTTPException(400, {
              message: `Federated P2P payment_proof leg mismatch: ${legErr}`,
            });
          }
          // Conservation: the three legs sum to the budget exactly.
          if (workerNetMicro + aFeeMicro + bFeeMicro !== budgetMicro) {
            throw new HTTPException(500, { message: "Fee split does not conserve budget" });
          }

          // Stamp A's price_snapshot (the budget) so onTaskResultReceived has
          // the amounts for A's p2p audit row. taskQueue is SQLite-backed —
          // mutate then set() (a get() result alone does not persist).
          const p2pEntry = taskQueue.get(taskId);
          if (p2pEntry) {
            p2pEntry.price_snapshot = budgetMicro;
            taskQueue.set(taskId, p2pEntry);
          }

          if (!taskRouter.canForward(peerEndpoint)) {
            throw new HTTPException(503, {
              message: "Executor relay temporarily unavailable (circuit open) — retry shortly",
            });
          }

          federationAttempted = true;
          routingChoice = {
            selected_agent: targetId,
            composite_score: 1,
            sub_scores: {},
            routing_paths: [],
            alternatives_considered: 0,
          };

          const forwardBody = {
            task_id: taskId,
            origin_relay: relayIdentity.relayMotebitId,
            target_agent: targetId,
            task_payload: {
              prompt: body.prompt,
              required_capabilities: requiredCaps,
              submitted_by: submittedBy,
              wall_clock_ms: body.wall_clock_ms,
            },
            // The proof rides the SIGNED forward body — the executor relay
            // verifies A's signature over canonicalJson(body), so the proof is
            // integrity-protected peer-to-peer (no separate channel).
            payment_proof: proof,
            routing_choice: routingChoice,
            timestamp: Date.now(),
          };
          const forwardBytes = new TextEncoder().encode(canonicalJson(forwardBody));
          const forwardSig = await sign(forwardBytes, relayIdentity.privateKey);
          try {
            const resp = await fetch(`${peerEndpoint}/federation/v1/task/forward`, {
              method: "POST",
              headers: { "Content-Type": "application/json", "X-Correlation-ID": taskId },
              body: JSON.stringify({ ...forwardBody, signature: bytesToHex(forwardSig) }),
              signal: AbortSignal.timeout(10000),
            });
            if (resp.ok) {
              routed = true;
              taskRouter.recordPeerForwardResult(peerEndpoint, true);
              logger.info("task.federated_p2p_forwarded", {
                correlationId: taskId,
                peerRelay: peerEndpoint,
                targetAgent: targetId,
                workerNetMicro,
                aFeeMicro,
                bFeeMicro,
              });
            } else {
              taskRouter.recordPeerForwardResult(peerEndpoint, false);
              // The task did not settle (no result came back), so no settlement
              // row exists for this proof — the delegator may resubmit the SAME
              // payment_proof to retry without re-paying (the replay guard keys
              // on settled proofs, not attempted ones).
              throw new HTTPException(502, {
                message: `Executor relay rejected the forwarded task (HTTP ${resp.status}) — retryable: resubmit the same payment_proof`,
              });
            }
          } catch (fwdErr) {
            if (fwdErr instanceof HTTPException) throw fwdErr;
            taskRouter.recordPeerForwardResult(peerEndpoint, false);
            logger.warn("task.federated_p2p_forward_failed", {
              correlationId: taskId,
              peerRelay: peerEndpoint,
              targetAgent: targetId,
              error: fwdErr instanceof Error ? fwdErr.message : String(fwdErr),
            });
            throw new HTTPException(502, {
              message:
                "Failed to forward federated P2P task to the executor relay — retryable: resubmit the same payment_proof",
            });
          }
        } else if (allProfiles.length > 0) {
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
              selected_agent: topScore.motebit_id,
              composite_score: topScore.composite,
              sub_scores: topScore.sub_scores,
              routing_paths: topScore.routing_paths,
              alternatives_considered: topScore.alternatives_considered,
            };

            // A task forwards to at most ONE federated relay: fanning one task
            // out to multiple relays means multiple workers execute it. Local
            // fan-out below is unaffected.
            let federatedForwarded = false;

            // Route to selected agents — local via WebSocket, remote via federation forward
            for (const sel of selected) {
              const selId = sel.motebit_id;
              if (remoteAgentRelay.has(selId)) {
                // Remote agent: forward task to peer relay
                if (federatedForwarded) continue;
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
                federatedForwarded = true;

                // PAID federated delegation now requires a 3-leg P2P proof
                // (delegator pays worker + both operator treasuries onchain in
                // one atomic tx; the relay never custodies cross-operator
                // funds). That path is the dedicated `federatedP2pIntent` branch
                // above — it forwards directly to the pinned worker. Reaching
                // THIS ranking-path branch with a priced federated candidate
                // means the submitter did not supply target_agent + payment_proof
                // → reject. This REPLACES PR1's relay-custody hold; the migration
                // window is closed in the same change (no free-forward gap, no
                // relay-custody charge). FREE federated tasks (no price) still
                // forward here without proof or charge.
                const fedProfile = federatedCandidates.find(
                  (fc) => fc.profile.motebit_id === selId,
                )?.profile;
                const fedPrice = fedProfile?.listing?.pricing.find((p) =>
                  (requiredCaps as readonly string[]).includes(p.capability),
                );
                if (fedPrice != null && fedPrice.unit_cost > 0) {
                  // The routing catch rethrows HTTPException (see "Re-throw
                  // intentional HTTP errors" below) → surfaces as 402.
                  throw new HTTPException(402, {
                    message:
                      "Paid federated delegation requires a 3-leg P2P payment_proof (submit with target_agent + payment_proof). Deposit-funded cross-operator settlement is closed. See off-ramp-as-user-action.md.",
                  });
                }

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
  /** @spec motebit/delegation@1.0 */
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
  /** @spec motebit/delegation@1.0 */
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

    const rawBody: unknown = await c.req.json().catch(() => null);
    const parsedReceipt = ExecutionReceiptSchema.safeParse(rawBody);
    if (!parsedReceipt.success) {
      return c.json({ error: parsedReceipt.error.flatten() }, 400);
    }
    const receipt = parsedReceipt.data as unknown as ExecutionReceipt;

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
        motebitId: receipt.motebit_id,
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
