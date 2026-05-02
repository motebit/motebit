/**
 * The reconciler. Pure orchestration over injected store + rpc.
 * Zero DB access, zero fetch calls — those live in the store and rpc
 * implementations respectively.
 *
 * Conservative phase-1 invariant: detect negative drift between recorded
 * platform-fee accumulation and onchain treasury balance. Positive drift
 * (onchain ≥ feeSum) is ALWAYS consistent — it covers direct deposits,
 * external operator funding, partial worker payouts not yet swept, etc.
 * Negative drift is the load-bearing alert: it means more fees were
 * recorded than actually arrived onchain, which is the silent-leakage
 * failure mode the primitive exists to catch.
 */

import type { ReconcileTreasuryConfig, ReconciliationResult } from "./types.js";

/**
 * Run one reconciliation cycle.
 *
 *  1. Compute the safe-horizon timestamp: `now - confirmationLagBufferMs`.
 *  2. Query recorded fee sum from the store, asOfMs = safe-horizon.
 *  3. Query observed onchain balance via `rpc.getBalance`.
 *  4. Compute drift = onchain - feeSum; consistent = drift >= 0n.
 *  5. Persist successful result via `store.persistReconciliation`.
 *  6. On error, return a result with `error` populated and SKIP persistence
 *     — the audit log is for completed cycles only.
 *
 * Returns the reconciliation result regardless of outcome (success or error).
 */
export async function reconcileTreasury(
  config: ReconcileTreasuryConfig,
): Promise<ReconciliationResult> {
  const {
    rpc,
    store,
    chain,
    treasuryAddress,
    usdcContractAddress,
    confirmationLagBufferMs,
    generateReconciliationId,
    now = Date.now,
    logger,
  } = config;

  const reconciliationId = generateReconciliationId();
  const runAtMs = now();
  const asOfMs = runAtMs - confirmationLagBufferMs;

  let recordedFeeSumMicro: bigint;
  try {
    recordedFeeSumMicro = store.getRecordedFeeSumMicro(chain, asOfMs);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger?.error("treasury.reconciliation.store_error", {
      reconciliationId,
      chain,
      error: message,
    });
    return {
      reconciliationId,
      runAtMs,
      chain,
      treasuryAddress,
      usdcContractAddress,
      recordedFeeSumMicro: 0n,
      observedOnchainBalanceMicro: 0n,
      driftMicro: 0n,
      consistent: false,
      confirmationLagBufferMs,
      error: `store.getRecordedFeeSumMicro: ${message}`,
    };
  }

  let observedOnchainBalanceMicro: bigint;
  try {
    observedOnchainBalanceMicro = await rpc.getBalance({
      contractAddress: usdcContractAddress,
      accountAddress: treasuryAddress,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger?.error("treasury.reconciliation.rpc_error", {
      reconciliationId,
      chain,
      treasuryAddress,
      error: message,
    });
    return {
      reconciliationId,
      runAtMs,
      chain,
      treasuryAddress,
      usdcContractAddress,
      recordedFeeSumMicro,
      observedOnchainBalanceMicro: 0n,
      driftMicro: 0n,
      consistent: false,
      confirmationLagBufferMs,
      error: `rpc.getBalance: ${message}`,
    };
  }

  const driftMicro = observedOnchainBalanceMicro - recordedFeeSumMicro;
  const consistent = driftMicro >= 0n;

  const result: ReconciliationResult = {
    reconciliationId,
    runAtMs,
    chain,
    treasuryAddress,
    usdcContractAddress,
    recordedFeeSumMicro,
    observedOnchainBalanceMicro,
    driftMicro,
    consistent,
    confirmationLagBufferMs,
  };

  // Persist only completed cycles (no error path).
  store.persistReconciliation(result);

  if (!consistent) {
    logger?.warn("treasury.reconciliation.drift", {
      reconciliationId,
      chain,
      treasuryAddress,
      recordedFeeSumMicro: recordedFeeSumMicro.toString(),
      observedOnchainBalanceMicro: observedOnchainBalanceMicro.toString(),
      driftMicro: driftMicro.toString(),
    });
  } else {
    logger?.info("treasury.reconciliation.cycle", {
      reconciliationId,
      chain,
      recordedFeeSumMicro: recordedFeeSumMicro.toString(),
      observedOnchainBalanceMicro: observedOnchainBalanceMicro.toString(),
      driftMicro: driftMicro.toString(),
    });
  }

  return result;
}
