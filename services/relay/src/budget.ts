/**
 * Budget, Virtual Accounts, Withdrawals, Admin & Stripe routes.
 */

import type { Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { MotebitDatabase } from "@motebit/persistence";
import { toCents, isWithdrawableRail, parsePositiveMicro } from "@motebit/protocol";
import type {
  AccountBalanceResult,
  AccountWithdrawResult,
  AccountWithdrawalRecord,
} from "@motebit/protocol";
import { bytesToHex, hash as sha256Hash } from "@motebit/encryption";
import type { RelayIdentity } from "./federation.js";
import { createLogger } from "./logger.js";
import { isEmergencyFrozenAbort, persistFreeze } from "./freeze.js";
import { EmergencyFrozenError } from "./errors.js";
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
  fromMicro,
} from "./accounts.js";
import { checkIdempotency, completeIdempotency } from "./idempotency.js";
import Stripe from "stripe";
import {
  payoutValidityMsOf,
  type SettlementRailRegistry,
  type StripeSettlementRail,
} from "@motebit/settlement-rails";
import type { WithdrawalRequest } from "@motebit/virtual-accounts";

const logger = createLogger({ service: "budget" });

/** 400 message for a client dollar amount that converts to less than 1 micro-unit. */
const AMOUNT_BELOW_MINIMUM =
  "amount must be a finite number of at least 0.000001 USD (1 micro-unit)";

export {
  RECONCILE_MIN_AGE_MS,
  SOLANA_BLOCKHASH_VALIDITY_MS,
  PAYOUT_HORIZON_MARGIN_MS,
  UNDECLARED_PAYOUT_HORIZON_MS,
  reconcileOpensAt,
} from "./payout-horizon.js";
import {
  RECONCILE_MIN_AGE_MS,
  UNDECLARED_PAYOUT_HORIZON_MS,
  reconcileOpensAt,
} from "./payout-horizon.js";

/** Destination shapes an automated payout path serves: Path 0 (Solana base58), Path 1 (EVM 0x). */
const SOLANA_DEST_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const EVM_DEST_RE = /^0x[0-9a-fA-F]{40}$/;

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
   * Absent when SOLANA_RPC_URL is unset — Path 0 dispatch falls through
   * to Path 1 (x402 EVM) or Path 2 (Bridge) in that case.
   */
  operatorSolanaTransfer?: import("@motebit/wallet-solana").OperatorSolanaTransfer;
}

