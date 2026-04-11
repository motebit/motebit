/**
 * P2P payment verifier — async onchain verification of direct settlement proofs.
 *
 * Phase 3 of p2p settlement: verifies pending payment proofs against Solana RPC,
 * downgrades trust on failure, and provides admin reporting by settlement mode.
 *
 * Background loop pattern matches startCredentialAnchorLoop.
 */
import type { DatabaseDriver } from "@motebit/persistence";
import { createLogger } from "./logger.js";

const logger = createLogger({ service: "relay", module: "p2p-verifier" });

// === Constants ===

/** How often to check for unverified p2p payments. */
const VERIFY_INTERVAL_MS = 60_000; // 1 minute
/** Maximum pending proofs to verify per cycle. */
const MAX_VERIFY_PER_CYCLE = 20;
/** How long to wait for RPC response. */
const RPC_TIMEOUT_MS = 10_000;

// === Verification Loop ===

export interface P2pVerifierConfig {
  /** Solana RPC URL (e.g., from SOLANA_RPC_URL env). */
  rpcUrl: string;
  /** Override check interval (default: 60s). */
  intervalMs?: number;
  /** Override max proofs per cycle (default: 20). */
  maxPerCycle?: number;
}

/**
 * Start the async p2p payment verification loop.
 *
 * Polls relay_settlements for settlement_mode='p2p' AND payment_verification_status='pending',
 * fetches the Solana transaction via RPC, and transitions to 'verified' or 'failed'.
 *
 * On failure: downgrades trust between the delegator and worker pair,
 * removing their p2p eligibility.
 */
export function startP2pVerifierLoop(
  db: DatabaseDriver,
  config: P2pVerifierConfig,
  isFrozen?: () => boolean,
): ReturnType<typeof setInterval> {
  const intervalMs = config.intervalMs ?? VERIFY_INTERVAL_MS;
  const maxPerCycle = config.maxPerCycle ?? MAX_VERIFY_PER_CYCLE;

  return setInterval(() => {
    if (isFrozen?.()) return;

    void (async () => {
      try {
        const pendingRows = db
          .prepare(
            `SELECT settlement_id, task_id, motebit_id, p2p_tx_hash
             FROM relay_settlements
             WHERE settlement_mode = 'p2p'
               AND payment_verification_status = 'pending'
               AND p2p_tx_hash IS NOT NULL
             ORDER BY settled_at ASC
             LIMIT ?`,
          )
          .all(maxPerCycle) as Array<{
          settlement_id: string;
          task_id: string;
          motebit_id: string;
          p2p_tx_hash: string;
        }>;

        if (pendingRows.length === 0) return;

        for (const row of pendingRows) {
          try {
            const verified = await verifyTransactionOnChain(config.rpcUrl, row.p2p_tx_hash);

            if (verified) {
              db.prepare(
                `UPDATE relay_settlements
                 SET payment_verification_status = 'verified', payment_verified_at = ?
                 WHERE settlement_id = ?`,
              ).run(Date.now(), row.settlement_id);

              logger.info("p2p_verifier.verified", {
                settlementId: row.settlement_id,
                txHash: row.p2p_tx_hash,
              });
            } else {
              const error = "Transaction not found or not confirmed on Solana";
              db.prepare(
                `UPDATE relay_settlements
                 SET payment_verification_status = 'failed',
                     payment_verified_at = ?,
                     payment_verification_error = ?
                 WHERE settlement_id = ?`,
              ).run(Date.now(), error, row.settlement_id);

              logger.warn("p2p_verifier.failed", {
                settlementId: row.settlement_id,
                txHash: row.p2p_tx_hash,
                error,
              });

              // Rail downgrade: increase failed_tasks for the delegator→worker pair
              downgradeP2pTrust(db, row.task_id, row.motebit_id);
            }
          } catch (err) {
            logger.error("p2p_verifier.check_error", {
              settlementId: row.settlement_id,
              txHash: row.p2p_tx_hash,
              error: err instanceof Error ? err.message : String(err),
            });
            // Don't mark as failed on RPC errors — retry next cycle
          }
        }
      } catch (err) {
        logger.error("p2p_verifier.loop_error", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })();
  }, intervalMs);
}

// === Onchain Verification ===

/**
 * Verify a Solana transaction exists and is confirmed via RPC.
 * Uses getTransaction with confirmed commitment.
 */
async function verifyTransactionOnChain(rpcUrl: string, txHash: string): Promise<boolean> {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "getTransaction",
    params: [
      txHash,
      { encoding: "json", commitment: "confirmed", maxSupportedTransactionVersion: 0 },
    ],
  });

  const resp = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
  });

  if (!resp.ok) return false;

  const data = (await resp.json()) as { result: unknown | null; error?: unknown };
  // result is null if transaction not found
  return data.result != null;
}

