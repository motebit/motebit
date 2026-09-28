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
 * On failure: records the PAYER's failed obligation in the harmed party's
 * first-person ledger (`recordPayerFailure`) — never a penalty on the worker
 * for the payer's payment, never a change to anyone's `settlement_modes`.
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
                    s.delegator_id, s.p2p_worker_leg, s.p2p_tx_hash,
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
  /** Which relay verifies the worker leg — frozen at write time; NULL on rows written before #959. */
  p2p_worker_leg: "local" | "remote" | null;
  p2p_tx_hash: string;
  amount_settled: number;
  platform_fee: number;
  /** The payee's registry `settlement_address` (local, write-authorized by the worker itself). */
  settlement_address: string | null;
  /** The payee's registry `public_key` (main's read; the holder key wins — `verificationKeyFor`). */
  public_key: string | null;
}

/** Which obligation of the payer a failed verification shows was not met. */
type FailedObligation = "worker_leg" | "fee_leg" | "transaction";

/**
 * The addresses at which a payment to the worker counts as a payment to the
 * worker (#959, settlement-authority binding). Never a peer-asserted or
 * otherwise unverified string:
 *
 *   - **derived-bound** — the Solana address the worker's identity key
 *     derives (`isDerivedSettlementBinding`): tautological and offline.
 *   - **write-authorized** — the worker's OWN registry `settlement_address`.
 *     `register` / `sweep-config` are caller===motebit_id authed, so on this
 *     relay the write-auth IS the authorization — the local rung of
 *     `docs/doctrine/settlement-authority-binding.md` § "Where binding is
 *     enforced" (custody separation is legitimate; requiring derivation here
 *     would forbid it). It is also the address the proof's worker leg was
 *     checked against at admission.
 *
 * A peer-asserted string (a federated candidate's address) never counts:
 * this relay only verifies the worker leg of a worker it HOSTS, whose
 * address the worker wrote itself. That the self-registered address is a
 * valid destination alongside the derived one is a confirmed decision
 * (#959), grounded in settlement-authority-binding: the doctrine enforces
 * identity-binding at the federated boundary, where a party OTHER than the
 * worker asserts its destination, and explicitly not at the local leg.
 * Mirrored in `spec/settlement-v1.md` §11.1.
 *
 * The signed-bound rung (a `SettlementBinding` artifact) is not built
 * (settlement-authority Inc 2); when it lands it joins this predicate.
 */
function paysWorker(
  to: string,
  row: Pick<PendingP2pRow, "settlement_address">,
  workerKey: string | null,
): boolean {
  if (row.settlement_address != null && row.settlement_address !== "") {
    if (to === row.settlement_address) return true;
  }
  return workerKey != null && isDerivedSettlementBinding(to, workerKey);
}

