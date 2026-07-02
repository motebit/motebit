/**
 * Budget, Virtual Accounts, Withdrawals, Admin & Stripe routes.
 */

import type { Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { MotebitDatabase } from "@motebit/persistence";
import { toCents, isWithdrawableRail } from "@motebit/protocol";
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
  completeWithdrawal,
  signWithdrawalReceipt,
  failWithdrawal,
  getWithdrawals,
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

const logger = createLogger({ service: "budget" });

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

  // NOTE: the self-declared `POST /api/v1/agents/:id/deposit` route was
  // removed (2026-07-01). It credited spendable balance from a client-
  // supplied amount under the account owner's own device token, with no
  // funding-provenance check anywhere in the deposit→withdraw path — a
  // treasury-drain vector (self-declare balance → auto-settled withdrawal).
  // Balance is credited ONLY by verified funding: the onchain deposit-
  // detector and the Stripe webhook, both via `creditAccount` server-side.
  // Tests seed via `seedBalance` (test-helpers), not an HTTP money route.

  // --- Balance ---
  /** @internal */
  app.get("/api/v1/agents/:motebitId/balance", (c) => {
    const motebitId = c.req.param("motebitId");
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

    const toWithdrawalResponse = <T extends { amount: number }>(w: T) => ({
      ...w,
      amount: fromMicro(w.amount),
      // Stamp the relay's own identity so the record is self-verifiable:
      // relay_id is a signed WithdrawalReceiptPayload field, so an auditor
      // reading only this response can reconstruct the canonical bytes.
      relay_id: relayIdentity.relayMotebitId,
    });

    if ("existing" in result) {
      logger.info("withdrawal.endpoint.idempotent", {
        correlationId,
        motebitId,
        withdrawalId: result.existing.withdrawal_id,
        idempotencyKey,
      });
      const responseBody = {
        motebit_id: motebitId,
        withdrawal: toWithdrawalResponse(result.existing),
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
    // Fail-safe: if settlement fails, withdrawal stays pending for admin
    // resolution. Funds are already held by requestWithdrawal — no
    // double-spend risk.
    let autoSettled = false;
    const isSolanaDest =
      result.destination !== "pending" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(result.destination);
    const isWalletDest =
      result.destination !== "pending" && /^0x[0-9a-fA-F]{40}$/.test(result.destination);

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
    if (!autoSettled && isSolanaDest && operatorSolanaTransfer) {
      try {
        const available = await operatorSolanaTransfer.isAvailable();
        if (available) {
          const sendResult = await operatorSolanaTransfer.sendUsdc(
            result.destination,
            // result.amount is stored in micro-units; the operator-side
            // adapter takes micro-units as bigint (same unit convention
            // as everywhere in the ledger).
            BigInt(result.amount),
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
              payout_reference: sendResult.signature,
              completed_at: completedAt,
              relay_id: relayIdentity.relayMotebitId,
            },
            relayIdentity.privateKey,
          );
          completeWithdrawal(
            moteDb.db,
            result.withdrawal_id,
            sendResult.signature,
            signature,
            relayPublicKeyHex,
            completedAt,
          );

          autoSettled = true;
          logger.info("withdrawal.solana.auto_settled", {
            correlationId,
            motebitId,
            withdrawalId: result.withdrawal_id,
            txSignature: sendResult.signature,
            slot: sendResult.slot,
            confirmed: sendResult.confirmed,
            destination: result.destination,
          });
        }
      } catch (err) {
        logger.warn("withdrawal.solana.auto_settle_failed", {
          correlationId,
          motebitId,
          withdrawalId: result.withdrawal_id,
          destination: result.destination,
          error: err instanceof Error ? err.message : String(err),
        });
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
    if (!autoSettled && railRegistry && isWalletDest) {
      const x402Rail = railRegistry.get("x402");
      if (x402Rail && isWithdrawableRail(x402Rail)) {
        try {
          const available = await x402Rail.isAvailable();
          if (available) {
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
            completeWithdrawal(
              moteDb.db,
              result.withdrawal_id,
              withdrawResult.proof.reference,
              signature,
              relayPublicKeyHex,
              completedAt,
            );
            await x402Rail.attachProof(result.withdrawal_id, withdrawResult.proof);

            autoSettled = true;
            logger.info("withdrawal.x402.auto_settled", {
              correlationId,
              motebitId,
              withdrawalId: result.withdrawal_id,
              txHash: withdrawResult.proof.reference,
              network: withdrawResult.proof.network,
            });
          }
        } catch (err) {
          logger.warn("withdrawal.x402.auto_settle_failed", {
            correlationId,
            motebitId,
            withdrawalId: result.withdrawal_id,
            error: err instanceof Error ? err.message : String(err),
          });
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

    const responseBody = {
      motebit_id: motebitId,
      withdrawal: toWithdrawalResponse(
        autoSettled
          ? {
              ...result,
              status: "completed" as const,
            }
          : result,
      ),
      // `satisfies` binds the producer to the market-v1 §2.9 wire law at
      // compile time; runtime behavior unchanged.
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
    const withdrawals = getWithdrawals(moteDb.db, motebitId, 50).map(
      (w) =>
        ({
          ...w,
          amount: fromMicro(w.amount),
          relay_id: relayIdentity.relayMotebitId,
        }) satisfies AccountWithdrawalRecord,
    );
    return c.json({ motebit_id: motebitId, withdrawals });
  });

  // --- Admin: pending withdrawals ---
  /** @internal */
  app.get("/api/v1/admin/withdrawals/pending", (c) => {
    const withdrawals = getPendingWithdrawals(moteDb.db).map((w) => ({
      ...w,
      amount: fromMicro(w.amount),
    }));
    return c.json({ withdrawals, count: withdrawals.length });
  });

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

    const withdrawal = moteDb.db
      .prepare(
        "SELECT * FROM relay_withdrawals WHERE withdrawal_id = ? AND status IN ('pending', 'processing')",
      )
      .get(withdrawalId) as
      | { motebit_id: string; amount: number; currency: string; destination: string }
      | undefined;
    if (!withdrawal)
      throw new HTTPException(404, { message: "Withdrawal not found or already completed/failed" });

    const completedAt = Date.now();
    const relayPublicKeyHex = bytesToHex(relayIdentity.publicKey);
    const signature = await signWithdrawalReceipt(
      {
        withdrawal_id: withdrawalId,
        motebit_id: withdrawal.motebit_id,
        amount: fromMicro(withdrawal.amount),
        currency: withdrawal.currency,
        destination: withdrawal.destination,
        payout_reference: body.payout_reference,
        completed_at: completedAt,
        relay_id: relayIdentity.relayMotebitId,
      },
      relayIdentity.privateKey,
    );

    const success = completeWithdrawal(
      moteDb.db,
      withdrawalId,
      body.payout_reference,
      signature,
      relayPublicKeyHex,
      completedAt,
    );
    if (!success)
      throw new HTTPException(404, { message: "Withdrawal not found or already completed/failed" });

    // Attach proof through the rail boundary — sibling parity with deposit proof flows.
    // Every completed withdrawal must have a proof record for reconciliation check #6.
    if (body.rail && railRegistry) {
      const rail = railRegistry.get(body.rail);
      if (rail) {
        await rail.attachProof(withdrawalId, {
          reference: body.payout_reference,
          railType: rail.railType,
          network: body.network,
          confirmedAt: completedAt,
        });
      } else {
        // Unknown rail name — store manual proof so reconciliation still passes
        storeSettlementProof(
          moteDb.db,
          withdrawalId,
          {
            reference: body.payout_reference,
            railType: "manual",
            network: body.network,
            confirmedAt: completedAt,
          },
          `manual:${body.rail}`,
        );
      }
    } else {
      // No rail specified — manual/off-rail payout. Store a manual proof record so that
      // every completed withdrawal has an entry in relay_settlement_proofs.
      storeSettlementProof(
        moteDb.db,
        withdrawalId,
        {
          reference: body.payout_reference,
          railType: "manual",
          confirmedAt: completedAt,
        },
        "manual",
      );
    }

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

    const success = failWithdrawal(moteDb.db, withdrawalId, body.reason);
    if (!success)
      throw new HTTPException(404, { message: "Withdrawal not found or already completed/failed" });

    logger.info("withdrawal.admin.failed", { correlationId, withdrawalId, reason: body.reason });
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
    const body = await c.req.json<{ reason?: string }>().catch(() => ({}) as { reason?: string });
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
}
