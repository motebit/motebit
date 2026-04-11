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
            const result = await verifyTransactionOnChain(config.rpcUrl, row.p2p_tx_hash);

            switch (result) {
              case "verified":
                db.prepare(
                  `UPDATE relay_settlements
                   SET payment_verification_status = 'verified', payment_verified_at = ?
                   WHERE settlement_id = ?`,
                ).run(Date.now(), row.settlement_id);
                logger.info("p2p_verifier.verified", {
                  settlementId: row.settlement_id,
                  txHash: row.p2p_tx_hash,
                });
                break;

              case "not_found": {
                const error = "Transaction not found on Solana";
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
                downgradeP2pTrust(db, row.task_id, row.motebit_id);
                break;
              }

              case "rpc_error":
                // Transient — do NOT mark as failed, do NOT downgrade trust. Retry next cycle.
                logger.warn("p2p_verifier.rpc_error", {
                  settlementId: row.settlement_id,
                  txHash: row.p2p_tx_hash,
                });
                break;
            }
          } catch (err) {
            logger.error("p2p_verifier.check_error", {
              settlementId: row.settlement_id,
              txHash: row.p2p_tx_hash,
              error: err instanceof Error ? err.message : String(err),
            });
            // Network errors — retry next cycle, never downgrade
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

/** Three-state verification result: verified, not_found, or rpc_error. */
type VerifyResult = "verified" | "not_found" | "rpc_error";

/**
 * Verify a Solana transaction exists and is confirmed via RPC.
 *
 * Returns three states — not two:
 * - "verified": transaction exists and is confirmed
 * - "not_found": transaction does not exist (permanent)
 * - "rpc_error": transient RPC failure (retry next cycle, never downgrade trust)
 */
async function verifyTransactionOnChain(rpcUrl: string, txHash: string): Promise<VerifyResult> {
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

  if (!resp.ok) return "rpc_error";

  const data = (await resp.json()) as { result: unknown; error?: unknown };

  // JSON-RPC error (timeout, rate limit, internal error) — transient, retry
  if (data.error != null) return "rpc_error";

  // result is null only when the transaction genuinely doesn't exist
  return data.result != null ? "verified" : "not_found";
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
  try {
    // Exact lookup via delegator_id column on the settlement record
    const settlement = db
      .prepare(
        "SELECT delegator_id FROM relay_settlements WHERE task_id = ? AND settlement_mode = 'p2p'",
      )
      .get(taskId) as { delegator_id: string | null } | undefined;

    if (!settlement?.delegator_id) {
      logger.warn("p2p_verifier.downgrade_no_delegator", { taskId, workerId });
      return;
    }

    const delegatorId = settlement.delegator_id;

    // Increment failed_tasks in the trust record (#9: assert existence)
    const updateResult = db
      .prepare(
        `UPDATE agent_trust
         SET failed_tasks = COALESCE(failed_tasks, 0) + 1,
             last_seen_at = ?
         WHERE motebit_id = ? AND remote_motebit_id = ?`,
      )
      .run(Date.now(), delegatorId, workerId) as { changes: number };

    if (updateResult.changes === 0) {
      logger.warn("p2p_verifier.downgrade_no_trust_record", { delegatorId, workerId, taskId });
    }

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
