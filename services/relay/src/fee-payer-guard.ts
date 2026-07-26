/**
 * Fee-payer solvency guard — proactive alerting before the anchor fee-payer
 * freezes below Solana's rent-exempt floor.
 *
 * Every on-chain anchor (settlement / credential / revocation / identity-log /
 * transparency) pays a base fee from the relay's identity wallet. Solana
 * rejects any transaction that would leave the fee-payer below the rent-exempt
 * minimum, so the *spendable* headroom is `balance - rentExemptMin`, not the
 * raw balance. A wallet resting just above the rent floor (headroom < one base
 * fee) is FROZEN: every anchor fails at simulation, silently stalling all
 * on-chain anchoring.
 *
 * That happened in prod 2026-07-25 — the treasury sat at 895_000 lamports
 * against an 890_880 rent-min (4_120 headroom < 5_000 fee) and every anchor
 * had been failing for ~38h, invisibly. The transparency-anchor supervision
 * loop surfaced the *symptom* (an erroring anchor loop) only AFTER the freeze;
 * this guard surfaces the *cause* BEFORE it, by watching the headroom directly.
 *
 * Design (rule 18): a supervised loop that reads the fee-payer's solvency each
 * tick and — when spendable headroom drops below a transaction-count threshold —
 * logs a structured warning AND throws, so the loop shows `fee-payer-balance-guard`
 * `erroring` on `GET /api/v1/admin/health` (and flips `anyUnhealthy()`). A
 * healthy balance is a quiet `ok` tick. The RPC read itself failing also throws
 * (a distinct message) — both are legitimately "this guard is unhappy."
 *
 * Doctrine: `services/relay/CLAUDE.md` rule 18; sibling of the transparency
 * anchor supervision (`transparency.ts`).
 */

import { createLogger } from "./logger.js";
import { superviseInterval, type LoopSupervisor } from "./loop-supervisor.js";

const logger = createLogger({ service: "relay", module: "fee-payer-guard" });

/** Solana base transaction fee (1 signature), in lamports. */
export const BASE_TX_FEE_LAMPORTS = 5000;

/**
 * Default alert threshold: warn once spendable headroom falls below this many
 * transactions' worth of fees. 200 txs (~1_000_000 lamports ≈ 0.001 SOL over
 * the rent floor) gives comfortable lead time to top up before a freeze, even
 * under the bursty identity-log-anchor backlog that can drain quickly.
 */
export const DEFAULT_WARN_HEADROOM_TXS = 200;

/** Default cadence — balance moves slowly; 5 min is ample given the 200-tx buffer. */
export const DEFAULT_FEE_PAYER_GUARD_INTERVAL_MS = 5 * 60_000;

/** What the guard needs from the fee-payer (implemented by `SolanaMemoSubmitter`). */
export interface FeePayerSolvencySource {
  readonly address: string;
  getFeePayerSolvency(): Promise<{
    balanceLamports: number;
    rentExemptMinLamports: number;
  }>;
}

export interface FeePayerSolvency {
  /** `low` once headroom < the warn threshold; `ok` otherwise. */
  status: "ok" | "low";
  balanceLamports: number;
  rentExemptMinLamports: number;
  /** Spendable lamports above the rent floor — the real capacity, not `balance`. */
  headroomLamports: number;
  /** Whole transactions the headroom can pay for at the base fee. */
  headroomTxs: number;
  /** Headroom is below a single base fee — the fee-payer cannot anchor at all. */
  frozen: boolean;
}

/**
 * Pure classification of a fee-payer's solvency. Separated from I/O so the
 * decision boundary is exhaustively unit-testable with the real incident
 * numbers.
 */
export function classifyFeePayerSolvency(
  balanceLamports: number,
  rentExemptMinLamports: number,
  opts: { warnHeadroomTxs?: number; txFeeLamports?: number } = {},
): FeePayerSolvency {
  const txFee = opts.txFeeLamports ?? BASE_TX_FEE_LAMPORTS;
  const warnTxs = opts.warnHeadroomTxs ?? DEFAULT_WARN_HEADROOM_TXS;
  const headroomLamports = balanceLamports - rentExemptMinLamports;
  // Clamp negatives to 0 txs (a below-rent-min account can pay for none).
  const headroomTxs = Math.max(0, Math.floor(headroomLamports / txFee));
  const frozen = headroomLamports < txFee;
  const status = headroomTxs < warnTxs ? "low" : "ok";
  return {
    status,
    balanceLamports,
    rentExemptMinLamports,
    headroomLamports,
    headroomTxs,
    frozen,
  };
}

