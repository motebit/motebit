/**
 * P2P payment verifier — async onchain verification of direct settlement proofs.
 *
 * Phase 3 of p2p settlement: verifies pending payment proofs against Solana RPC,
 * downgrades trust on failure, and provides admin reporting by settlement mode.
 *
 * Background loop pattern matches startCredentialAnchorLoop.
 *
 * The Solana RPC boundary lives in `@motebit/wallet-solana`. This module
 * consumes `SolanaRpcAdapter.getTransaction`; it does NOT construct
 * JSON-RPC payloads or call `fetch` on the RPC URL. See
 * `services/relay/CLAUDE.md` rule 1 ("Never inline protocol plumbing") —
 * the same doctrine applies to medium plumbing (Solana RPC). When a
 * second p2p-settling chain ships, it plugs in behind the same adapter
 * interface.
 */
import type { DatabaseDriver } from "@motebit/persistence";
import {
  Web3JsRpcAdapter,
  isDerivedSettlementBinding,
  type SolanaRpcAdapter,
  type TxVerificationResult,
} from "@motebit/wallet-solana";
import { createLogger } from "./logger.js";
import { verificationKeyFor } from "./identity-keys.js";
import { superviseInterval, type LoopSupervisor } from "./loop-supervisor.js";

const logger = createLogger({ service: "relay", module: "p2p-verifier" });

// === Constants ===

/** How often to check for unverified p2p payments. */
const VERIFY_INTERVAL_MS = 60_000; // 1 minute
/** Maximum pending proofs to verify per cycle. */
const MAX_VERIFY_PER_CYCLE = 20;

/**
 * Read-only seed used to construct the Web3JsRpcAdapter for the p2p
 * verifier. The adapter requires a 32-byte identity seed because its
 * default use case (sending USDC) needs a Keypair — but the verifier
 * ONLY calls `getTransaction`, which never reads the keypair. Passing
 * the zero seed makes the read-only intent obvious; no wallet is ever
 * derived or used on this instance.
 */
const READ_ONLY_SEED = new Uint8Array(32);

// === Verification Loop ===

export interface P2pVerifierConfig {
  /** Solana RPC URL (e.g., from SOLANA_RPC_URL env). Ignored when `adapter` is provided. */
  rpcUrl: string;
  /**
   * Relay treasury Solana address (base58). The relay's identity-derived
   * Solana wallet — same address that `OperatorSolanaTransfer` uses for
   * Path 0 withdrawals and that `SolanaMemoSubmitter` uses for anchoring.
   * The verifier expects the delegator's atomic multi-output P2P tx to
   * include a fee leg sending to this address.
   *
   * Required after Arc 2 of the off-ramp arc. When the relay starts up
   * without a Solana keypair configured (no `SOLANA_RPC_URL`), the
   * verifier loop is not started at all — so this address is always
   * resolvable when the loop runs.
   */
  relayTreasuryAddress: string;
  /**
   * USDC SPL mint (base58). Defaults to mainnet USDC when omitted (the
   * `Web3JsRpcAdapter` default). Threaded from `SOLANA_USDC_MINT` so a
   * non-mainnet deployment (devnet/testnet) verifies legs against the
   * SAME mint the delegator paid in — without it the verifier walks the
   * mainnet mint's token accounts, finds none of the legs, and
   * fail-verifies (then trust-downgrades) every P2P settlement. The
   * sibling `OperatorSolanaTransfer` and the Solana treasury reconciler
   * already honor this env; the verifier must too. Ignored when
   * `adapter` is provided.
   */
  usdcMint?: string;
  /** Override check interval (default: 60s). */
  intervalMs?: number;
  /** Override max proofs per cycle (default: 20). */
  maxPerCycle?: number;
  /**
   * Optional RPC adapter override — primarily for tests. When
   * omitted, a `Web3JsRpcAdapter` is constructed from `rpcUrl` with a
   * read-only zero-seed (see `READ_ONLY_SEED`).
   */
  adapter?: SolanaRpcAdapter;
}

