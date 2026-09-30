/**
 * Budget, Virtual Accounts, Withdrawals, Admin & Stripe routes.
 */

import type { Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { MotebitDatabase } from "@motebit/persistence";
import { toCents } from "@motebit/protocol";
import type {
  AccountBalanceResult,
  AccountWithdrawResult,
  AccountWithdrawalRecord,
} from "@motebit/protocol";
import { bytesToHex, hash as sha256Hash } from "@motebit/encryption";
import type { RelayIdentity } from "./federation.js";
import { createLogger } from "./logger.js";
import { persistFreeze } from "./freeze.js";
import {
  getAccountBalance,
  getAccountBalanceDetailed,
  getTransactions,
  requestWithdrawal,
  claimWithdrawalForPayout,
  completeWithdrawal,
  signWithdrawalReceipt,
  failWithdrawal,
  noteWithdrawalPayoutUnresolved,
  getWithdrawals,
  getWithdrawalById,
  getPendingWithdrawals,
  reconcileLedger,
  processStripeCheckout,
  storeSettlementProof,
  toMicro,
  fromMicro,
} from "./accounts.js";
import { checkIdempotency, completeIdempotency } from "./idempotency.js";
import Stripe from "stripe";
import type { SettlementRailRegistry, StripeSettlementRail } from "@motebit/settlement-rails";
import type { WithdrawalRequest } from "@motebit/virtual-accounts";
import {
  CHAIN_READ_TIMEOUT_MS,
  dequeuePayout,
  enqueuePayout,
  getPayoutAttempts,
  isChainRecordedClaim,
  isNonceValueUsed,
  mapBounded,
  markChainRecordedClaim,
  queuedPayouts,
  readChainVerdict,
  recordDurableAttempt,
  requestKill,
  withTimeout,
  type KillRequest,
} from "./withdrawal-chain-payouts.js";

const logger = createLogger({ service: "budget" });

export {
  RECONCILE_MIN_AGE_MS,
  PAYOUT_HORIZON_MARGIN_MS,
  UNDECLARED_PAYOUT_HORIZON_MS,
  reconcileOpensAt,
} from "./payout-horizon.js";
import { RECONCILE_MIN_AGE_MS, reconcileOpensAt } from "./payout-horizon.js";

/** The destination shape the automated payout path serves: Path 0 (Solana base58). */
const SOLANA_DEST_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
/**
 * An EVM (0x) destination. No path can pay one (#948): Path 1 (x402) needs
 * an EIP-3009 authorization signed by the treasury's EVM key, which the
 * relay does not hold. Refused at /withdraw before any debit.
 */
const EVM_DEST_RE = /^0x[0-9a-fA-F]{40}$/;

/** The refusal a 0x withdrawal gets (#948) — before any debit. */
export const EVM_WITHDRAWAL_UNSUPPORTED = {
  error: "WITHDRAWAL_DESTINATION_UNSUPPORTED",
  message:
    "EVM (0x) withdrawals are not available: this relay cannot sign the EIP-3009 authorization an x402 payout requires. Withdraw to a Solana address you control.",
  status: 400,
} as const;

/**
 * A `pending` withdrawal whose payout may have been attempted with no claim
 * recorded (#921): marked durably when the ledger first gained
 * claim-before-send (`pre_claim_review`), or one already carrying a payout
 * reference. A manual `/fail` on it could refund a payout that paid — check
 * the chain first.
 */
export function payoutMayHaveBeenAttempted(
  w: Pick<WithdrawalRequest, "status" | "payout_reference" | "pre_claim_review">,
): boolean {
  return (
    w.status === "pending" &&
    ((w.pre_claim_review ?? 0) === 1 || (w.payout_reference != null && w.payout_reference !== ""))
  );
}

/**
 * Map a ledger withdrawal row to the market-v1 §2.9 wire record: convert
 * the micro-unit `amount` to decimal USD at the boundary and stamp the
 * relay's own identity (`relay_id` is a signed `WithdrawalReceiptPayload`
 * field, so its presence lets an auditor reconstruct the canonical bytes
 * from the response alone). Single mapper for every withdrawal response
 * surface — the POST result and the /withdrawals history — so a new
 * surfaced field is added in one place, not two.
 */
function toWithdrawalRecord(w: WithdrawalRequest, relayId: string): AccountWithdrawalRecord {
  // `claimed_at`, `payout_valid_until`, `pre_claim_review` (#921) are ledger
  // bookkeeping for the operator's reconcile door, not §2.9 wire fields.
  const {
    claimed_at: _claimedAt,
    payout_valid_until: _validUntil,
    pre_claim_review: _review,
    ...wire
  } = w;
  return {
    ...wire,
    amount: fromMicro(w.amount),
    relay_id: relayId,
  };
}

/**
 * Map a thrown error from a Stripe SDK call into a structured 502
 * response. Stripe's `StripeError` subclasses (`StripeInvalidRequestError`,
 * `StripeCardError`, `StripeAPIError`, `StripeConnectionError`,
 * `StripeAuthenticationError`, `StripePermissionError`,
 * `StripeRateLimitError`, `StripeIdempotencyError`) all carry `type` and
 * (most) `code` and `message` fields. Surfacing those to the CLI lets
 * the caller see why their checkout/withdraw failed instead of the
 * opaque "Internal server error" 500 Hono returns when an exception
 * leaves a route handler unhandled.
 *
 * Error-shape contract per `services/relay/CLAUDE.md` rule 14: external
 * medium plumbing speaks motebit vocabulary. Provider-shaped errors
 * (Stripe's deep nested raw object) collapse here into a closed
 * motebit shape: `{ error, code, status }`.
 */
function mapStripeError(
  c: Context,
  correlationId: string | undefined,
  motebitId: string,
  amount: number,
  err: unknown,
  via: "settlement-rail" | "direct-sdk",
): Response {
  const stripeError = err as {
    type?: string;
    code?: string;
    message?: string;
    requestId?: string;
    statusCode?: number;
  };
  const stripeType = typeof stripeError?.type === "string" ? stripeError.type : "stripe.unknown";
  const stripeCode = typeof stripeError?.code === "string" ? stripeError.code : null;
  const stripeMessage =
    typeof stripeError?.message === "string"
      ? stripeError.message
      : err instanceof Error
        ? err.message
        : String(err);
  // Map a few common Stripe types/states to a motebit-shaped error
  // code the CLI can pattern-match on. Everything else falls through
  // to the raw type.
  let motebitCode = `STRIPE_${stripeType
    .toUpperCase()
    .replace(/^STRIPE/, "")
    .replace(/[^A-Z0-9]+/g, "_")}`;
  if (stripeMessage.includes("cannot currently make live charges")) {
    motebitCode = "STRIPE_ACCOUNT_NOT_ACTIVATED";
  } else if (stripeType === "StripeAuthenticationError") {
    motebitCode = "STRIPE_API_KEY_INVALID";
  } else if (stripeType === "StripeRateLimitError") {
    motebitCode = "STRIPE_RATE_LIMITED";
  } else if (stripeType === "StripeConnectionError") {
    motebitCode = "STRIPE_CONNECTION_FAILED";
  }

  // Log the full error server-side (correlationId tracks request);
  // return only the motebit-shaped payload to the client. Don't leak
  // raw Stripe internals (request IDs, header echoes) to callers.
  logger.warn("stripe.checkout.failed", {
    correlationId,
    motebitId,
    amount,
    via,
    stripeType,
    stripeCode,
    stripeMessage,
    requestId: stripeError?.requestId,
  });

  return c.json(
    {
      error: motebitCode,
      message: stripeMessage,
      stripe_type: stripeType,
      stripe_code: stripeCode,
      status: 502,
    },
    502,
  );
}

export interface BudgetDeps {
  app: Hono;
  moteDb: MotebitDatabase;
  relayIdentity: RelayIdentity;
  /** Mutable freeze state — shared with index.ts middleware. */
  freezeState: { frozen: boolean; reason: string | null };
  stripeClient: Stripe | null;
  stripeConfig: { secretKey: string; webhookSecret: string; currency?: string } | null;
  /** Settlement rail registry — holds configured rails by name. */
  railRegistry?: SettlementRailRegistry;
  /**
   * Operator-side Solana transfer primitive — drives Path 0 withdrawals
   * (relay treasury → user sovereign wallet, native onchain return of
   * custody). Constructed from the relay identity seed + SOLANA_RPC_URL
   * at boot; the treasury address is the relay's identity-derived Solana
   * wallet by curve coincidence (same key used by SolanaMemoSubmitter).
   * Absent when SOLANA_RPC_URL is unset — a Solana withdrawal then stays
   * pending for the operator (Path 1 is retired, #948).
   */
  operatorSolanaTransfer?: import("@motebit/wallet-solana").OperatorSolanaTransfer;
  /**
   * How long a claimed Path 0 payout may stay undecided before the relay
   * broadcasts its KILL (#990). Default `PAYOUT_KILL_AFTER_MS`.
   */
  payoutKillAfterMs?: number;
}

/** Default wait before an undecided durable payout is killed (#990): 5 minutes. */
export const PAYOUT_KILL_AFTER_MS = 5 * 60 * 1000;

/** What `registerBudgetRoutes` hands back to the relay's wiring. */
export interface BudgetRoutes {
  /**
   * One tick of Path 0 payout resolution (#990): fire queued payouts when
   * the nonce lane is free, then decide every processing chain-recorded
   * payout it can — complete on a finalized payout, refund on a finalized
   * kill or failed payout, kill one undecided past `payoutKillAfterMs`.
   */
  resolvePayoutsOnce(): Promise<void>;
}

export function registerBudgetRoutes(deps: BudgetDeps): BudgetRoutes {
  const {
    app,
    moteDb,
    relayIdentity,
    freezeState,
    stripeClient,
    stripeConfig,
    railRegistry,
    operatorSolanaTransfer,
  } = deps;
  const stripeRail = railRegistry?.get("stripe") as StripeSettlementRail | undefined;

  /**
   * Withdrawals whose automated payout this process is handling right now
   * (#921) — from the claim until the payout's outcome is WRITTEN (the
   * completion, the refund or the unresolved note), not merely until the
   * send returns: between the two the handler still awaits the receipt
   * signature, and a reconcile landing there would refund a payout that the
   * next line records as paid. The reconcile door refuses them outright.
   */
  const payoutsInFlight = new Set<string>();

  /** Release a payout from this process: its outcome is written (or could not be). */
  const releasePayout = (withdrawalId: string): void => {
    payoutsInFlight.delete(withdrawalId);
  };

  // ── Path 0: durable-nonce payouts, decided by consensus rules (#990) ───
  //
  // The treasury owns one durable nonce account (one lane). A payout is
  // signed with `nonceAdvance` first and the lane's current nonce value N
  // (read at FINALIZED commitment) as its blockhash, and recorded with N
  // BEFORE it is broadcast. It never expires and is never re-signed. Of all
  // transactions over N at most one lands, so the outcome is decided only by
  // FINALIZED statuses (withdrawal-chain-payouts.ts):
  //   - the payout finalized ok        ⇒ completed;
  //   - the payout finalized with err  ⇒ refunded (N consumed, nothing moved);
  //   - the KILL (nonceAdvance alone over N) finalized ⇒ refunded;
  //   - anything else ⇒ undecided, read again; past `killAfterMs` the kill is
  //     broadcast (a kill is safe at any time: only one of the two can land).
  // One lane ⇒ payouts serialize: a new payout is signed only when the
  // lane's finalized N is carried by no recorded transaction (the previous
  // payout is decided) — otherwise it waits in the queue, `pending`.
  const killAfterMs = deps.payoutKillAfterMs ?? PAYOUT_KILL_AFTER_MS;
  /**
   * The squatted lane this resolution tick found (#990 round 7): set by
   * `firePathZero`, raised by `resolvePayoutsOnce` at the end of the tick so
   * the supervised loop reads ERRORING at /admin/health, naming the address.
   */
  let squatThisTick: { address: string; reason: string } | null = null;
  /**
   * Nonce values this process has claimed and not yet recorded. The busy
   * check, the claim and this reservation run with no await between them
   * (after the lane read), so two requests in this process never sign over
   * one nonce value; once the payout is recorded, the attempts table carries
   * it (`isNonceValueUsed`).
   */
  const reservedNonces = new Set<string>();

  /** Complete a processing withdrawal whose payout the chain shows finalized ok. */
  const completeFromChain = async (
    w: WithdrawalRequest,
    signature: string,
    correlationId: string | null,
  ): Promise<void> => {
    const completedAt = Date.now();
    const signed = await signCompletion(w.withdrawal_id, w, signature, completedAt);
    const ok = completeWithdrawal(
      moteDb.db,
      w.withdrawal_id,
      signature,
      "processing",
      signed.signature,
      signed.relayPublicKeyHex,
      completedAt,
    );
    if (ok) {
      logger.info("withdrawal.solana.auto_settled", {
        correlationId,
        motebitId: w.motebit_id,
        withdrawalId: w.withdrawal_id,
        txSignature: signature,
        finality: "finalized",
      });
    } else {
      logger.error("withdrawal.payout_settle_lost", {
        correlationId,
        withdrawalId: w.withdrawal_id,
        outcome: "finalized_ok",
        txSignature: signature,
        status: getWithdrawalById(moteDb.db, w.withdrawal_id)?.status ?? null,
        note: "the payout finalized but the withdrawal is no longer `processing`; reconcile the ledger against the chain",
      });
    }
  };

  /** Refund a processing withdrawal the chain proves unpaid. */
  const refundFromChain = (
    w: WithdrawalRequest,
    by: "no_broadcast" | "payout_failed" | "killed",
    correlationId: string | null,
  ): void => {
    const why = {
      no_broadcast: "no transaction of this payout was ever broadcast",
      payout_failed: "the payout landed and failed on chain (finalized): no USDC moved",
      killed:
        "the kill transaction consumed the payout's durable nonce (finalized): the payout can never land",
    }[by];
    const ok = failWithdrawal(
      moteDb.db,
      w.withdrawal_id,
      `solana payout not paid — ${why}; amount returned to balance`,
      "processing",
    );
    if (ok) {
      logger.warn("withdrawal.solana.refunded_from_chain", {
        correlationId,
        motebitId: w.motebit_id,
        withdrawalId: w.withdrawal_id,
        by,
      });
    } else {
      logger.error("withdrawal.payout_settle_lost", {
        correlationId,
        withdrawalId: w.withdrawal_id,
        outcome: `not_paid:${by}`,
        status: getWithdrawalById(moteDb.db, w.withdrawal_id)?.status ?? null,
      });
    }
  };

  /**
   * Decide one processing chain-recorded withdrawal from the chain (#990):
   * complete, refund, or leave it (and, past `killAfterMs`, broadcast its
   * kill). `inline`: called by the send path that holds the payout in flight.
   */
  const resolveWithdrawal = async (
    withdrawalId: string,
    opts: { inline: boolean; correlationId: string | null },
  ): Promise<void> => {
    const transfer = operatorSolanaTransfer;
    if (!transfer) return;
    const w = getWithdrawalById(moteDb.db, withdrawalId);
    if (!w || w.status !== "processing") {
      if (opts.inline) {
        // The send path's own payout, and the row moved while it was out:
        // never silent (#921) — the payout's outcome and the row disagree.
        logger.error("withdrawal.payout_settle_lost", {
          correlationId: opts.correlationId,
          withdrawalId,
          path: "solana",
          status: w?.status ?? null,
          txSignature:
            getPayoutAttempts(moteDb.db, withdrawalId).find((a) => a.kind === "payout")
              ?.signature ?? null,
          note: "the withdrawal left `processing` while its payout was out; reconcile the ledger against the chain",
        });
      }
      return;
    }
    if (!isChainRecordedClaim(moteDb.db, withdrawalId)) return;
    if (!opts.inline && payoutsInFlight.has(withdrawalId)) return;
    const verdict = await readChainVerdict(moteDb.db, withdrawalId, transfer);
    if (verdict.kind === "paid") {
      if (verdict.landed.length > 1) {
        logger.error("withdrawal.payout_landed_twice", {
          correlationId: opts.correlationId,
          withdrawalId,
          landed: verdict.landed,
        });
      }
      await completeFromChain(w, verdict.signature, opts.correlationId);
      return;
    }
    if (verdict.kind === "not_paid") {
      refundFromChain(w, verdict.by, opts.correlationId);
      return;
    }
    if (opts.inline) {
      noteWithdrawalPayoutUnresolved(
        moteDb.db,
        withdrawalId,
        `payout ${verdict.signature} not finalized yet (${verdict.reason}); the relay decides it from finalized chain state — a finalized payout completes it, a finalized kill of its durable nonce refunds it (#990)`,
      );
      return;
    }
    const claimedAt = w.claimed_at ?? w.requested_at;
    if (verdict.killable && Date.now() - claimedAt >= killAfterMs) {
      const kill = await requestKill(moteDb.db, withdrawalId, transfer);
      if (kill.status === "consumed") {
        logger.error("withdrawal.solana.nonce_consumed_unrecorded", {
          correlationId: opts.correlationId,
          withdrawalId,
          signature: verdict.signature,
          note: "the payout's durable nonce moved without a finalized transaction this relay recorded: either the payout landed and its status cannot be read, or an unrecorded transaction (another tool or process holding the treasury key) consumed the nonce. The payout can never land now; the operator settles it — paid naming the payout, or not_paid with override nonce_consumed_unrecorded and an attestation",
        });
      }
      logger.warn("withdrawal.solana.kill_requested", {
        correlationId: opts.correlationId,
        withdrawalId,
        signature: verdict.signature,
        kill: kill.status,
      });
    }
  };

  /**
   * Fire Path 0 for a `pending` withdrawal (#990). Never throws. Under the
   * lane: read N (finalized), refuse a busy or unavailable lane (queued,
   * stays `pending`), claim (`pending → processing` + the chain marker, one
   * transaction), reserve N. Then sign, record, broadcast, wait bounded for
   * finality, and decide what the chain already shows.
   */
  const firePathZero = async (
    withdrawalId: string,
    correlationId: string | null,
  ): Promise<void> => {
    const transfer = operatorSolanaTransfer;
    if (!transfer || transfer.recordsBroadcasts !== true) return;
    const claimed = await (async () => {
      const w = getWithdrawalById(moteDb.db, withdrawalId);
      if (!w || w.status !== "pending") {
        dequeuePayout(moteDb.db, withdrawalId);
        return null;
      }
      let lane: Awaited<ReturnType<typeof transfer.prepareNonceLane>>;
      try {
        lane = await withTimeout(
          transfer.prepareNonceLane(),
          CHAIN_READ_TIMEOUT_MS * 3,
          "nonce lane",
        );
      } catch (err) {
        lane = { status: "unavailable", reason: err instanceof Error ? err.message : String(err) };
      }
      if (lane.status !== "ready" && lane.squatted !== undefined) {
        enqueuePayout(moteDb.db, withdrawalId, Date.now());
        squatThisTick = { address: lane.squatted.address, reason: lane.reason };
        logger.error("withdrawal.solana.nonce_lane_squatted", {
          correlationId,
          withdrawalId,
          address: lane.squatted.address,
          reason: lane.reason,
          note: "no payout sent: the payout nonce lane's address holds an account this treasury can never use; rotate the lane with SOLANA_PAYOUT_NONCE_SEED_SUFFIX (spec/market-v1.md §10.2). The withdrawal stays pending (queued; /fail still works)",
        });
        return null;
      }
      if (lane.status !== "ready") {
        enqueuePayout(moteDb.db, withdrawalId, Date.now());
        logger.warn("withdrawal.solana.nonce_lane_unavailable", {
          correlationId,
          withdrawalId,
          reason: lane.reason,
          note: "no payout sent: the treasury's durable nonce account is unavailable; the withdrawal stays pending (queued; /fail still works)",
        });
        return null;
      }
      if (reservedNonces.has(lane.nonceValue) || isNonceValueUsed(moteDb.db, lane)) {
        enqueuePayout(moteDb.db, withdrawalId, Date.now());
        logger.info("withdrawal.solana.nonce_lane_busy", { correlationId, withdrawalId });
        return null;
      }
      const claimedAt = Date.now();
      const won = moteDb.db.transaction(() => {
        const ok = claimWithdrawalForPayout(moteDb.db, withdrawalId, claimedAt, null);
        if (ok) markChainRecordedClaim(moteDb.db, withdrawalId, "solana", claimedAt);
        dequeuePayout(moteDb.db, withdrawalId);
        return ok;
      });
      if (!won) {
        logger.error("withdrawal.payout_claim_lost", {
          correlationId,
          withdrawalId,
          path: "solana",
          status: getWithdrawalById(moteDb.db, withdrawalId)?.status ?? null,
          note: "no payout sent: the withdrawal left `pending` before this request claimed it",
        });
        return null;
      }
      reservedNonces.add(lane.nonceValue);
      payoutsInFlight.add(withdrawalId);
      return { w, lane: { account: lane.account, nonceValue: lane.nonceValue } };
    })();
    if (!claimed) return;
    try {
      try {
        const sent = await transfer.sendPayout(
          claimed.w.destination,
          BigInt(claimed.w.amount),
          claimed.lane,
          {
            beforeBroadcast: (tx) => recordDurableAttempt(moteDb.db, withdrawalId, tx, Date.now()),
          },
        );
        logger.info("withdrawal.solana.payout_broadcast", {
          correlationId,
          withdrawalId,
          txSignature: sent.tx.signature,
          nonceAccount: sent.tx.nonceAccount,
          final:
            sent.final.status === "finalized" ? (sent.final.ok ? "ok" : "err") : sent.final.reason,
        });
      } catch (err) {
        // Thrown before anything was recorded (invalid address, balance,
        // a hook that could not record): nothing was sent.
        logger.warn("withdrawal.solana.send_threw", {
          correlationId,
          withdrawalId,
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        reservedNonces.delete(claimed.lane.nonceValue);
      }
      await resolveWithdrawal(withdrawalId, { inline: true, correlationId });
    } catch (err) {
      logger.error("withdrawal.solana.resolve_failed", {
        correlationId,
        withdrawalId,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      releasePayout(withdrawalId);
    }
  };

  const resolvePayoutsOnce = async (): Promise<void> => {
    const transfer = operatorSolanaTransfer;
    if (!transfer || transfer.recordsBroadcasts !== true) return;
    squatThisTick = null;
    // Queued payouts, oldest first, while the lane takes them.
    for (const id of queuedPayouts(moteDb.db)) {
      await firePathZero(id, null);
      const now = getWithdrawalById(moteDb.db, id);
      if (now?.status === "pending") break; // the lane is still busy or unavailable
    }
    const processing = (
      moteDb.db
        .prepare(
          `SELECT w.withdrawal_id AS withdrawal_id FROM relay_withdrawals w
             JOIN relay_withdrawal_chain_claims c ON c.withdrawal_id = w.withdrawal_id
            WHERE w.status = 'processing'
            ORDER BY w.claimed_at ASC LIMIT 200`,
        )
        .all() as Array<{ withdrawal_id: string }>
    ).map((r) => r.withdrawal_id);
    await mapBounded(processing, 4, async (id) => {
      try {
        await resolveWithdrawal(id, { inline: false, correlationId: null });
      } catch (err) {
        logger.error("withdrawal.solana.resolve_failed", {
          withdrawalId: id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });
    // A squatted lane is an operator alarm, not a transient: fail the tick
    // (after deciding every processing payout) so the supervisor shows it.
    const squat = squatThisTick as { address: string; reason: string } | null;
    if (squat !== null) {
      throw new Error(
        `payout nonce lane squatted at ${squat.address} (${squat.reason}); Path 0 payouts are queued until the operator rotates SOLANA_PAYOUT_NONCE_SEED_SUFFIX`,
      );
    }
  };

  // NOTE: the self-declared `POST /api/v1/agents/:id/deposit` route was
  // removed (2026-07-01). It credited spendable balance from a client-
  // supplied amount under the account owner's own device token, with no
  // funding-provenance check anywhere in the deposit→withdraw path — a
  // treasury-drain vector (self-declare balance → auto-settled withdrawal).
  // Balance is credited ONLY by verified funding: the onchain deposit-
  // detector and the Stripe webhook, both via `creditAccount` server-side.
  // Tests seed via `seedBalance` (test-helpers), not an HTTP money route.

  // First-person own-id check for the account family (#460). The account:*
  // audiences prove the caller controls SOME registered device key — they
  // bind the token to the caller's own mid, not to the :motebitId in the
  // path. Without this check, any authenticated agent could read another
  // agent's balance/transactions or, worse, POST a withdraw against another
  // agent's account with a self-supplied destination. A master token
  // (callerMotebitId unset) bypasses for the operator console — the same
  // shape as the /settlements handler in state-export.ts.
  const requireFirstPerson = (c: Context, motebitId: string, what: string): void => {
    const callerMotebitId = c.get("callerMotebitId" as never) as string | undefined;
    if (callerMotebitId != null && callerMotebitId !== "" && callerMotebitId !== motebitId) {
      throw new HTTPException(403, {
        message: `${what} is first-person: a device token may act only on its own motebit's account`,
      });
    }
  };

  // --- Balance ---
  /** @internal */
  app.get("/api/v1/agents/:motebitId/balance", (c) => {
    const motebitId = c.req.param("motebitId");
    requireFirstPerson(c, motebitId, "balance");
    const account = getAccountBalance(moteDb.db, motebitId);
    if (!account)
      return c.json({
        motebit_id: motebitId,
        balance: 0,
        currency: "USD",
        pending_withdrawals: 0,
        pending_allocations: 0,
        dispute_window_hold: 0,
        available_for_withdrawal: 0,
        sweep_threshold: null,
        settlement_address: null,
        transactions: [],
      } satisfies AccountBalanceResult);
    const detailed = getAccountBalanceDetailed(moteDb.db, motebitId);
    const transactions = getTransactions(moteDb.db, motebitId, 50).map((tx) => ({
      ...tx,
      amount: fromMicro(tx.amount),
      balance_after: fromMicro(tx.balance_after),
    }));
    return c.json({
      motebit_id: motebitId,
      balance: fromMicro(detailed.balance),
      currency: detailed.currency,
      pending_withdrawals: fromMicro(detailed.pending_withdrawals),
      pending_allocations: fromMicro(detailed.pending_allocations),
      dispute_window_hold: fromMicro(detailed.dispute_window_hold),
      available_for_withdrawal: fromMicro(detailed.available_for_withdrawal),
      sweep_threshold:
        detailed.sweep_threshold != null ? fromMicro(detailed.sweep_threshold) : null,
      settlement_address: detailed.settlement_address,
      transactions,
      // `satisfies` binds the producer to the market-v1 §2.6 wire law at
      // compile time — a field rename here breaks the build, not the
      // clients. Runtime behavior unchanged (no strict parse on inbound).
    } satisfies AccountBalanceResult);
  });

  // --- Withdraw ---
  /** @internal */
  app.post("/api/v1/agents/:motebitId/withdraw", async (c) => {
    const motebitId = c.req.param("motebitId");
    requireFirstPerson(c, motebitId, "withdraw");
    const correlationId = c.get("correlationId" as never) as string;

    // Idempotency key required for financial operations
    const idempotencyKeyHeader = c.req.header("Idempotency-Key");
    if (!idempotencyKeyHeader) {
      throw new HTTPException(400, {
        message: "Idempotency-Key header is required for financial operations",
      });
    }

    // Check idempotency before parsing body — replays skip all side effects
    const idempCheck = checkIdempotency(moteDb.db, idempotencyKeyHeader, motebitId);
    if (idempCheck.action === "replay") {
      return c.json(
        JSON.parse(idempCheck.body) as Record<string, unknown>,
        idempCheck.status as 200,
      );
    }
    if (idempCheck.action === "conflict") {
      throw new HTTPException(409, {
        message: "A request with this idempotency key is already being processed",
      });
    }

    const body = await c.req.json<{
      amount: number;
      destination?: string;
      idempotency_key?: string;
    }>();
    if (typeof body.amount !== "number" || body.amount <= 0) {
      const errBody = JSON.stringify({ error: "amount must be a positive number", status: 400 });
      completeIdempotency(moteDb.db, idempotencyKeyHeader, motebitId, 400, errBody);
      throw new HTTPException(400, { message: "amount must be a positive number" });
    }

    // #948: no path can pay an EVM (0x) destination, so refuse it BEFORE any
    // debit — a withdrawal method that cannot work is not offered. (Before
    // #948 it was handed to an x402 "payout" signed with the idempotency
    // key, which no facilitator can execute.)
    if (typeof body.destination === "string" && EVM_DEST_RE.test(body.destination)) {
      const errBody = JSON.stringify(EVM_WITHDRAWAL_UNSUPPORTED);
      completeIdempotency(moteDb.db, idempotencyKeyHeader, motebitId, 400, errBody);
      logger.info("withdrawal.endpoint.evm_refused", { correlationId, motebitId });
      return c.json(EVM_WITHDRAWAL_UNSUPPORTED, 400);
    }

    const amountMicro = toMicro(body.amount);
    // Pass the header key as the withdrawal-level idempotency key too (backward compat)
    const idempotencyKey = body.idempotency_key ?? idempotencyKeyHeader;
    const result = requestWithdrawal(
      moteDb.db,
      motebitId,
      amountMicro,
      body.destination ?? "pending",
      idempotencyKey,
    );
    if (result === null) {
      const errBody = JSON.stringify({ error: "Insufficient balance for withdrawal", status: 402 });
      completeIdempotency(moteDb.db, idempotencyKeyHeader, motebitId, 402, errBody);
      throw new HTTPException(402, { message: "Insufficient balance for withdrawal" });
    }

    if ("existing" in result) {
      logger.info("withdrawal.endpoint.idempotent", {
        correlationId,
        motebitId,
        withdrawalId: result.existing.withdrawal_id,
        idempotencyKey,
      });
      const responseBody = {
        motebit_id: motebitId,
        withdrawal: toWithdrawalRecord(result.existing, relayIdentity.relayMotebitId),
        idempotent: true,
      } satisfies AccountWithdrawResult;
      completeIdempotency(
        moteDb.db,
        idempotencyKeyHeader,
        motebitId,
        200,
        JSON.stringify(responseBody),
      );
      return c.json(responseBody);
    }

    logger.info("withdrawal.endpoint.requested", {
      correlationId,
      motebitId,
      withdrawalId: result.withdrawal_id,
      amount: body.amount,
      destination: result.destination,
      idempotencyKey: idempotencyKey ?? null,
    });

    // Automated settlement: Path 0 only, for a Solana-shaped destination.
    // EVM (0x) destinations were refused above (#948); any other
    // destination stays `pending` for the operator.
    const isSolanaDest =
      result.destination !== "pending" && SOLANA_DEST_RE.test(result.destination);

    // Path 0: native Solana sovereign return of custody, as a durable-nonce
    // payout decided by consensus rules (#990; see `firePathZero`). The
    // relay signs from its own treasury (identity-derived, by curve
    // coincidence) to the user's own wallet — same-party return of custody.
    //
    // Claim before send (#921; spec/market-v1.md §10.3): no payout is sent
    // until this withdrawal is claimed `pending → processing`, and after the
    // claim only the chain's FINALIZED state settles it — a finalized payout
    // completes it, a finalized failure or kill refunds it — or the
    // operator's reconcile. A transfer that cannot make such a payout
    // (`recordsBroadcasts`) is never used: the withdrawal stays pending.
    const pathZeroReady = operatorSolanaTransfer?.recordsBroadcasts === true;
    if (isSolanaDest && operatorSolanaTransfer && !pathZeroReady) {
      logger.error("withdrawal.solana.unrecordable_transfer", {
        correlationId,
        motebitId,
        withdrawalId: result.withdrawal_id,
        note: "no payout sent: the Solana transfer cannot make a durable-nonce payout decidable from finalized chain state; the withdrawal stays pending",
      });
    }
    if (isSolanaDest && operatorSolanaTransfer && pathZeroReady) {
      await firePathZero(result.withdrawal_id, correlationId);
    }

    // Path 2 deleted in Arc 1 Commit 2 of the off-ramp arc.
    //
    // Bridge no longer routes user-facing withdrawals — the doctrine is
    // enforced structurally: `BridgeSettlementRail.withdraw()` was
    // removed at the package level (see `packages/settlement-rails/src/
    // bridge-rail.ts` header). `isWithdrawableRail(bridgeRail)` returns
    // false; any attempt to call `bridgeRail.withdraw(...)` is a compile
    // error. Bridge stays registered for treasury operations only.
    //
    // Path 1 (x402 to an EVM wallet) deleted too (#948): the x402 rail's
    // withdraw put the idempotency key where the EIP-3009 signature belongs,
    // so no facilitator could execute it, and the relay holds no EVM
    // treasury key to sign a real one. `X402SettlementRail` is structurally
    // non-withdrawable now, and a 0x destination is refused before any debit.
    //
    // If Path 0 did not settle it, the withdrawal stays pending (or, once
    // claimed, processing) for admin resolution. Funds remain
    // held by `requestWithdrawal` — no double-spend risk. This is the
    // intended behavior under the doctrine "Motebit is not a transmitter
    // of user funds": withdrawals route through user-held wallets or
    // they don't auto-complete at all.
    //
    // Doctrine: docs/doctrine/settlement-rails.md § "Lanes for external
    // readers" + the future `off-ramp-as-user-action.md`.

    // On auto-settle, re-read the completed row so the response reflects the
    // signature, payout_reference, completed_at, and status the settlement
    // path just persisted — the DB is the single source of truth. Building
    // from the stale pre-completion `result` would return a "completed"
    // withdrawal with null signature, defeating offline self-verifiability.
    //
    // Re-read on EVERY outcome, not only auto-settle: a landed-and-failed
    // send (#920) moves the row to `failed` with a reason, and the response
    // must say so rather than echo the stale `pending` record.
    const finalRecord = getWithdrawalById(moteDb.db, result.withdrawal_id) ?? result;
    const responseBody = {
      motebit_id: motebitId,
      // `satisfies` binds the producer to the market-v1 §2.9 wire law at
      // compile time; runtime behavior unchanged.
      withdrawal: toWithdrawalRecord(finalRecord, relayIdentity.relayMotebitId),
    } satisfies AccountWithdrawResult;
    completeIdempotency(
      moteDb.db,
      idempotencyKeyHeader,
      motebitId,
      200,
      JSON.stringify(responseBody),
    );
    return c.json(responseBody);
  });

  // --- Withdrawal history ---
  /** @internal */
  app.get("/api/v1/agents/:motebitId/withdrawals", (c) => {
    const motebitId = c.req.param("motebitId");
    requireFirstPerson(c, motebitId, "withdrawal history");
    const withdrawals = getWithdrawals(moteDb.db, motebitId, 50).map((w) =>
      toWithdrawalRecord(w, relayIdentity.relayMotebitId),
    );
    return c.json({ motebit_id: motebitId, withdrawals });
  });

  // --- Admin: pending withdrawals ---
  /** @internal */
  // Lists `pending` AND `processing` rows. Each carries `status` and
  // `claimed_at`; a `processing` row carries `reconcile_opens_at` — the same
  // moment the reconcile route enforces (`reconcileOpensAt`), or null while
  // its payout is in flight in this process — and
  // `payout_may_have_been_attempted` flags a pre-#921 row (see
  // `payoutMayHaveBeenAttempted`). `reconcile_min_age_ms` is the floor only.
  app.get("/api/v1/admin/withdrawals/pending", (c) => {
    const withdrawals = getPendingWithdrawals(moteDb.db).map((w) => ({
      ...w,
      amount: fromMicro(w.amount),
      payout_may_have_been_attempted: payoutMayHaveBeenAttempted(w),
      ...reconcileStateOf(w),
      payout_in_flight_here: payoutsInFlight.has(w.withdrawal_id),
    }));
    return c.json({
      withdrawals,
      count: withdrawals.length,
      reconcile_min_age_ms: RECONCILE_MIN_AGE_MS,
    });
  });

  // --- Admin: pre-#921 withdrawals to check on chain (read-only) ---
  //
  // Every `pending` withdrawal that was already `pending` when this ledger
  // gained claim-before-send (marked durably, once, by the migration that
  // added `claimed_at`), or that carries a payout reference. Before #921 an
  // automated send left no claim, so any of these may have been paid; check
  // the chain for each before the first manual /fail after deploy. Read-only.
  /** @internal */
  app.get("/api/v1/admin/withdrawals/pre-claim", (c) => {
    const withdrawals = getPendingWithdrawals(moteDb.db)
      .filter((w) => payoutMayHaveBeenAttempted(w))
      .map((w) => ({ ...w, amount: fromMicro(w.amount) }));
    return c.json({
      withdrawals,
      count: withdrawals.length,
      note: "a payout may have been attempted for each of these before claims were recorded — check the chain before failing",
    });
  });

  // --- Admin: settling a withdrawal (#921) ---
  //
  // Three doors, split by the state they own (spec/market-v1.md §10.3):
  //
  //   - /complete and /fail act on a `pending` withdrawal only — one no
  //     payout ever claimed (a manual/off-rail payout, a destination no
  //     automated path serves). On a `processing` withdrawal they refuse
  //     409: its payout was handed to a rail and may still land, so a
  //     manual fail could refund a payout that then pays (the #921 double
  //     pay), and a manual complete could record a second payout.
  //   - /reconcile acts on a `processing` withdrawal only, and only once its
  //     payout provably landed or can never land: never while this process
  //     is still handling it (claim → outcome written), and then by who
  //     decides (payout-horizon.ts table):
  //       * a chain-recorded Path 0 payout — THE CHAIN, read for every
  //         signature the payout signed (withdrawal-chain-payouts.ts), from
  //         FINALIZED statuses only (#990): a finalized payout ⇒ only `paid`
  //         with that signature; a finalized failure or KILL of its durable
  //         nonce ⇒ only `not_paid`; otherwise `not_paid` broadcasts the
  //         kill and is refused until it is finalized, and `paid` naming a
  //         recorded payout is accepted unless a recorded status is found
  //         unfinalized. No wall-clock term.
  //       * a legacy Path 0 claim (an earlier process, no signatures) —
  //         the relay can never hold positive evidence it did not land (no
  //         durable nonce to kill), so `not_paid` is always refused and the
  //         operator's `paid` is accepted.
  //       * a declared horizon (legacy x402, batch rails) —
  //         `reconcileOpensAt`: the rail's declared validity + margin,
  //         floored at RECONCILE_MIN_AGE_MS after the claim.
  //     Always on an explicit operator attestation. This is the door for a
  //     payout whose outcome is unknown — the send threw, or the process
  //     died mid-send — so a crash never strands a withdrawal with no way
  //     out, and it is never a blind refund.

  /**
   * Why a `processing` withdrawal cannot be reconciled yet (#921, #949, #990):
   *   - `in_flight_here`: this relay is still handling its payout;
   *   - `undetermined`: the relay cannot place the payout's horizon (fail
   *     closed);
   *   - `horizon`: a declared-horizon payout may still land until
   *     `reconcile_opens_at`;
   *   - `chain_pending`: nothing this payout recorded is FINALIZED yet (a
   *     status found below finality may be a minority fork);
   *   - `chain_unreadable`: the chain could not be read, so nothing is
   *     decided;
   *   - `kill_pending`: the operator's `not_paid` broadcast the KILL for the
   *     payout's durable nonce (#990); the refund follows its FINALIZED
   *     status (the relay settles it, or a later reconcile does);
   *   - `nonce_consumed_unrecorded`: the payout's durable nonce already moved,
   *     by no finalized transaction this relay recorded (#990 round 7) — the
   *     payout can never land, but "landed, status unreadable" cannot be told
   *     from "consumed by an unrecorded transaction": `paid` naming the
   *     payout, or `not_paid` with `override: "nonce_consumed_unrecorded"`;
   *   - `kill_not_sent`: the RPC refused the kill broadcast — proves nothing;
   *   - `chain_no_positive_evidence`: no positive evidence of non-landing can
   *     exist — a payout that is not durable-nonce (claimed before #990, or
   *     with no recorded signature): never refunded; `paid` accepted.
   * `open` means the reconcile door is open now — for a chain-decided payout
   * (`reconcile_decided_by: "chain"`), that the relay asks the chain when the
   * operator reconciles, and may still refuse; for a legacy claim
   * (`"operator_attested"`), that `paid` is accepted and `not_paid` refused.
   */
  type ReconcileState =
    | "in_flight_here"
    | "undetermined"
    | "horizon"
    | "chain_pending"
    | "chain_unreadable"
    | "kill_pending"
    | "nonce_consumed_unrecorded"
    | "kill_not_sent"
    | "chain_no_positive_evidence"
    | "open";

  /** Who decides whether a `processing` withdrawal's payout landed. */
  type ReconcileDecidedBy = "chain" | "operator_attested" | "declared_horizon";

  function decidedByOf(w: WithdrawalRequest): ReconcileDecidedBy {
    if (isChainRecordedClaim(moteDb.db, w.withdrawal_id)) return "chain";
    return w.payout_valid_until == null ? "operator_attested" : "declared_horizon";
  }

  function reconcileStateOf(w: WithdrawalRequest): {
    reconcile_state: ReconcileState | null;
    reconcile_opens_at: number | null;
    reconcile_decided_by: ReconcileDecidedBy | null;
  } {
    if (w.status !== "processing") {
      return { reconcile_state: null, reconcile_opens_at: null, reconcile_decided_by: null };
    }
    const decidedBy = decidedByOf(w);
    if (payoutsInFlight.has(w.withdrawal_id)) {
      return {
        reconcile_state: "in_flight_here",
        reconcile_opens_at: null,
        reconcile_decided_by: decidedBy,
      };
    }
    if (decidedBy === "operator_attested") {
      // A legacy claim: `paid` is accepted and `not_paid` refused whatever
      // the chain shows (#949 round 5) — no chain read either way.
      return {
        reconcile_state: "open",
        reconcile_opens_at: w.claimed_at ?? w.requested_at,
        reconcile_decided_by: decidedBy,
      };
    }
    if (decidedBy !== "declared_horizon") {
      // The chain decides at reconcile time (no chain read on a list): the
      // door is open to ASK; the refusal says what the chain showed.
      return {
        reconcile_state: operatorSolanaTransfer ? "open" : "undetermined",
        reconcile_opens_at: operatorSolanaTransfer ? (w.claimed_at ?? w.requested_at) : null,
        reconcile_decided_by: decidedBy,
      };
    }
    const now = Date.now();
    const opensAt = reconcileOpensAt(w);
    if (opensAt === null) {
      return {
        reconcile_state: "undetermined",
        reconcile_opens_at: null,
        reconcile_decided_by: decidedBy,
      };
    }
    return {
      reconcile_state: now >= opensAt ? "open" : "horizon",
      reconcile_opens_at: opensAt,
      reconcile_decided_by: decidedBy,
    };
  }

  const PAYOUT_IN_FLIGHT_MESSAGES: Record<Exclude<ReconcileState, "open"> | "processing", string> =
    {
      processing:
        "payout in flight — reconcile after the send resolves (POST /api/v1/admin/withdrawals/:withdrawalId/reconcile)",
      in_flight_here:
        "payout in flight — the relay is still handling this payout; reconcile after its outcome is recorded",
      undetermined:
        "payout horizon cannot be determined yet — the relay cannot place when this payout stops being able to land; reconcile stays closed",
      horizon: "payout may still land — reconcile opens at",
      chain_pending:
        "payout undecided — nothing this payout recorded is finalized on chain yet (a status below finality may be a minority fork); the relay settles it once the payout or its kill is finalized",
      chain_unreadable:
        "the chain could not be read — whether this payout landed is undecided; reconcile stays closed until the chain answers",
      kill_pending:
        "not_paid needs positive evidence: the relay broadcast the kill transaction for this payout's durable nonce (#990) — once it or the payout is finalized the withdrawal is settled (refunded, or completed if the payout landed first); retry the reconcile then",
      nonce_consumed_unrecorded:
        "this payout's durable nonce was consumed by a transaction the relay did not record (another tool or process holding the treasury key, or the payout itself whose status can no longer be read) — the payout can never land now, but the chain cannot show which. Reconcile as paid with the payout's signature if it landed; otherwise not_paid with override \"nonce_consumed_unrecorded\" and an attestation (an attested decision, logged)",
      kill_not_sent:
        "the RPC refused the kill broadcast for this payout's durable nonce — that proves nothing either way; retry the reconcile (the relay also retries the kill)",
      chain_no_positive_evidence:
        "no positive evidence that this payout did NOT land can exist — it was not signed over a durable nonce (claimed before #990, or no signature recorded), so no kill can make it unlandable and absence proves nothing; no refund. Reconcile as paid with the landed signature if it landed",
    };

  const payoutInFlightResponse = (
    c: Context,
    withdrawalId: string,
    reason: Exclude<ReconcileState, "open"> | "processing" = "processing",
    opensAt: number | null = null,
    chain: Record<string, unknown> | null = null,
  ): Response => {
    const at =
      reason === "horizon" && opensAt !== null && Number.isFinite(opensAt) ? opensAt : null;
    return c.json(
      {
        error: "WITHDRAWAL_PAYOUT_IN_FLIGHT",
        reason,
        message:
          at !== null
            ? `${PAYOUT_IN_FLIGHT_MESSAGES.horizon} ${new Date(at).toISOString()}`
            : PAYOUT_IN_FLIGHT_MESSAGES[reason === "horizon" ? "undetermined" : reason],
        withdrawal_id: withdrawalId,
        reconcile_opens_at: at,
        ...(chain ? { chain } : {}),
        status: 409,
      },
      409,
    );
  };

  /**
   * Store the proof record of an operator-recorded payout (manual complete or
   * a `paid` reconcile). Every completed withdrawal must have a proof record
   * for reconciliation check #6.
   */
  const attachOperatorProof = async (
    withdrawalId: string,
    payoutReference: string,
    completedAt: number,
    railName: string | undefined,
    network: string | undefined,
  ): Promise<void> => {
    // Attach proof through the rail boundary — sibling parity with deposit proof flows.
    if (railName && railRegistry) {
      const rail = railRegistry.get(railName);
      if (rail) {
        await rail.attachProof(withdrawalId, {
          reference: payoutReference,
          railType: rail.railType,
          network,
          confirmedAt: completedAt,
        });
      } else {
        // Unknown rail name — store manual proof so reconciliation still passes
        storeSettlementProof(
          moteDb.db,
          withdrawalId,
          {
            reference: payoutReference,
            railType: "manual",
            network,
            confirmedAt: completedAt,
          },
          `manual:${railName}`,
        );
      }
    } else {
      // No rail specified — manual/off-rail payout. Store a manual proof record so that
      // every completed withdrawal has an entry in relay_settlement_proofs.
      storeSettlementProof(
        moteDb.db,
        withdrawalId,
        {
          reference: payoutReference,
          railType: "manual",
          confirmedAt: completedAt,
        },
        "manual",
      );
    }
  };

  /** Sign the completion receipt for `withdrawalId` at `completedAt`. */
  const signCompletion = async (
    withdrawalId: string,
    w: { motebit_id: string; amount: number; currency: string; destination: string },
    payoutReference: string,
    completedAt: number,
  ): Promise<{ signature: string; relayPublicKeyHex: string }> => {
    const relayPublicKeyHex = bytesToHex(relayIdentity.publicKey);
    const signature = await signWithdrawalReceipt(
      {
        withdrawal_id: withdrawalId,
        motebit_id: w.motebit_id,
        amount: fromMicro(w.amount),
        currency: w.currency,
        destination: w.destination,
        payout_reference: payoutReference,
        completed_at: completedAt,
        relay_id: relayIdentity.relayMotebitId,
      },
      relayIdentity.privateKey,
    );
    return { signature, relayPublicKeyHex };
  };

  // --- Admin: complete withdrawal ---
  /** @internal */
  app.post("/api/v1/admin/withdrawals/:withdrawalId/complete", async (c) => {
    const withdrawalId = c.req.param("withdrawalId");
    const correlationId = c.get("correlationId" as never) as string;
    const body = await c.req.json<{
      payout_reference: string;
      /** Rail name (e.g., "stripe", "x402") for proof attachment. Optional — skips if not provided. */
      rail?: string;
      /** CAIP-2 network for the proof (e.g., "eip155:84532"). Optional. */
      network?: string;
    }>();
    if (!body.payout_reference || typeof body.payout_reference !== "string")
      throw new HTTPException(400, { message: "payout_reference is required" });

    const withdrawal = getWithdrawalById(moteDb.db, withdrawalId);
    if (withdrawal?.status === "processing") return payoutInFlightResponse(c, withdrawalId);
    if (withdrawal?.status !== "pending")
      throw new HTTPException(404, { message: "Withdrawal not found or already completed/failed" });

    const completedAt = Date.now();
    const { signature, relayPublicKeyHex } = await signCompletion(
      withdrawalId,
      withdrawal,
      body.payout_reference,
      completedAt,
    );

    // FROM `pending` only (#921): a payout that claimed the row during the
    // signing await owns it now.
    const success = completeWithdrawal(
      moteDb.db,
      withdrawalId,
      body.payout_reference,
      "pending",
      signature,
      relayPublicKeyHex,
      completedAt,
    );
    if (!success) {
      const now = getWithdrawalById(moteDb.db, withdrawalId);
      logger.error("withdrawal.admin.complete_lost", {
        correlationId,
        withdrawalId,
        status: now?.status ?? null,
        payoutReference: body.payout_reference,
      });
      if (now?.status === "processing") return payoutInFlightResponse(c, withdrawalId);
      throw new HTTPException(404, { message: "Withdrawal not found or already completed/failed" });
    }

    await attachOperatorProof(
      withdrawalId,
      body.payout_reference,
      completedAt,
      body.rail,
      body.network,
    );

    logger.info("withdrawal.admin.completed", {
      correlationId,
      withdrawalId,
      payoutReference: body.payout_reference,
      rail: body.rail ?? null,
      signed: true,
    });
    return c.json({
      withdrawal_id: withdrawalId,
      status: "completed",
      relay_signature: signature,
      relay_public_key: relayPublicKeyHex,
    });
  });

  // --- Admin: fail withdrawal ---
  /** @internal */
  app.post("/api/v1/admin/withdrawals/:withdrawalId/fail", async (c) => {
    const withdrawalId = c.req.param("withdrawalId");
    const correlationId = c.get("correlationId" as never) as string;
    const body = await c.req.json<{ reason: string }>();
    if (!body.reason || typeof body.reason !== "string")
      throw new HTTPException(400, { message: "reason is required" });

    // FROM `pending` only (#921): never refund a `processing` withdrawal,
    // whose payout may still land.
    const success = failWithdrawal(moteDb.db, withdrawalId, body.reason, "pending");
    if (!success) {
      const now = getWithdrawalById(moteDb.db, withdrawalId);
      if (now?.status === "processing") {
        logger.warn("withdrawal.admin.fail_refused_in_flight", { correlationId, withdrawalId });
        return payoutInFlightResponse(c, withdrawalId);
      }
      throw new HTTPException(404, { message: "Withdrawal not found or already completed/failed" });
    }

    logger.info("withdrawal.admin.failed", { correlationId, withdrawalId, reason: body.reason });
    return c.json({ withdrawal_id: withdrawalId, status: "failed", refunded: true });
  });

  // --- Admin: reconcile a claimed payout (#921) ---
  /** @internal */
  app.post("/api/v1/admin/withdrawals/:withdrawalId/reconcile", async (c) => {
    const withdrawalId = c.req.param("withdrawalId");
    const correlationId = c.get("correlationId" as never) as string;
    const body: {
      /** What the chain shows for this payout. */
      outcome?: unknown;
      /** The operator's statement of what they checked (explorer lookup, signature, balance). Required. */
      attestation?: unknown;
      /** Required for `paid`: the transfer that paid it. */
      payout_reference?: unknown;
      /**
       * `nonce_consumed_unrecorded`: the operator's attested `not_paid` for a
       * payout whose nonce an unrecorded transaction consumed (#990 round 7).
       */
      override?: unknown;
      rail?: unknown;
      network?: unknown;
    } = await c.req.json<Record<string, unknown>>().catch(() => ({}));
    const outcome = body.outcome;
    if (outcome !== "paid" && outcome !== "not_paid")
      throw new HTTPException(400, { message: 'outcome must be "paid" or "not_paid"' });
    if (typeof body.attestation !== "string" || body.attestation.trim() === "")
      throw new HTTPException(400, {
        message:
          "attestation is required: state what the chain shows for this payout — a reconcile is never a blind refund",
      });
    const attestation = body.attestation.trim().slice(0, 2000);
    const payoutReference =
      typeof body.payout_reference === "string" && body.payout_reference !== ""
        ? body.payout_reference
        : null;
    if (outcome === "paid" && payoutReference === null)
      throw new HTTPException(400, { message: "payout_reference is required for outcome paid" });
    const railName = typeof body.rail === "string" ? body.rail : undefined;
    const network = typeof body.network === "string" ? body.network : undefined;

    const withdrawal = getWithdrawalById(moteDb.db, withdrawalId);
    if (!withdrawal) throw new HTTPException(404, { message: "Withdrawal not found" });
    if (withdrawal.status !== "processing") {
      return c.json(
        {
          error: "WITHDRAWAL_NOT_PROCESSING",
          message:
            withdrawal.status === "pending"
              ? "no payout claimed this withdrawal; settle a pending withdrawal with /complete or /fail"
              : `withdrawal is already ${withdrawal.status}`,
          withdrawal_id: withdrawalId,
          withdrawal_status: withdrawal.status,
          status: 409,
        },
        409,
      );
    }
    if (payoutsInFlight.has(withdrawalId)) {
      logger.warn("withdrawal.admin.reconcile_refused_in_flight", {
        correlationId,
        withdrawalId,
        inProcess: true,
      });
      return payoutInFlightResponse(c, withdrawalId, "in_flight_here");
    }

    // Who decides (payout-horizon.ts table). For a Solana payout only chain
    // facts do — the operator's `outcome` must AGREE with them, and a paid
    // payout is recorded under the signature the chain shows landed.
    let paidReference = payoutReference;
    const decidedBy = decidedByOf(withdrawal);
    if (decidedBy === "chain") {
      if (!operatorSolanaTransfer) {
        return payoutInFlightResponse(c, withdrawalId, "chain_unreadable");
      }
      const verdict = await readChainVerdict(moteDb.db, withdrawalId, operatorSolanaTransfer);
      // #990 — a refund needs a FINALIZED kill or failure; `paid` needs a
      // finalized payout, or the operator's attestation of a payout this
      // withdrawal recorded while nothing the chain shows contradicts it.
      const recordedPayout =
        payoutReference !== null &&
        getPayoutAttempts(moteDb.db, withdrawalId).some(
          (a) => a.kind === "payout" && a.signature === payoutReference,
        );
      const attestedPaid =
        verdict.kind === "undecided" &&
        outcome === "paid" &&
        recordedPayout &&
        verdict.unfinalized.length === 0;
      let attestedNotPaid = false;
      if (verdict.kind === "undecided" && !attestedPaid) {
        let kill: KillRequest | null = null;
        if (outcome === "not_paid" && verdict.killable) {
          // The operator asks for a refund: make the payout provably
          // unlandable. The refund follows the kill's FINALIZED status —
          // the resolution loop settles it, or a later reconcile does.
          kill = await requestKill(moteDb.db, withdrawalId, operatorSolanaTransfer);
        }
        // #990 round 7: the payout's nonce already moved, by no finalized
        // transaction this relay recorded — it can never land, but the relay
        // cannot tell "landed, status unreadable" from "consumed by an
        // unrecorded transaction". Only the operator's explicit, attested
        // override refunds it (logged loudly as an attested decision).
        attestedNotPaid =
          kill?.status === "consumed" &&
          verdict.unfinalized.length === 0 &&
          body.override === "nonce_consumed_unrecorded";
        if (attestedNotPaid) {
          logger.error("withdrawal.admin.reconcile_attested_override", {
            correlationId,
            withdrawalId,
            override: "nonce_consumed_unrecorded",
            signature: verdict.signature,
            attestation,
            note: "refunded on the operator's attestation: the payout's durable nonce was consumed by a transaction this relay did not record, so the payout can never land; whether it landed first is the operator's attested decision, not proven by the chain",
          });
        } else {
          logger.warn("withdrawal.admin.reconcile_refused_chain", {
            correlationId,
            withdrawalId,
            outcome,
            reason: verdict.reason,
            signature: verdict.signature,
            unfinalized: verdict.unfinalized,
            kill: kill?.status ?? null,
            detail: verdict.detail ?? null,
          });
          const reason: Exclude<ReconcileState, "open"> =
            verdict.unfinalized.length > 0
              ? "chain_pending"
              : kill?.status === "sent"
                ? "kill_pending"
                : kill?.status === "consumed"
                  ? "nonce_consumed_unrecorded"
                  : kill?.status === "not_sent"
                    ? "kill_not_sent"
                    : kill?.status === "lane_unavailable"
                      ? "chain_unreadable"
                      : !verdict.killable
                        ? "chain_no_positive_evidence"
                        : verdict.reason === "rpc_error"
                          ? "chain_unreadable"
                          : "chain_pending";
          return payoutInFlightResponse(c, withdrawalId, reason, null, {
            signature: verdict.signature,
            unfinalized: verdict.unfinalized,
            ...(kill !== null ? { kill: kill.status } : {}),
          });
        }
      }
      if (verdict.kind === "paid" && verdict.landed.length > 1) {
        // Two of one payout's transactions landed: the treasury paid twice.
        // Never silent; the withdrawal records the first.
        logger.error("withdrawal.payout_landed_twice", {
          correlationId,
          withdrawalId,
          landed: verdict.landed,
        });
      }
      if (attestedPaid) {
        logger.warn("withdrawal.admin.reconcile_paid_attested", {
          correlationId,
          withdrawalId,
          payoutReference,
          chain: verdict,
          note: "no finalized status for this payout is readable (absent or unreadable — never evidence); recorded paid on the operator's attestation of a transaction this payout signed",
        });
      }
      const chainSays = verdict.kind === "paid" ? "paid" : "not_paid";
      if (
        !attestedPaid &&
        (outcome !== chainSays ||
          (verdict.kind === "paid" &&
            payoutReference !== null &&
            payoutReference !== verdict.signature))
      ) {
        logger.warn("withdrawal.admin.reconcile_contradicts_chain", {
          correlationId,
          withdrawalId,
          outcome,
          payoutReference,
          chain: verdict,
        });
        return c.json(
          {
            error: "WITHDRAWAL_RECONCILE_CONTRADICTS_CHAIN",
            message:
              verdict.kind === "paid"
                ? `the chain shows this payout finalized (${verdict.signature}); reconcile it as paid with that payout_reference`
                : `the chain proves this payout can never land (${verdict.kind === "not_paid" ? verdict.by : "undecided"}: finalized); reconcile it as not_paid`,
            withdrawal_id: withdrawalId,
            chain_outcome: chainSays,
            ...(verdict.kind === "paid" ? { payout_reference: verdict.signature } : {}),
            status: 409,
          },
          409,
        );
      }
      if (verdict.kind === "paid") paidReference = verdict.signature;
    } else if (decidedBy === "operator_attested") {
      // A legacy claim recorded no signature, so the relay can never hold
      // positive evidence that its payout did not land (#949 round 5): a
      // refund is refused whatever the chain's height or history shows; the
      // operator's `paid` is accepted.
      if (outcome === "not_paid") {
        logger.warn("withdrawal.admin.reconcile_refused_chain", {
          correlationId,
          withdrawalId,
          outcome,
          reason: "chain_no_positive_evidence",
          legacy: true,
        });
        return payoutInFlightResponse(c, withdrawalId, "chain_no_positive_evidence");
      }
    } else {
      const opensAt = reconcileOpensAt(withdrawal);
      if (opensAt === null) {
        logger.warn("withdrawal.admin.reconcile_refused_undetermined", {
          correlationId,
          withdrawalId,
          claimedAt: withdrawal.claimed_at ?? null,
        });
        return payoutInFlightResponse(c, withdrawalId, "undetermined");
      }
      if (Date.now() < opensAt) {
        logger.warn("withdrawal.admin.reconcile_refused_in_flight", {
          correlationId,
          withdrawalId,
          inProcess: false,
          claimedAt: withdrawal.claimed_at ?? null,
          payoutValidUntil: withdrawal.payout_valid_until ?? null,
          opensAt,
        });
        return payoutInFlightResponse(c, withdrawalId, "horizon", opensAt);
      }
    }
    const now = Date.now();

    if (outcome === "paid") {
      const { signature, relayPublicKeyHex } = await signCompletion(
        withdrawalId,
        withdrawal,
        paidReference!,
        now,
      );
      const success = completeWithdrawal(
        moteDb.db,
        withdrawalId,
        paidReference!,
        "processing",
        signature,
        relayPublicKeyHex,
        now,
      );
      if (!success) {
        const current = getWithdrawalById(moteDb.db, withdrawalId);
        logger.error("withdrawal.admin.reconcile_lost", {
          correlationId,
          withdrawalId,
          outcome,
          status: current?.status ?? null,
        });
        throw new HTTPException(409, {
          message: `withdrawal is no longer processing (${current?.status ?? "missing"})`,
        });
      }
      await attachOperatorProof(withdrawalId, paidReference!, now, railName, network);
      logger.info("withdrawal.admin.reconciled", {
        correlationId,
        withdrawalId,
        outcome,
        payoutReference: paidReference,
        attestation,
      });
      return c.json({
        withdrawal_id: withdrawalId,
        status: "completed",
        relay_signature: signature,
        relay_public_key: relayPublicKeyHex,
      });
    }

    const refunded = failWithdrawal(
      moteDb.db,
      withdrawalId,
      `reconciled not paid (operator attestation): ${attestation}`,
      "processing",
    );
    if (!refunded) {
      const current = getWithdrawalById(moteDb.db, withdrawalId);
      logger.error("withdrawal.admin.reconcile_lost", {
        correlationId,
        withdrawalId,
        outcome,
        status: current?.status ?? null,
      });
      throw new HTTPException(409, {
        message: `withdrawal is no longer processing (${current?.status ?? "missing"})`,
      });
    }
    logger.info("withdrawal.admin.reconciled", {
      correlationId,
      withdrawalId,
      outcome,
      attestation,
    });
    return c.json({ withdrawal_id: withdrawalId, status: "failed", refunded: true });
  });

  // --- Admin: reconciliation ---
  /** @internal */
  app.get("/api/v1/admin/reconciliation", (c) => {
    const correlationId = c.get("correlationId" as never) as string;
    const result = reconcileLedger(moteDb.db);
    logger.info("admin.reconciliation", {
      correlationId,
      consistent: result.consistent,
      errorCount: result.errors.length,
    });
    return c.json(result);
  });

  // --- Admin: emergency freeze ---
  /** @internal */
  app.get("/api/v1/admin/freeze-status", (c) => {
    return c.json({ frozen: freezeState.frozen, reason: freezeState.reason });
  });

  /** @internal */
  app.post("/api/v1/admin/freeze", async (c) => {
    const body = await c.req.json<{ reason?: string }>().catch((): { reason?: string } => ({}));
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    if (!reason) throw new HTTPException(400, { message: "reason is required" });

    persistFreeze(moteDb.db, freezeState, true, reason);

    const authHeader = c.req.header("authorization") ?? "";
    const tokenHash = (await sha256Hash(new TextEncoder().encode(authHeader))).slice(0, 12);
    logger.warn("admin.emergency_freeze.activated", {
      correlationId: c.get("correlationId" as never) as string,
      reason,
      actor: tokenHash,
    });
    return c.json({ status: "frozen", message: "All write operations suspended", reason });
  });

  /** @internal */
  app.post("/api/v1/admin/unfreeze", async (c) => {
    const previousReason = freezeState.reason;
    persistFreeze(moteDb.db, freezeState, false, null);

    const authHeader = c.req.header("authorization") ?? "";
    const tokenHash = (await sha256Hash(new TextEncoder().encode(authHeader))).slice(0, 12);
    logger.info("admin.emergency_freeze.deactivated", {
      correlationId: c.get("correlationId" as never) as string,
      previousReason,
      actor: tokenHash,
    });
    return c.json({ status: "active", message: "Write operations resumed" });
  });

  // --- Stripe checkout ---
  /** @internal */
  app.post("/api/v1/agents/:motebitId/checkout", async (c) => {
    if (!stripeRail && (!stripeClient || !stripeConfig))
      throw new HTTPException(501, { message: "Stripe is not configured on this relay" });

    const motebitId = c.req.param("motebitId");
    requireFirstPerson(c, motebitId, "checkout");
    const correlationId = c.get("correlationId" as never) as string;
    const body = await c.req.json<{ amount: number; return_url?: string }>();
    if (typeof body.amount !== "number" || body.amount <= 0)
      throw new HTTPException(400, { message: "amount must be a positive number (in dollars)" });
    if (body.amount < 0.5)
      throw new HTTPException(400, { message: "Minimum deposit amount is $0.50" });

    // Validate optional return_url (http/https only) — otherwise ignore.
    let returnUrl: string | undefined;
    if (typeof body.return_url === "string" && body.return_url.length > 0) {
      try {
        const parsed = new URL(body.return_url);
        if (parsed.protocol === "http:" || parsed.protocol === "https:") {
          returnUrl = body.return_url;
        }
      } catch {
        // Invalid URL — fall through to default.
      }
    }

    // Default landing page when the caller doesn't specify return_url.
    // Never send users to the relay's JSON balance endpoint.
    const defaultReturnUrl = "https://motebit.com";

    // Use StripeSettlementRail when available. Wrap in try/catch so
    // Stripe errors (account-state, rate limits, network) become a
    // structured 502 with the Stripe error code in the body — instead
    // of an opaque "Internal server error" 500 from Hono's default
    // handler. The CLI surfaces this body verbatim, so users see the
    // actual problem ("Your account cannot currently make live
    // charges", "Your card was declined", etc.) rather than a dead
    // end. Per `services/relay/CLAUDE.md` rule 14 (external medium
    // plumbing speaks motebit vocabulary): provider-shaped errors map
    // into a closed motebit-shaped result before the consumer sees them.
    if (stripeRail) {
      try {
        const result = await stripeRail.deposit(
          motebitId,
          body.amount,
          stripeConfig?.currency ?? "usd",
          `checkout:${motebitId}:${Date.now()}`,
          returnUrl ?? defaultReturnUrl,
        );

        if ("redirectUrl" in result) {
          logger.info("stripe.checkout.created", {
            correlationId,
            motebitId,
            amount: body.amount,
            via: "settlement-rail",
          });
          return c.json({ checkout_url: result.redirectUrl, session_id: null });
        }

        // Direct deposit result (not expected for Stripe, but handle for completeness)
        return c.json({ deposit: result });
      } catch (err) {
        return mapStripeError(c, correlationId, motebitId, body.amount, err, "settlement-rail");
      }
    }

    // Fallback: direct Stripe SDK (backward compatibility during migration)
    const landingUrl = returnUrl ?? defaultReturnUrl;
    try {
      const session = await stripeClient!.checkout.sessions.create({
        mode: "payment",
        payment_method_types: ["card"],
        line_items: [
          {
            price_data: {
              currency: stripeConfig!.currency ?? "usd",
              product_data: { name: `Motebit Agent Deposit (${motebitId.slice(0, 8)}...)` },
              unit_amount: toCents(body.amount),
            },
            quantity: 1,
          },
        ],
        metadata: { motebit_id: motebitId, amount: String(body.amount) },
        success_url: landingUrl,
        cancel_url: landingUrl,
      });

      logger.info("stripe.checkout.created", {
        correlationId,
        motebitId,
        sessionId: session.id,
        amount: body.amount,
      });
      return c.json({ checkout_url: session.url, session_id: session.id });
    } catch (err) {
      return mapStripeError(c, correlationId, motebitId, body.amount, err, "direct-sdk");
    }
  });

  // --- Stripe webhook ---
  /** @internal */
  app.post("/api/v1/stripe/webhook", async (c) => {
    if (!stripeRail && (!stripeClient || !stripeConfig))
      throw new HTTPException(501, { message: "Stripe is not configured on this relay" });

    const sig = c.req.header("stripe-signature");
    if (!sig) throw new HTTPException(400, { message: "Missing stripe-signature header" });

    const rawBody = await c.req.text();
    let event: Stripe.Event;
    try {
      // Use rail's webhook verification when available, fall back to direct SDK
      if (stripeRail) {
        event = stripeRail.constructWebhookEvent(rawBody, sig);
      } else {
        event = stripeClient!.webhooks.constructEvent(rawBody, sig, stripeConfig!.webhookSecret);
      }
    } catch (err) {
      logger.info("stripe.webhook.signature_failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      throw new HTTPException(400, { message: "Invalid webhook signature" });
    }

    logger.info("stripe.webhook.received", { type: event.type, id: event.id });

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const motebitId = session.metadata?.motebit_id;
      const amount = session.metadata?.amount ? parseFloat(session.metadata.amount) : 0;
      if (!motebitId || !amount || amount <= 0) {
        logger.info("stripe.webhook.invalid_metadata", {
          eventId: event.id,
          metadata: session.metadata,
        });
        return c.json({ received: true });
      }

      const paymentIntent =
        typeof session.payment_intent === "string"
          ? session.payment_intent
          : session.payment_intent?.id;
      const applied = processStripeCheckout(
        moteDb.db,
        session.id,
        motebitId,
        amount,
        paymentIntent ?? undefined,
      );

      // Attach proof via the rail for audit trail
      if (applied && stripeRail) {
        await stripeRail.attachProof(session.id, {
          reference: paymentIntent ?? session.id,
          railType: "fiat",
          network: "stripe",
          confirmedAt: Date.now(),
        });
      }

      logger.info("stripe.webhook.processed", {
        eventId: event.id,
        sessionId: session.id,
        motebitId,
        amount,
        applied,
      });
    }

    return c.json({ received: true });
  });

  // Bridge webhook deleted in Arc 1 Commit 2 of the off-ramp arc.
  //
  // The webhook existed to complete async user-facing Bridge withdrawals
  // (state: payment_processed → mark relay_withdrawals row completed +
  // sign receipt + attach proof). With Path 2 deletion and
  // BridgeSettlementRail.withdraw() removed at the package level, no
  // user-facing Bridge transfer can be initiated, so no Bridge webhook
  // can carry a user-withdrawal completion. The handler is gone.
  //
  // Pre-deletion verification: BRIDGE_CUSTOMER_ID has never been set in
  // production Fly secrets (verified 2026-05-17). Without both
  // BRIDGE_API_KEY and BRIDGE_CUSTOMER_ID, the rail never registered —
  // and without the rail, no withdraw() was ever called from the deleted
  // Path 2. Therefore zero in-flight user-facing Bridge withdrawals
  // existed at the moment of deletion; no orphaned `bridge:*`-referenced
  // rows in relay_withdrawals require migration.
  //
  // The future treasury arc may add a separate webhook for treasury-
  // conversion completions (different shape, different handler, distinct
  // from the deleted user-facing path). Today's deletion is total.

  return { resolvePayoutsOnce };
}