// === Trust Downgrade on Failed Verification ===

/**
 * Downgrade trust between the delegator and worker when p2p payment
 * verification fails. Increments failed_tasks, which triggers automatic
 * trust demotion via evaluateTrustTransition at the next interaction.
 *
 * Also removes p2p from the delegator's settlement_modes to force
 * relay-mediated settlement for future tasks.
 */
function downgradeP2pTrust(db: DatabaseDriver, taskId: string, workerId: string): void {
  // Find the delegator from the task's submitted_by
  // The task queue is in-memory, but the settlement has task_id.
  // Look up the allocation to find the delegator, or check relay_transactions.
  try {
    const settlement = db
      .prepare(
        "SELECT allocation_id FROM relay_settlements WHERE task_id = ? AND settlement_mode = 'p2p'",
      )
      .get(taskId) as { allocation_id: string } | undefined;

    if (!settlement) return;

    // For p2p tasks, the allocation_id is "p2p-{taskId}". The delegator
    // submitted the task. Find via relay_transactions referencing the task.
    const txn = db
      .prepare(
        `SELECT motebit_id FROM relay_transactions
         WHERE reference_id LIKE ? AND type = 'deposit'
         LIMIT 1`,
      )
      .get(`%${taskId}%`) as { motebit_id: string } | undefined;

    // If we can't find the delegator, just log and return.
    // The verification failure is already recorded in relay_settlements.
    if (!txn) {
      logger.warn("p2p_verifier.downgrade_no_delegator", { taskId, workerId });
      return;
    }

    const delegatorId = txn.motebit_id;

    // Increment failed_tasks in the trust record
    db.prepare(
      `UPDATE agent_trust
       SET failed_tasks = COALESCE(failed_tasks, 0) + 1,
           last_seen_at = ?
       WHERE motebit_id = ? AND remote_motebit_id = ?`,
    ).run(Date.now(), delegatorId, workerId);

    // Remove p2p from delegator's settlement_modes (force relay for this agent)
    const delegator = db
      .prepare("SELECT settlement_modes FROM agent_registry WHERE motebit_id = ?")
      .get(delegatorId) as { settlement_modes: string | null } | undefined;

    if (delegator?.settlement_modes?.includes("p2p")) {
      const newModes =
        delegator.settlement_modes
          .split(",")
          .filter((m) => m !== "p2p")
          .join(",") || "relay";
      db.prepare("UPDATE agent_registry SET settlement_modes = ? WHERE motebit_id = ?").run(
        newModes,
        delegatorId,
      );
    }

    logger.info("p2p_verifier.trust_downgraded", {
      delegatorId,
      workerId,
      taskId,
    });
  } catch (err) {
    logger.error("p2p_verifier.downgrade_error", {
      taskId,
      workerId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// === Admin Reporting ===

/** Settlement statistics grouped by mode. */
export interface SettlementModeStats {
  mode: string;
  count: number;
  total_settled: number;
  total_fees: number;
  verified_count: number;
  pending_count: number;
  failed_count: number;
}

/**
 * Get settlement statistics grouped by settlement_mode.
 * Used by the admin dashboard.
 */
export function getSettlementStatsByMode(db: DatabaseDriver): SettlementModeStats[] {
  try {
    return db
      .prepare(
        `SELECT
           COALESCE(settlement_mode, 'relay') as mode,
           COUNT(*) as count,
           COALESCE(SUM(amount_settled), 0) as total_settled,
           COALESCE(SUM(platform_fee), 0) as total_fees,
           COUNT(CASE WHEN payment_verification_status = 'verified' THEN 1 END) as verified_count,
           COUNT(CASE WHEN payment_verification_status = 'pending' THEN 1 END) as pending_count,
           COUNT(CASE WHEN payment_verification_status = 'failed' THEN 1 END) as failed_count
         FROM relay_settlements
         GROUP BY COALESCE(settlement_mode, 'relay')
         ORDER BY count DESC`,
      )
      .all() as SettlementModeStats[];
  } catch {
    return [];
  }
}

/**
 * Get recent p2p settlements with verification status.
 * Used by the admin dashboard.
 */
export function getRecentP2pSettlements(
  db: DatabaseDriver,
  limit: number = 50,
): Array<Record<string, unknown>> {
  try {
    return db
      .prepare(
        `SELECT settlement_id, task_id, motebit_id, p2p_tx_hash,
                payment_verification_status, payment_verified_at,
                payment_verification_error, settled_at
         FROM relay_settlements
         WHERE settlement_mode = 'p2p'
         ORDER BY settled_at DESC
         LIMIT ?`,
      )
      .all(limit) as Array<Record<string, unknown>>;
  } catch {
    return [];
  }
}