/**
 * Start the async p2p payment verification loop.
 *
 * Polls relay_settlements for settlement_mode='p2p' AND payment_verification_status='pending',
 * fetches the Solana transaction via RPC, and transitions to 'verified', 'failed'
 * or 'unverifiable' (see `handleVerificationResult`).
 *
 * On failure: records the PAYER's failed obligation on the settlement row
 * (the leg and the reason) and in a warn log — no trust edge moves and no
 * `settlement_modes` change (`markFailed`).
 */
export function startP2pVerifierLoop(
  db: DatabaseDriver,
  config: P2pVerifierConfig,
  isFrozen?: () => boolean,
  supervisor?: LoopSupervisor,
): ReturnType<typeof setInterval> {
  const intervalMs = config.intervalMs ?? VERIFY_INTERVAL_MS;
  const maxPerCycle = config.maxPerCycle ?? MAX_VERIFY_PER_CYCLE;
  const treasuryAddress = config.relayTreasuryAddress;

  // Construct the adapter once per loop. `Web3JsRpcAdapter` requires a
  // 32-byte identity seed for its send path; the verifier only calls
  // `getTransaction`, so a zero-seed placeholder is used — no wallet
  // is ever derived or spent on this instance.
  const adapter: SolanaRpcAdapter =
    config.adapter ??
    new Web3JsRpcAdapter({
      rpcUrl: config.rpcUrl,
      identitySeed: READ_ONLY_SEED,
      ...(config.usdcMint ? { usdcMint: config.usdcMint } : {}),
    });

  return superviseInterval(
    supervisor,
    "p2p-verifier",
    intervalMs,
    async () => {
      try {
        // After Arc 2 of the off-ramp arc, P2P settlements carry a
        // composite tx hash (single atomic Solana tx with worker leg +
        // fee leg). The verifier needs the expected amounts and the
        // worker's settlement address to walk transfers[] and validate
        // both legs.
        const pendingRows = db
          .prepare(
            `SELECT s.settlement_id, s.task_id,
                    COALESCE(c.corrected_motebit_id, s.motebit_id) AS motebit_id,
                    s.delegator_id, s.p2p_worker_leg, s.p2p_worker_address, s.p2p_tx_hash,
                    s.amount_settled, s.platform_fee,
                    a.settlement_address, a.public_key
             FROM relay_settlements s
             LEFT JOIN relay_settlement_payee_corrections c
               ON c.settlement_id = s.settlement_id
             LEFT JOIN agent_registry a
               ON a.motebit_id = COALESCE(c.corrected_motebit_id, s.motebit_id)
             WHERE s.settlement_mode = 'p2p'
               AND s.payment_verification_status = 'pending'
               AND s.p2p_tx_hash IS NOT NULL
             ORDER BY s.settled_at ASC
             LIMIT ?`,
          )
          .all(maxPerCycle) as PendingP2pRow[];

        if (pendingRows.length === 0) return;

        for (const row of pendingRows) {
          try {
            const result = await adapter.getTransaction(row.p2p_tx_hash);
            handleVerificationResult(db, row, result, treasuryAddress);
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
    },
    { isFrozen },
  );
}

// === Onchain Verification ===

/** One pending P2P settlement row, with its payee resolved (#959). */
interface PendingP2pRow {
  settlement_id: string;
  task_id: string;
  /**
   * The payee: the corrected payee when a #959 correction exists for this row
   * (`relay_settlement_payee_corrections`), else the row's own `motebit_id`.
   */
  motebit_id: string;
  /** The payer. */
  delegator_id: string | null;
  /**
   * Which relay verifies the worker leg — declared by admission and frozen on
   * the row at write time. NULL ⇔ the row was written before #959.
   */
  p2p_worker_leg: "local" | "remote" | null;
  /** The worker-leg address admission validated the proof against (NULL before #959 round 2). */
  p2p_worker_address: string | null;
  p2p_tx_hash: string;
  amount_settled: number;
  platform_fee: number;
  /** The payee's CURRENT registry `settlement_address` — read only for rows with no admitted address. */
  settlement_address: string | null;
  /** The payee's registry `public_key` (main's read; the holder key wins — `verificationKeyFor`). */
  public_key: string | null;
}

/** Which obligation of the payer a failed verification shows was not met. */
type FailedObligation = "worker_leg" | "fee_leg" | "transaction";

/**
 * Whether a transfer to `to` pays the worker (#959, settlement-authority
 * binding). Two destinations are bound to the payee, and nothing else is:
 *
 *   - **derived-bound** — the Solana address the worker's identity key
 *     derives (`isDerivedSettlementBinding`): tautological and offline.
 *   - **the worker's own locally registered address** — as ADMITTED: the
 *     address the proof's worker leg was validated against when the task was
 *     admitted (`p2p_worker_address`), so a worker that changes its address
 *     mid-flight does not turn a correctly paid payer into a failure. Rows
 *     written before that column existed fall back to the worker's current
 *     registry address.
 *
 * Why the self-registered address counts (a CONFIRMED decision, #959): it is
 * written under the worker's own authenticated write (`register` /
 * `sweep-config` are caller === motebit_id), so on this relay the write-auth
 * IS the authorization — `docs/doctrine/settlement-authority-binding.md` §
 * "Where binding is enforced": binding to the identity key is enforced at the
 * federated boundary, where a party OTHER than the worker asserts its
 * destination, and deliberately not at the local leg (custody separation is
 * legitimate). A peer-asserted string never counts: this relay verifies only
 * the worker leg of a worker it HOSTS. Mirrored in `spec/settlement-v1.md`
 * §11.1. The signed-bound rung (a `SettlementBinding` artifact,
 * settlement-authority Inc 2) is not built; when it lands it joins here.
 */
function paysWorker(
  to: string,
  row: Pick<PendingP2pRow, "settlement_address" | "p2p_worker_address">,
  workerKey: string | null,
): boolean {
  const registered = row.p2p_worker_address ?? row.settlement_address;
  if (registered != null && registered !== "" && to === registered) return true;
  return workerKey != null && isDerivedSettlementBinding(to, workerKey);
}

/**
 * A pre-#959 row that names its own payer as payee could not be corrected
 * from the receipt archive. That is the #959 bug shape — UNLESS the payer
 * really did delegate to itself, which the archive shows as a receipt for
 * the task signed by that same identity.
 */
function isUncorrectedLegacySelfPayee(db: DatabaseDriver, row: PendingP2pRow): boolean {
  if (row.p2p_worker_leg != null) return false; // written after #959: admission decided the payee
  if (row.delegator_id == null || row.delegator_id === "" || row.motebit_id !== row.delegator_id) {
    return false;
  }
  try {
    const selfSigned = db
      .prepare("SELECT 1 FROM relay_receipts WHERE task_id = ? AND motebit_id = ? LIMIT 1")
      .get(row.task_id, row.motebit_id);
    return selfSigned == null;
  } catch {
    return true;
  }
}

/**
 * Map the adapter's three-state `TxVerificationResult` to the verification
 * state machine on `relay_settlements`. Each relay verifies the legs that are
 * its to verify (#959):
 *
 *   - **Fee leg** — always, when `platform_fee > 0` (legacy pre-Arc-2 rows
 *     carry 0 and skip it): a transfer to THIS relay's treasury of exactly
 *     `platform_fee`.
 *   - **Worker leg** — when the row's admission-declared `p2p_worker_leg` is
 *     `local` (or NULL on a row written before #959): a transfer of exactly
 *     `amount_settled` to an address bound to the PAYEE (`paysWorker`). A
 *     `remote` row (this relay originated a cross-operator task) leaves the
 *     worker leg to the executor relay, which hosts the worker.
 *
 * State machine:
 *   - `confirmed` + every leg this relay verifies matches → `verified`
 *   - `confirmed` + the fee leg missing / wrong → `failed` (fee_leg)
 *   - `confirmed` + the worker leg missing / wrong → `failed` (worker_leg)
 *   - `confirmed` + nothing this relay can check: a `remote` row with no fee
 *     leg; a `local` payee with no key and no address here; a pre-#959 row
 *     naming its own payer that the archive does not show as a real
 *     self-delegation → `unverifiable`. Fail-closed: never `verified`, and no
 *     one is named as failing. Terminal, so it cannot starve the budget.
 *   - `not_found` → `failed` (transaction)
 *   - `rpc_error` → stay pending, retry next cycle (NEVER a failure —
 *     `spec/settlement-v1.md` §11.1 Foundation Law)
 */
function handleVerificationResult(
  db: DatabaseDriver,
  row: PendingP2pRow,
  result: TxVerificationResult,
  treasuryAddress: string,
): void {
  switch (result.status) {
    case "confirmed": {
      const expectFeeLeg = row.platform_fee > 0;
      const feeLeg = expectFeeLeg
        ? result.transfers.find(
            (t) => t.to === treasuryAddress && t.amountMicro === BigInt(row.platform_fee),
          )
        : undefined;
      if (expectFeeLeg && feeLeg == null) {
        markFailed(
          db,
          row,
          "fee_leg",
          "Fee leg not found in tx transfers (address or amount mismatch)",
          result,
        );
        return;
      }

      if (row.p2p_worker_leg === "remote") {
        if (!expectFeeLeg) {
          markUnverifiable(
            db,
            row,
            "No leg for this relay to verify: the worker leg is the executor relay's and no fee leg was recorded",
          );
          return;
        }
        markVerified(db, row, result);
        return;
      }

      if (isUncorrectedLegacySelfPayee(db, row)) {
        markUnverifiable(
          db,
          row,
          "Worker leg unverifiable: a pre-#959 record names its own payer as payee and its worker could not be recovered",
        );
        return;
      }

      // Holder, else main's registry read (§5f verification reader).
      const workerKey = verificationKeyFor(db, row.motebit_id, row.public_key);
      const hasAddress = (row.p2p_worker_address ?? row.settlement_address ?? "") !== "";
      if (workerKey == null && !hasAddress) {
        markUnverifiable(
          db,
          row,
          "Worker leg unverifiable: the payee has no bound settlement address on this relay (no identity key, no registered address)",
        );
        return;
      }

      const workerLeg = result.transfers.find(
        (t) => t.amountMicro === BigInt(row.amount_settled) && paysWorker(t.to, row, workerKey),
      );
      if (workerLeg == null) {
        markFailed(
          db,
          row,
          "worker_leg",
          "Worker leg not found in tx transfers (no transfer of the recorded amount to the worker's bound address)",
          result,
        );
        return;
      }
      markVerified(db, row, result);
      return;
    }

    case "not_found":
      markFailed(db, row, "transaction", "Transaction not found on Solana", result);
      return;

    case "rpc_error":
      // Transient — do NOT mark as failed. Retry next cycle.
      logger.warn("p2p_verifier.rpc_error", {
        settlementId: row.settlement_id,
        txHash: row.p2p_tx_hash,
        reason: result.reason,
      });
      return;
  }
}

function markVerified(
  db: DatabaseDriver,
  row: PendingP2pRow,
  result: Extract<TxVerificationResult, { status: "confirmed" }>,
): void {
  db.prepare(
    `UPDATE relay_settlements
     SET payment_verification_status = 'verified', payment_verified_at = ?
     WHERE settlement_id = ?`,
  ).run(Date.now(), row.settlement_id);
  logger.info("p2p_verifier.verified", {
    settlementId: row.settlement_id,
    txHash: row.p2p_tx_hash,
    payee: row.motebit_id,
    workerLeg: row.p2p_worker_leg ?? "local",
    workerAmountMicro: row.amount_settled,
    feeAmountMicro: row.platform_fee,
    slot: result.slot,
  });
}

function markUnverifiable(db: DatabaseDriver, row: PendingP2pRow, reason: string): void {
  db.prepare(
    `UPDATE relay_settlements
     SET payment_verification_status = 'unverifiable',
         payment_verified_at = ?,
         payment_verification_error = ?
     WHERE settlement_id = ?`,
  ).run(Date.now(), reason, row.settlement_id);
  logger.warn("p2p_verifier.unverifiable", {
    settlementId: row.settlement_id,
    txHash: row.p2p_tx_hash,
    payee: row.motebit_id,
    delegatorId: row.delegator_id,
    reason,
  });
}

/**
 * Record a P2P payment that did not land as declared (#959).
 *
 * Every leg of a P2P settlement is the PAYER's obligation: the delegator
 * broadcasts one atomic transaction paying the worker and the relay's
 * treasury, and the relay confirmed at admission that the transaction was
 * theirs (#918). The relay records the payer's failure on the settlement
 * row — the ledger of record: `failed`, with the leg and the reason — and in
 * a warn-level log naming the payer and the leg. It moves NO trust edge:
 *
 *   - not `[delegator, worker]` — the worker was the one not paid; charging
 *     it for the payer's failure is the pre-#959 `downgradeP2pTrust` error;
 *   - not `[worker, delegator]` — `failed_tasks` there is a COMPETENCE signal
 *     about the delegator as a worker (paid-failure-recourse: "a competence
 *     signal, not a relationship verdict"; first-person-worker-routing ranks
 *     on it), and the relay writing a payer-side fact into the worker's
 *     first-person ledger is sanctioned by no doctrine;
 *   - never any party's `settlement_modes`.
 *
 * A worker's own runtime MAY learn from its own settlement history — its
 * first-person choice (spec §11.1), not the relay's.
 */
function markFailed(
  db: DatabaseDriver,
  row: PendingP2pRow,
  obligation: FailedObligation,
  error: string,
  result: TxVerificationResult,
): void {
  db.prepare(
    `UPDATE relay_settlements
     SET payment_verification_status = 'failed',
         payment_verified_at = ?,
         payment_verification_error = ?
     WHERE settlement_id = ?`,
  ).run(Date.now(), error, row.settlement_id);
  logger.warn("p2p_verifier.payer_failure", {
    settlementId: row.settlement_id,
    taskId: row.task_id,
    txHash: row.p2p_tx_hash,
    payerId: row.delegator_id,
    payeeId: row.motebit_id,
    obligation,
    error,
    ...(result.status === "confirmed"
      ? {
          observedTransfers: result.transfers.map((t) => ({
            to: t.to,
            amount: t.amountMicro.toString(),
          })),
        }
      : {}),
  });
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
  /** P2P rows whose worker leg this relay owns but could not check (#959). */
  unverifiable_count: number;
}

/**
 * Get settlement statistics grouped by settlement_mode.
 * Used by the operator console.
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
           COUNT(CASE WHEN payment_verification_status = 'failed' THEN 1 END) as failed_count,
           COUNT(CASE WHEN payment_verification_status = 'unverifiable' THEN 1 END) as unverifiable_count
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
 * Used by the operator console.
 */
export function getRecentP2pSettlements(
  db: DatabaseDriver,
  limit: number = 50,
): Array<Record<string, unknown>> {
  try {
    return db
      .prepare(
        `SELECT s.settlement_id, s.task_id,
                COALESCE(c.corrected_motebit_id, s.motebit_id) AS motebit_id,
                s.motebit_id AS recorded_motebit_id, s.delegator_id, s.p2p_tx_hash,
                s.payment_verification_status, s.payment_verified_at,
                s.payment_verification_error, s.settled_at
         FROM relay_settlements s
         LEFT JOIN relay_settlement_payee_corrections c ON c.settlement_id = s.settlement_id
         WHERE s.settlement_mode = 'p2p'
         ORDER BY s.settled_at DESC
         LIMIT ?`,
      )
      .all(limit) as Array<Record<string, unknown>>;
  } catch {
    return [];
  }
}