export function registerBudgetRoutes(deps: BudgetDeps): void {
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

  /**
   * When this process's send call for a still-`processing` withdrawal
   * returned or threw — the last moment the relay could have broadcast it
   * (`reconcileOpensAt`). In-memory: a claim from an earlier process life is
   * bounded by the process start instead.
   */
  const payoutSendEndedAt = new Map<string, number>();

  /** Release a payout from this process: its outcome is written (or could not be). */
  const releasePayout = (withdrawalId: string): void => {
    payoutsInFlight.delete(withdrawalId);
    if (getWithdrawalById(moteDb.db, withdrawalId)?.status === "processing") {
      payoutSendEndedAt.set(withdrawalId, Date.now());
    } else {
      payoutSendEndedAt.delete(withdrawalId);
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

    // This request claimed the key. If the emergency freeze refuses its money
    // write, the error boundary reopens the key so the same-key retry after
    // unfreeze withdraws once (every other failure keeps today's behavior).
    c.set("idempotencyClaimOnFreeze" as never, { key: idempotencyKeyHeader, motebitId } as never);

    const body = await c.req.json<{
      amount: number;
      destination?: string;
      idempotency_key?: string;
    }>();
    // Validate the CONVERTED value: a positive dollar amount below one micro
    // (1e-7 USD) rounds to 0 and once recorded $0 withdrawals.
    const amountMicro = parsePositiveMicro(body.amount);
    if (amountMicro === null) {
      const errBody = JSON.stringify({ error: AMOUNT_BELOW_MINIMUM, status: 400 });
      completeIdempotency(moteDb.db, idempotencyKeyHeader, motebitId, 400, errBody);
      throw new HTTPException(400, { message: AMOUNT_BELOW_MINIMUM });
    }
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

    // Automated settlement: try Solana sovereign return (Path 0), x402 EVM
    // (Path 1), or Bridge (Path 2). Each path is gated by the destination
    // address shape — Solana base58, EVM 0x-hex, or other. Paths are
    // mutually exclusive on address shape, so ordering doesn't affect
    // correctness; Path 0 is listed first as the doctrinal-default
    // sovereign-rail return-of-custody path (relay treasury → user wallet,
    // no third-party orchestrator, no transmission category).
    //
    // Claim before send (issue #921; spec/market-v1.md §10.3). No path sends
    // a payout until it has CLAIMED the withdrawal — the compare-and-set
    // `pending → processing` (`claimPayout`). A lost claim means someone
    // else (the operator's manual complete/fail during this handler's
    // pre-send awaits) already owns the outcome: nothing is sent and the
    // current record is returned as it stands. After the claim, the send's
    // outcome settles the withdrawal FROM `processing` only, and the
    // operator's manual complete/fail refuse a `processing` withdrawal
    // (409) — before #921 an admin /fail during the in-flight send refunded,
    // the send then confirmed, and the user was paid AND refunded while the
    // row read `failed`. A `processing` withdrawal whose payout outcome is
    // unknown (the send threw, the process died mid-send) is settled only
    // through `/admin/withdrawals/:id/reconcile`, after the payout can no
    // longer be in flight and on an explicit operator attestation.
    //
    // Fail-safe: if settlement's outcome is unknown (the send threw), the
    // withdrawal stays `processing` for the operator's reconcile. Funds are
    // already held by requestWithdrawal — no double-spend risk. Only a
    // PROVEN failure (Path 0: the tx landed and failed on-chain AND no
    // earlier broadcast can land) fails the withdrawal and refunds,
    // atomically — see the outcome rule below.
    let autoSettled = false;
    // The payout claim is a guarded write: a freeze that landed after the
    // debit (during a path's pre-claim await) refuses it, so nothing is sent
    // and the withdrawal stands `pending` with its amount held. That is a
    // refusal, answered 503 — never a 200 that reads as a payout in progress.
    let frozenAtClaim = false;
    // A payout that provably moved nothing (Path 0 outcome 2) whose refund a
    // freeze landing during the send refused: the withdrawal stays
    // `processing` with the proven outcome recorded, the amount held, and the
    // request is answered 503 — the refund is the operator's reconcile
    // (`not_paid`) after unfreeze, never a 200 that reads as settled.
    let frozenAtRefund = false;
    const isSolanaDest =
      result.destination !== "pending" && SOLANA_DEST_RE.test(result.destination);
    const isWalletDest = result.destination !== "pending" && EVM_DEST_RE.test(result.destination);

    // The claim (#921). Returns true only when THIS request moved the row
    // `pending → processing`; the caller sends nothing on false.
    //
    // `payoutValidUntil` is the payout's own horizon: the latest moment what
    // the rail is handed can still land (x402: the authorization's
    // `validBefore`); null for a payout the relay broadcasts itself (Solana),
    // whose horizon is bound to this process (`reconcileOpensAt`). On a won
    // claim the payout is in flight here until `releasePayout`.
    const claimPayout = (path: "solana" | "x402", payoutValidUntil: number | null): boolean => {
      const claimedAt = Date.now();
      const claimed = claimWithdrawalForPayout(
        moteDb.db,
        result.withdrawal_id,
        claimedAt,
        payoutValidUntil,
      );
      if (claimed) {
        payoutsInFlight.add(result.withdrawal_id);
      } else {
        const current = getWithdrawalById(moteDb.db, result.withdrawal_id);
        logger.error("withdrawal.payout_claim_lost", {
          correlationId,
          motebitId,
          withdrawalId: result.withdrawal_id,
          path,
          status: current?.status ?? null,
          destination: result.destination,
          note: "no payout sent: the withdrawal left `pending` before this request claimed it",
        });
      }
      return claimed;
    };

    // A settling write that lost to another actor after the payout was sent.
    // Never silent (#921): the payout's real outcome and the row disagree,
    // and only an operator can reconcile them.
    const settleLost = (
      path: "solana" | "x402",
      outcome: string,
      data: Record<string, unknown>,
    ) => {
      const current = getWithdrawalById(moteDb.db, result.withdrawal_id);
      logger.error("withdrawal.payout_settle_lost", {
        correlationId,
        motebitId,
        withdrawalId: result.withdrawal_id,
        path,
        outcome,
        status: current?.status ?? null,
        destination: result.destination,
        ...data,
        note: "the payout's outcome could not be recorded: the withdrawal is no longer `processing`; reconcile the ledger against the chain",
      });
    };

    // Path 0: native Solana sovereign return of custody.
    //
    // The user's withdrawal destination is their own sovereign Solana
    // wallet (typically the identity-key-derived address — same Ed25519,
    // by curve coincidence). The relay signs from its own treasury wallet
    // (also identity-key-derived for the relay) and sends USDC directly
    // via the operator-side Solana adapter. No Bridge, no third-party
    // orchestrator, no `on_behalf_of` header — the relay is the native
    // principal of its own onchain transfer; the destination is the
    // user's own wallet; the round-trip is structurally same-party return
    // of custody from a self-deposit cache (user→Motebit→same-user).
    //
    // Doctrine: docs/doctrine/off-ramp-as-user-action.md (landing this arc).
    // Operator primitive: packages/wallet-solana/src/operator-transfer.ts.
    //
    // Settlement-outcome rule (issue #920; spec/market-v1.md §10.4). Each
    // send outcome maps to exactly one ledger action, each FROM `processing`
    // (the claim, #921):
    //
    //   1. confirmed:true — the reported signature landed without error:
    //      USDC moved. Complete with that signature as payout_reference and a
    //      signed receipt.
    //   2. confirmed:false AND earlierBroadcastsDead === true — the reported
    //      signature landed and FAILED on chain (Solana txs are atomic: only
    //      the fee was charged) AND the adapter proved no earlier broadcast of
    //      this payout can land. Nothing was paid, so fail the withdrawal and
    //      refund in ONE transaction (`failWithdrawal` →
    //      `AccountStore.failWithdrawalAndRefund`, at most once).
    //   3. everything else — UNKNOWN; the withdrawal stays `processing`, the
    //      balance stays debited, never refunded:
    //        - the send threw (timeout, expiry on the last attempt, network);
    //        - confirmed:false with earlierBroadcastsDead false/absent. The
    //          adapter re-signs after a blockhash expiry, and expiry can win
    //          the race against a first broadcast that in fact LANDED and
    //          paid; the re-broadcast then lands-and-fails (its create-ATA
    //          instruction is not idempotent). `confirmed:false` describes the
    //          LAST signature only, so refunding here would pay twice. The
    //          reason is recorded on the row for the operator's reconcile.
    //
    // Before #920 outcome 2 was recorded as outcome 1: a completed, signed
    // withdrawal whose funds never moved, with the balance still debited.
    if (!autoSettled && isSolanaDest && operatorSolanaTransfer) {
      let claimed = false;
      try {
        const available = await operatorSolanaTransfer.isAvailable();
        if (available && claimPayout("solana", null)) {
          claimed = true;
          const sendResult = await operatorSolanaTransfer.sendUsdc(
            result.destination,
            // result.amount is stored in micro-units; the operator-side
            // adapter takes micro-units as bigint (same unit convention
            // as everywhere in the ledger).
            BigInt(result.amount),
          );

          if (sendResult.confirmed === true) {
            // Outcome 1 — funds moved.
            const completedAt = Date.now();
            const relayPublicKeyHex = bytesToHex(relayIdentity.publicKey);
            const signature = await signWithdrawalReceipt(
              {
                withdrawal_id: result.withdrawal_id,
                motebit_id: motebitId,
                amount: body.amount,
                currency: result.currency,
                destination: result.destination,
                payout_reference: sendResult.signature,
                completed_at: completedAt,
                relay_id: relayIdentity.relayMotebitId,
              },
              relayIdentity.privateKey,
            );
            const completed = completeWithdrawal(
              moteDb.db,
              result.withdrawal_id,
              sendResult.signature,
              "processing",
              signature,
              relayPublicKeyHex,
              completedAt,
            );
            if (completed) {
              autoSettled = true;
              logger.info("withdrawal.solana.auto_settled", {
                correlationId,
                motebitId,
                withdrawalId: result.withdrawal_id,
                txSignature: sendResult.signature,
                slot: sendResult.slot,
                confirmed: sendResult.confirmed,
                // A confirmed signature paid. If earlier broadcasts are not
                // proven dead, one of them may ALSO have paid — the log keeps
                // that visible for reconciliation.
                earlierBroadcastsDead: sendResult.earlierBroadcastsDead ?? null,
                destination: result.destination,
              });
            } else {
              settleLost("solana", "confirmed", {
                txSignature: sendResult.signature,
                slot: sendResult.slot,
              });
            }
          } else if (sendResult.confirmed === false && sendResult.earlierBroadcastsDead === true) {
            // Outcome 2 — landed and failed, and no earlier broadcast can
            // land: provably nothing moved.
            let refunded: boolean;
            try {
              refunded = failWithdrawal(
                moteDb.db,
                result.withdrawal_id,
                `solana transfer ${sendResult.signature} landed at slot ${sendResult.slot} but failed on-chain (confirmed:false), and no earlier broadcast of this payout can land; no USDC moved, amount returned to balance`,
                "processing",
              );
            } catch (refundErr) {
              if (!isEmergencyFrozenAbort(refundErr)) throw refundErr;
              // The freeze (landed during the send) refused the refund: the
              // fail + refund rolled back together. Record the PROVEN outcome
              // (never "may have landed") and answer 503, never 200.
              frozenAtRefund = true;
              const noted = noteWithdrawalPayoutUnresolved(
                moteDb.db,
                result.withdrawal_id,
                `refund refused by emergency freeze: solana transfer ${sendResult.signature} landed at slot ${sendResult.slot} and failed on-chain (confirmed:false), and no earlier broadcast of this payout can land — no USDC moved; after the freeze lifts, reconcile as not_paid to refund`,
              );
              if (!noted) {
                settleLost("solana", "landed_failed_frozen", {
                  txSignature: sendResult.signature,
                  slot: sendResult.slot,
                });
              }
              refunded = false;
            }
            if (frozenAtRefund) {
              logger.warn("withdrawal.solana.landed_failed_refund_frozen", {
                correlationId,
                motebitId,
                withdrawalId: result.withdrawal_id,
                txSignature: sendResult.signature,
                slot: sendResult.slot,
              });
            } else if (refunded) {
              logger.warn("withdrawal.solana.landed_failed", {
                correlationId,
                motebitId,
                withdrawalId: result.withdrawal_id,
                txSignature: sendResult.signature,
                slot: sendResult.slot,
                destination: result.destination,
                refunded,
              });
            } else {
              settleLost("solana", "landed_failed", {
                txSignature: sendResult.signature,
                slot: sendResult.slot,
              });
            }
          } else {
            // Outcome 3 (reported) — the last broadcast failed, but an earlier
            // broadcast of this payout is not proven dead and may have paid.
            // Stay `processing`, no refund; record why for the operator.
            const noted = noteWithdrawalPayoutUnresolved(
              moteDb.db,
              result.withdrawal_id,
              `unresolved payout: solana transfer ${sendResult.signature} landed at slot ${sendResult.slot} and failed on-chain (confirmed:false), but earlier broadcasts of this payout are not proven dead (earlierBroadcastsDead=${String(sendResult.earlierBroadcastsDead)}) and may have paid; reconcile on chain before completing or failing`,
            );
            if (noted) {
              logger.warn("withdrawal.solana.outcome_unresolved", {
                correlationId,
                motebitId,
                withdrawalId: result.withdrawal_id,
                txSignature: sendResult.signature,
                slot: sendResult.slot,
                earlierBroadcastsDead: sendResult.earlierBroadcastsDead ?? null,
                destination: result.destination,
                noted,
              });
            } else {
              settleLost("solana", "unresolved", {
                txSignature: sendResult.signature,
                slot: sendResult.slot,
              });
            }
          }
        }
      } catch (err) {
        // Outcome 3 (thrown) — unknown. A claimed withdrawal stays
        // `processing`; never refund here. An unclaimed one (isAvailable
        // threw) was never sent and stays `pending`.
        const error = err instanceof Error ? err.message : String(err);
        if (!claimed && isEmergencyFrozenAbort(err)) frozenAtClaim = true;
        if (claimed) {
          const noted = noteWithdrawalPayoutUnresolved(
            moteDb.db,
            result.withdrawal_id,
            `unresolved payout: solana send threw (${error}); the transfer may have landed — reconcile on chain before completing or failing`,
          );
          if (!noted) settleLost("solana", "threw", { error });
        }
        logger.warn("withdrawal.solana.auto_settle_failed", {
          correlationId,
          motebitId,
          withdrawalId: result.withdrawal_id,
          destination: result.destination,
          claimed,
          error,
        });
      } finally {
        // Only now — after the outcome's write (or the note) — may the
        // reconcile door see this payout as no longer in flight (#921).
        if (claimed) releasePayout(result.withdrawal_id);
      }
    }

    // Path 1: x402 instant settlement for EVM-shaped wallet destinations.
    //
    // The rail must be narrowed through `isWithdrawableRail()` before
    // calling `.withdraw(...)` — `withdraw` does not exist on the base
    // `GuestRail` type (it lives on `WithdrawableGuestRail`). This is
    // the structural fence the off-ramp arc landed: the only rails
    // that can drive user-facing transmission are those that opt-in
    // via the `WithdrawableGuestRail` marker. `BridgeSettlementRail`
    // does NOT opt-in — Bridge is treasury-only.
    //
    // Same claim-before-send as Path 0 (#921): the rail is called only after
    // `claimPayout`, the completion is FROM `processing`, and a thrown
    // withdraw leaves the withdrawal `processing` for the operator's
    // reconcile (the transfer may have been submitted).
    if (!autoSettled && railRegistry && isWalletDest) {
      const x402Rail = railRegistry.get("x402");
      if (x402Rail && isWithdrawableRail(x402Rail)) {
        let claimed = false;
        try {
          const available = await x402Rail.isAvailable();
          // The authorization the rail signs stays submittable until its
          // declared validity; a rail declaring none gets the conservative
          // floor — never a shorter horizon.
          const validityMs = payoutValidityMsOf(x402Rail) ?? UNDECLARED_PAYOUT_HORIZON_MS;
          if (available && claimPayout("x402", Date.now() + validityMs)) {
            claimed = true;
            const withdrawResult = await x402Rail.withdraw(
              motebitId,
              body.amount,
              "USDC",
              result.destination,
              result.withdrawal_id,
            );

            const completedAt = Date.now();
            const relayPublicKeyHex = bytesToHex(relayIdentity.publicKey);
            const signature = await signWithdrawalReceipt(
              {
                withdrawal_id: result.withdrawal_id,
                motebit_id: motebitId,
                amount: body.amount,
                currency: result.currency,
                destination: result.destination,
                payout_reference: withdrawResult.proof.reference,
                completed_at: completedAt,
                relay_id: relayIdentity.relayMotebitId,
              },
              relayIdentity.privateKey,
            );
            const completed = completeWithdrawal(
              moteDb.db,
              result.withdrawal_id,
              withdrawResult.proof.reference,
              "processing",
              signature,
              relayPublicKeyHex,
              completedAt,
            );
            if (completed) {
              autoSettled = true;
              // The payout is recorded; a proof-attach failure must not be
              // read as an unknown payout outcome.
              try {
                await x402Rail.attachProof(result.withdrawal_id, withdrawResult.proof);
              } catch (proofErr) {
                logger.error("withdrawal.x402.proof_attach_failed", {
                  correlationId,
                  withdrawalId: result.withdrawal_id,
                  txHash: withdrawResult.proof.reference,
                  error: proofErr instanceof Error ? proofErr.message : String(proofErr),
                });
              }
              logger.info("withdrawal.x402.auto_settled", {
                correlationId,
                motebitId,
                withdrawalId: result.withdrawal_id,
                txHash: withdrawResult.proof.reference,
                network: withdrawResult.proof.network,
              });
            } else {
              settleLost("x402", "confirmed", {
                txHash: withdrawResult.proof.reference,
                network: withdrawResult.proof.network,
              });
            }
          }
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          if (!claimed && isEmergencyFrozenAbort(err)) frozenAtClaim = true;
          if (claimed) {
            const noted = noteWithdrawalPayoutUnresolved(
              moteDb.db,
              result.withdrawal_id,
              `unresolved payout: x402 withdraw threw (${error}); the transfer may have been submitted — reconcile on chain before completing or failing`,
            );
            if (!noted) settleLost("x402", "threw", { error });
          }
          logger.warn("withdrawal.x402.auto_settle_failed", {
            correlationId,
            motebitId,
            withdrawalId: result.withdrawal_id,
            claimed,
            error,
          });
        } finally {
          if (claimed) releasePayout(result.withdrawal_id);
        }
      }
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
    // If neither Path 0 (Solana sovereign) nor Path 1 (x402 EVM) matched,
    // the withdrawal stays pending for admin resolution. Funds remain
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
    if (frozenAtClaim && !autoSettled) {
      throw new EmergencyFrozenError(
        `Relay is in emergency freeze mode: withdrawal ${result.withdrawal_id} is recorded and its amount held, but no payout was sent. It stays pending; retry with the same Idempotency-Key after the freeze lifts — never a new key.`,
      );
    }
    if (frozenAtRefund) {
      throw new EmergencyFrozenError(
        `Relay is in emergency freeze mode: withdrawal ${result.withdrawal_id}'s payout landed and failed on-chain (no USDC moved), but its refund was refused by the freeze. It stays processing with that outcome recorded and its amount held; after the freeze lifts the operator's reconcile refunds it.`,
      );
    }
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
  //     payout can no longer land: never while this process is still
  //     handling it (claim → outcome written), never before
  //     `reconcileOpensAt` — the payout's own horizon (x402: the signed
  //     authorization's validity; Solana: the last moment this relay could
  //     have broadcast, plus a blockhash lifetime), floored at
  //     RECONCILE_MIN_AGE_MS after the claim — and only on an explicit
  //     operator attestation of what the chain shows. This is the door for a payout whose outcome is unknown — the
  //     send threw, or the process died mid-send — so a crash never strands
  //     a withdrawal with no way out, and it is never a blind refund.

  /**
   * Why a `processing` withdrawal cannot be reconciled yet (#921):
   *   - `in_flight_here`: this relay is still handling its payout;
   *   - `undetermined`: the relay cannot place the payout's horizon yet
   *     (fail closed; see `reconcileOpensAt`);
   *   - `horizon`: the payout may still land until `reconcile_opens_at`.
   * `open` means the reconcile door is open now.
   */
  type ReconcileState = "in_flight_here" | "undetermined" | "horizon" | "open";

  function reconcileStateOf(w: WithdrawalRequest): {
    reconcile_state: ReconcileState | null;
    reconcile_opens_at: number | null;
  } {
    if (w.status !== "processing") return { reconcile_state: null, reconcile_opens_at: null };
    if (payoutsInFlight.has(w.withdrawal_id)) {
      return { reconcile_state: "in_flight_here", reconcile_opens_at: null };
    }
    const now = Date.now();
    const opensAt = reconcileOpensAt(w, payoutSendEndedAt.get(w.withdrawal_id), { now });
    if (opensAt === null) return { reconcile_state: "undetermined", reconcile_opens_at: null };
    return { reconcile_state: now >= opensAt ? "open" : "horizon", reconcile_opens_at: opensAt };
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
    };

  const payoutInFlightResponse = (
    c: Context,
    withdrawalId: string,
    reason: Exclude<ReconcileState, "open"> | "processing" = "processing",
    opensAt: number | null = null,
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
    const now = Date.now();
    if (payoutsInFlight.has(withdrawalId)) {
      logger.warn("withdrawal.admin.reconcile_refused_in_flight", {
        correlationId,
        withdrawalId,
        inProcess: true,
      });
      return payoutInFlightResponse(c, withdrawalId, "in_flight_here");
    }
    const opensAt = reconcileOpensAt(withdrawal, payoutSendEndedAt.get(withdrawalId), { now });
    if (opensAt === null) {
      logger.warn("withdrawal.admin.reconcile_refused_undetermined", {
        correlationId,
        withdrawalId,
        claimedAt: withdrawal.claimed_at ?? null,
      });
      return payoutInFlightResponse(c, withdrawalId, "undetermined");
    }
    if (now < opensAt) {
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

    if (outcome === "paid") {
      const { signature, relayPublicKeyHex } = await signCompletion(
        withdrawalId,
        withdrawal,
        payoutReference!,
        now,
      );
      const success = completeWithdrawal(
        moteDb.db,
        withdrawalId,
        payoutReference!,
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
      await attachOperatorProof(withdrawalId, payoutReference!, now, railName, network);
      logger.info("withdrawal.admin.reconciled", {
        correlationId,
        withdrawalId,
        outcome,
        payoutReference,
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
    if (parsePositiveMicro(body.amount) === null)
      throw new HTTPException(400, { message: `${AMOUNT_BELOW_MINIMUM} (in dollars)` });
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
}
