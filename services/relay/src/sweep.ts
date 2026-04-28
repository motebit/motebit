/**
 * Auto-sweep — moves excess relay virtual account balance to the agent's
 * sovereign wallet (declared settlement_address).
 *
 * The sweep proves the relay is a utility, not a jail. If the agent's money
 * automatically flows to its own wallet, the relay can't hold it hostage.
 *
 * Pattern: follows startCredentialAnchorLoop (setInterval, emergency freeze
 * check, try-catch, structured logging).
 *
 * Two paths, one invariant (virtual balance debited at claim time):
 *   - Legacy: `requestWithdrawal(...)` creates a `relay_withdrawals` row that
 *     the admin fires manually via /api/v1/admin/withdrawals/*.
 *   - Aggregated: `enqueuePendingWithdrawal(...)` parks the item in
 *     `relay_pending_withdrawals`; a batch worker evaluates the per-rail
 *     policy and fires when justified. Opt-in via `sweepRail` config —
 *     unset keeps the legacy path, preserving behavior on existing deploys.
 */

import type { DatabaseDriver } from "@motebit/persistence";
import { computeDisputeWindowHold, requestWithdrawal } from "./accounts.js";
import { enqueuePendingWithdrawal } from "./batch-withdrawals.js";
import { createLogger } from "./logger.js";

const logger = createLogger({ service: "relay", module: "sweep" });

/** Minimum sweep amount to avoid dust transactions (1 USD = 1_000_000 micro). */
const MIN_SWEEP_AMOUNT = 1_000_000;

/** Default sweep check interval: 5 minutes. */
const DEFAULT_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

export interface SweepConfig {
  /** How often to check for sweepable balances (ms). Default: 300_000. */
  intervalMs?: number;
  /** Minimum sweep amount in micro-units. Default: 1_000_000 (1 USD). */
  minSweepAmount?: number;
  /**
   * When set, the sweep routes eligible balances through the aggregated
   * pending-withdrawal queue (spec/settlement-v1.md §11.2). The string is
   * the GuestRail.name that will fire the eventual batch. When unset,
   * the sweep keeps the legacy immediate-admin-complete path so existing
   * deploys see no behavior change on upgrade.
   */
  sweepRail?: string;
}

interface SweepableAgent {
  motebit_id: string;
  balance: number;
  settlement_address: string;
  sweep_threshold: number;
}

/**
 * Start the auto-sweep background loop.
 *
 * On each tick:
 * 1. Find agents with balance > sweep_threshold AND a declared settlement_address
 * 2. For each, compute available_for_withdrawal (respects dispute window hold)
 * 3. If available - sweep_threshold >= minSweepAmount, request a withdrawal
 *    for the excess to the agent's settlement_address
 */
export function startSweepLoop(
  db: DatabaseDriver,
  config: SweepConfig = {},
  isFrozen?: () => boolean,
): ReturnType<typeof setInterval> {
  const intervalMs = config.intervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
  const minSweep = config.minSweepAmount ?? MIN_SWEEP_AMOUNT;
  const sweepRail = config.sweepRail;

  return setInterval(() => {
    if (isFrozen?.()) return;

    void (() => {
      try {
        // Find agents eligible for sweep:
        // - Has a sweep_threshold configured (not null)
        // - Has a settlement_address declared
        // - Current balance exceeds sweep_threshold
        // - Not revoked
        const candidates = db
          .prepare(
            `SELECT a.motebit_id, r.balance, a.settlement_address, a.sweep_threshold
             FROM agent_registry a
             JOIN relay_accounts r ON r.motebit_id = a.motebit_id
             WHERE a.sweep_threshold IS NOT NULL
               AND a.settlement_address IS NOT NULL
               AND a.revoked = 0
               AND r.balance > a.sweep_threshold`,
          )
          .all() as SweepableAgent[];

        if (candidates.length === 0) return;

        let swept = 0;
        let totalAmount = 0;

        for (const agent of candidates) {
          try {
            // Compute available balance (respects dispute window hold)
            const disputeHold = computeDisputeWindowHold(db, agent.motebit_id);
            const available = Math.max(0, agent.balance - disputeHold);

            // Sweep amount = available - threshold (keep threshold as reserve)
            const sweepAmount = available - agent.sweep_threshold;
            if (sweepAmount < minSweep) continue;

            // Route to the aggregation queue when the deploy opted in;
            // otherwise preserve the legacy immediate-admin-complete path.
            if (sweepRail != null) {
              const pendingId = enqueuePendingWithdrawal(db, {
                motebitId: agent.motebit_id,
                amountMicro: sweepAmount,
                destination: agent.settlement_address,
                rail: sweepRail,
                source: "sweep",
              });
              if (pendingId != null) {
                swept++;
                totalAmount += sweepAmount;
                logger.info("sweep.pending_enqueued", {
                  motebitId: agent.motebit_id,
                  amount: sweepAmount,
                  destination: agent.settlement_address,
                  rail: sweepRail,
                  pendingId,
                  balanceBefore: agent.balance,
                  threshold: agent.sweep_threshold,
                  disputeHold,
                });
              }
              continue;
            }

            // Legacy path: create a pending relay_withdrawals row that an
            // admin completes manually. No idempotency key — the atomic
            // debit in requestWithdrawal prevents double-spend; a duplicate
            // sweep tick just sees lower balance.
            const result = requestWithdrawal(
              db,
              agent.motebit_id,
              sweepAmount,
              agent.settlement_address,
            );

            if (result && !("existing" in result)) {
              swept++;
              totalAmount += sweepAmount;
              logger.info("sweep.withdrawal_created", {
                motebitId: agent.motebit_id,
                amount: sweepAmount,
                destination: agent.settlement_address,
                withdrawalId: result.withdrawal_id,
                balanceBefore: agent.balance,
                threshold: agent.sweep_threshold,
                disputeHold,
              });
            }
          } catch (err) {
            logger.error("sweep.agent_failed", {
              motebitId: agent.motebit_id,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }

        if (swept > 0) {
          logger.info("sweep.tick_complete", {
            candidates: candidates.length,
            swept,
            totalAmount,
          });
        }
      } catch (err) {
        logger.error("sweep.tick_error", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })();
  }, intervalMs);
}