/**
 * One solvency check. Reads the fee-payer, classifies, and — on `low` — logs a
 * structured warning and THROWS a descriptive error so the supervised loop
 * records it as `erroring`. Returns the solvency on `ok`. Extracted from the
 * loop so it is testable without timers.
 */
/**
 * Mutable per-loop state. Tracks whether the boot-time healthy-liveness INFO
 * line has been emitted, so it fires exactly once (the first healthy check)
 * rather than every tick.
 */
export interface FeePayerGuardState {
  firstHealthyLogged: boolean;
}

export async function checkFeePayerSolvencyOnce(
  source: FeePayerSolvencySource,
  opts: { warnHeadroomTxs?: number } = {},
  state?: FeePayerGuardState,
): Promise<FeePayerSolvency> {
  const { balanceLamports, rentExemptMinLamports } = await source.getFeePayerSolvency();
  const s = classifyFeePayerSolvency(balanceLamports, rentExemptMinLamports, opts);
  if (s.status === "low") {
    logger.warn("fee_payer.solvency_low", {
      address: source.address,
      balance_lamports: s.balanceLamports,
      rent_exempt_min_lamports: s.rentExemptMinLamports,
      headroom_lamports: s.headroomLamports,
      headroom_txs: s.headroomTxs,
      frozen: s.frozen,
    });
    throw new Error(
      `fee-payer ${source.address} solvency LOW: spendable headroom ${s.headroomLamports} lamports ` +
        `(${s.headroomTxs} txs) above the rent-exempt floor` +
        (s.frozen
          ? " — FROZEN: below one base fee, every on-chain anchor fails at simulation"
          : "") +
        `. Top up SOL to keep on-chain anchoring alive.`,
    );
  }
  // Boot-time liveness signal: log the FIRST healthy check at INFO so an
  // operator can confirm from logs that the guard is running — the loop is
  // otherwise silent when healthy (debug ok ticks) and /admin/health is
  // master-token-gated, so there was no easy "guard alive" signal. Subsequent
  // healthy checks stay at debug to avoid a per-tick INFO stream. A low check
  // never reaches here (it throws above, visibly, at warn).
  if (state && !state.firstHealthyLogged) {
    state.firstHealthyLogged = true;
    logger.info("fee_payer.guard_healthy", {
      address: source.address,
      headroom_lamports: s.headroomLamports,
      headroom_txs: s.headroomTxs,
    });
  } else {
    logger.debug("fee_payer.solvency_ok", {
      address: source.address,
      headroom_txs: s.headroomTxs,
    });
  }
  return s;
}

/**
 * Start the supervised fee-payer balance guard loop. Runs only where an
 * on-chain submitter is configured (the same `SOLANA_RPC_URL` gate as the
 * anchoring loops). Registered on the supervisor as `fee-payer-balance-guard`;
 * a low balance surfaces as `erroring` on `/api/v1/admin/health` before the
 * fee-payer freezes.
 */
export function startFeePayerBalanceGuardLoop(
  source: FeePayerSolvencySource,
  isFrozen: () => boolean,
  supervisor?: LoopSupervisor,
  opts: { intervalMs?: number; warnHeadroomTxs?: number } = {},
): ReturnType<typeof setInterval> {
  const intervalMs = opts.intervalMs ?? DEFAULT_FEE_PAYER_GUARD_INTERVAL_MS;
  const state: FeePayerGuardState = { firstHealthyLogged: false };
  return superviseInterval(
    supervisor,
    "fee-payer-balance-guard",
    intervalMs,
    async () => {
      await checkFeePayerSolvencyOnce(source, { warnHeadroomTxs: opts.warnHeadroomTxs }, state);
    },
    { isFrozen },
  );
}