/**
 * Map the adapter's three-state `TxVerificationResult` to the verification
 * state machine on `relay_settlements`. Each relay verifies the legs that are
 * its to verify (#959):
 *
 *   - **Fee leg** — always, when `platform_fee > 0` (legacy pre-Arc-2 rows
 *     carry 0 and skip it): a transfer to THIS relay's treasury of exactly
 *     `platform_fee`.
 *   - **Worker leg** — when the row's `p2p_worker_leg` is `local` (or NULL on
 *     a row written before #959): a transfer of exactly `amount_settled` to an
 *     address that pays the PAYEE (`paysWorker` — derived-bound or the
 *     worker's own write-authorized address). A `remote` row (this relay
 *     originated a cross-operator task) leaves the worker leg to the executor
 *     relay, which hosts the worker.
 *
 * State machine:
 *   - `confirmed` + every leg this relay verifies matches → `verified`
 *   - `confirmed` + the fee leg missing / wrong → `failed` (fee_leg)
 *   - `confirmed` + the worker leg missing / wrong → `failed` (worker_leg)
 *   - `confirmed` + the worker leg is this relay's to verify but CANNOT be
 *     checked — the payee resolves to no key and no address, or the row names
 *     its own payer as payee (a pre-#959 record that could not be corrected)
 *     → `unverifiable`. Fail-closed: never `verified`, and no one is
 *     penalized, because nothing shows anyone failed. Terminal, so an
 *     unverifiable row cannot starve the per-cycle budget.
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

      const workerLegIsOurs = row.p2p_worker_leg !== "remote";
      if (!workerLegIsOurs) {
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

      if (
        row.delegator_id != null &&
        row.delegator_id !== "" &&
        row.motebit_id === row.delegator_id
      ) {
        markUnverifiable(
          db,
          row,
          "Worker leg unverifiable: the record names its own payer as payee (a pre-#959 record whose worker could not be recovered)",
        );
        return;
      }

      // Holder, else main's registry read (§5f verification reader).
      const workerKey = verificationKeyFor(db, row.motebit_id, row.public_key);
      const hasAddress = row.settlement_address != null && row.settlement_address !== "";
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
      // Transient — do NOT mark as failed, do NOT record a failure. Retry next cycle.
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
  logger.warn("p2p_verifier.failed", {
    settlementId: row.settlement_id,
    txHash: row.p2p_tx_hash,
    payee: row.motebit_id,
    delegatorId: row.delegator_id,
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
  recordPayerFailure(db, row, obligation);
}

// === Failure attribution ===

/**
 * Record, in the trust graph, that a P2P payment the relay was told about did
 * not land as declared (#959).
 *
 * Every leg of a P2P settlement is the PAYER's obligation: the delegator
 * broadcasts one atomic transaction paying the worker and the relay's
 * treasury, and the relay confirmed at admission that the transaction was
 * theirs (#918). So a failed verification is the payer's failure, and its
 * consequence lands where `docs/doctrine/paid-failure-recourse.md` puts every
 * recourse — the harmed party's FIRST-PERSON ledger, never a relay-wide score
 * and never a reversal:
 *
 *   - `worker_leg` / `transaction` — the worker was not shown to be paid. The
 *     worker's own edge about the payer, `[worker, delegator]`, takes one
 *     failure (when the relay holds that edge; the relay never mints a
 *     relationship the worker has not had).
 *   - `fee_leg` — the worker WAS paid; only the relay's fee is missing. The
 *     relay is the harmed party and its record is the `failed` row itself
 *     (the treasury reconciler already excludes it). No agent edge moves.
 *
 * What it never does (the pre-#959 behaviour, both halves wrong):
 *   - charge the WORKER in the payer's ledger (`[delegator, worker]`) for the
 *     payer's own payment failing — that is a paid-for worker punished for
 *     not being paid, and it feeds the routing posterior of
 *     `first-person-worker-routing.md` with a failure the worker never had;
 *   - strip any party's `settlement_modes`. Those are what an agent RECEIVES
 *     through (`agent_registry`, advertised in discovery); a payer's failed
 *     payment says nothing about how it may be paid, and after Arc 3 the
 *     field is vestigial for eligibility anyway.
 */
function recordPayerFailure(
  db: DatabaseDriver,
  row: PendingP2pRow,
  obligation: FailedObligation,
): void {
  const delegatorId = row.delegator_id;
  const workerId = row.motebit_id;
  if (obligation === "fee_leg") {
    logger.warn("p2p_verifier.fee_leg_unpaid", {
      settlementId: row.settlement_id,
      taskId: row.task_id,
      delegatorId,
      workerId,
    });
    return;
  }
  if (delegatorId == null || delegatorId === "" || delegatorId === workerId) {
    logger.warn("p2p_verifier.payer_failure_unattributable", {
      settlementId: row.settlement_id,
      taskId: row.task_id,
      delegatorId,
      workerId,
      obligation,
    });
    return;
  }
  try {
    const updated = db
      .prepare(
        `UPDATE agent_trust
         SET failed_tasks = COALESCE(failed_tasks, 0) + 1,
             last_seen_at = ?
         WHERE motebit_id = ? AND remote_motebit_id = ?`,
      )
      .run(Date.now(), workerId, delegatorId);
    logger.info("p2p_verifier.payer_failure_recorded", {
      settlementId: row.settlement_id,
      taskId: row.task_id,
      payerId: delegatorId,
      payeeId: workerId,
      obligation,
      edgeUpdated: updated.changes > 0,
    });
  } catch (err) {
    logger.error("p2p_verifier.payer_failure_error", {
      settlementId: row.settlement_id,
      taskId: row.task_id,
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
