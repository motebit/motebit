/**
 * Budget, Virtual Accounts, Withdrawals, Admin & Stripe routes.
 */

import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { MotebitDatabase } from "@motebit/persistence";
import { bytesToHex, hash as sha256Hash } from "@motebit/crypto";
import type { RelayIdentity } from "./federation.js";
import { createLogger } from "./logger.js";
import { persistFreeze } from "./freeze.js";
import {
  getOrCreateAccount,
  getAccountBalance,
  getAccountBalanceDetailed,
  getTransactions,
  hasTransactionWithReference,
  requestWithdrawal,
  completeWithdrawal,
  signWithdrawalReceipt,
  failWithdrawal,
  getWithdrawals,
  getPendingWithdrawals,
  reconcileLedger,
  processStripeCheckout,
  toMicro,
  fromMicro,
} from "./accounts.js";
import Stripe from "stripe";

const logger = createLogger({ service: "budget" });

export interface BudgetDeps {
  app: Hono;
  moteDb: MotebitDatabase;
  relayIdentity: RelayIdentity;
  /** Mutable freeze state — shared with index.ts middleware. */
  freezeState: { frozen: boolean; reason: string | null };
  stripeClient: Stripe | null;
  stripeConfig: { secretKey: string; webhookSecret: string; currency?: string } | null;
}

export function registerBudgetRoutes(deps: BudgetDeps): void {
  const { app, moteDb, relayIdentity, freezeState, stripeClient, stripeConfig } = deps;

  // --- Deposit ---
  app.post("/api/v1/agents/:motebitId/deposit", async (c) => {
    const motebitId = c.req.param("motebitId");
    const correlationId = c.get("correlationId" as never) as string;
    const body = await c.req.json<{
      amount: number;
      currency?: string;
      reference?: string;
      description?: string;
    }>();

    if (typeof body.amount !== "number" || body.amount <= 0)
      throw new HTTPException(400, { message: "amount must be a positive number" });

    const amountMicro = toMicro(body.amount);

    if (body.reference) {
      if (hasTransactionWithReference(moteDb.db, motebitId, body.reference)) {
        const account = getOrCreateAccount(moteDb.db, motebitId);
        logger.info("account.deposit_idempotent", {
          correlationId,
          motebitId,
          reference: body.reference,
        });
        return c.json({
          motebit_id: motebitId,
          balance: fromMicro(account.balance),
          transaction_id: null,
          idempotent: true,
        });
      }
    }

    let newBalance: number;
    const txnId = crypto.randomUUID();
    moteDb.db.exec("BEGIN");
    try {
      const account = getOrCreateAccount(moteDb.db, motebitId);
      newBalance = account.balance + amountMicro;
      const now = Date.now();
      moteDb.db
        .prepare("UPDATE relay_accounts SET balance = ?, updated_at = ? WHERE motebit_id = ?")
        .run(newBalance, now, motebitId);
      moteDb.db
        .prepare(
          `INSERT INTO relay_transactions (transaction_id, motebit_id, type, amount, balance_after, reference_id, description, created_at) VALUES (?, ?, 'deposit', ?, ?, ?, ?, ?)`,
        )
        .run(
          txnId,
          motebitId,
          amountMicro,
          newBalance,
          body.reference ?? null,
          body.description ?? null,
          now,
        );
      moteDb.db.exec("COMMIT");
    } catch (err) {
      moteDb.db.exec("ROLLBACK");
      throw new Error("Deposit failed", { cause: err });
    }

    logger.info("account.deposit", {
      correlationId,
      motebitId,
      amount: body.amount,
      amountMicro,
      balanceAfter: newBalance,
      reference: body.reference ?? null,
    });
    return c.json({ motebit_id: motebitId, balance: fromMicro(newBalance), transaction_id: txnId });
  });

  // --- Balance ---
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
        transactions: [],
      });
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
      transactions,
    });
  });

  // --- Withdraw ---
  app.post("/api/v1/agents/:motebitId/withdraw", async (c) => {
    const motebitId = c.req.param("motebitId");
    const correlationId = c.get("correlationId" as never) as string;
    const body = await c.req.json<{
      amount: number;
      destination?: string;
      idempotency_key?: string;
    }>();
    if (typeof body.amount !== "number" || body.amount <= 0)
      throw new HTTPException(400, { message: "amount must be a positive number" });

    const amountMicro = toMicro(body.amount);
    const idempotencyKey = body.idempotency_key ?? c.req.header("Idempotency-Key") ?? undefined;
    const result = requestWithdrawal(
      moteDb.db,
      motebitId,
      amountMicro,
      body.destination ?? "pending",
      idempotencyKey,
    );
    if (result === null)
      throw new HTTPException(402, { message: "Insufficient balance for withdrawal" });

    const toWithdrawalResponse = <T extends { amount: number }>(w: T) => ({
      ...w,
      amount: fromMicro(w.amount),
    });

    if ("existing" in result) {
      logger.info("withdrawal.endpoint.idempotent", {
        correlationId,
        motebitId,
        withdrawalId: result.existing.withdrawal_id,
        idempotencyKey,
      });
      return c.json({
        motebit_id: motebitId,
        withdrawal: toWithdrawalResponse(result.existing),
        idempotent: true,
      });
    }

    logger.info("withdrawal.endpoint.requested", {
      correlationId,
      motebitId,
      withdrawalId: result.withdrawal_id,
      amount: body.amount,
      destination: result.destination,
      idempotencyKey: idempotencyKey ?? null,
    });
    return c.json({ motebit_id: motebitId, withdrawal: toWithdrawalResponse(result) });
  });

  // --- Withdrawal history ---
  app.get("/api/v1/agents/:motebitId/withdrawals", (c) => {
    const motebitId = c.req.param("motebitId");
    const withdrawals = getWithdrawals(moteDb.db, motebitId, 50).map((w) => ({
      ...w,
      amount: fromMicro(w.amount),
    }));
    return c.json({ motebit_id: motebitId, withdrawals });
  });

  // --- Admin: pending withdrawals ---
  app.get("/api/v1/admin/withdrawals/pending", (c) => {
    const withdrawals = getPendingWithdrawals(moteDb.db).map((w) => ({
      ...w,
      amount: fromMicro(w.amount),
    }));
    return c.json({ withdrawals, count: withdrawals.length });
  });

  // --- Admin: complete withdrawal ---
  app.post("/api/v1/admin/withdrawals/:withdrawalId/complete", async (c) => {
    const withdrawalId = c.req.param("withdrawalId");
    const correlationId = c.get("correlationId" as never) as string;
    const body = await c.req.json<{ payout_reference: string }>();
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

    logger.info("withdrawal.admin.completed", {
      correlationId,
      withdrawalId,
      payoutReference: body.payout_reference,
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
  app.post("/api/v1/admin/freeze", async (c) => {
    const body = await c.req.json<{ reason?: string }>().catch(() => ({}) as { reason?: string });
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    if (!reason) throw new HTTPException(400, { message: "reason is required" });

    // Persist to DB first, then update in-memory cache
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

  app.post("/api/v1/admin/unfreeze", async (c) => {
    const previousReason = freezeState.reason;
    // Persist to DB first, then update in-memory cache
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
  app.post("/api/v1/agents/:motebitId/checkout", async (c) => {
    if (!stripeClient || !stripeConfig)
      throw new HTTPException(501, { message: "Stripe is not configured on this relay" });

    const motebitId = c.req.param("motebitId");
    const correlationId = c.get("correlationId" as never) as string;
    const body = await c.req.json<{ amount: number }>();
    if (typeof body.amount !== "number" || body.amount <= 0)
      throw new HTTPException(400, { message: "amount must be a positive number (in dollars)" });
    if (body.amount < 0.5)
      throw new HTTPException(400, { message: "Minimum deposit amount is $0.50" });

    const baseUrl = new URL(c.req.url);
    const session = await stripeClient.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: {
            currency: stripeConfig.currency ?? "usd",
            product_data: { name: `Motebit Agent Deposit (${motebitId.slice(0, 8)}...)` },
            unit_amount: Math.round(body.amount * 100),
          },
          quantity: 1,
        },
      ],
      metadata: { motebit_id: motebitId, amount: String(body.amount) },
      success_url: `${baseUrl.origin}/api/v1/agents/${motebitId}/balance`,
      cancel_url: `${baseUrl.origin}/api/v1/agents/${motebitId}/balance`,
    });

    logger.info("stripe.checkout.created", {
      correlationId,
      motebitId,
      sessionId: session.id,
      amount: body.amount,
    });
    return c.json({ checkout_url: session.url, session_id: session.id });
  });

  // --- Stripe webhook ---
  app.post("/api/v1/stripe/webhook", async (c) => {
    if (!stripeClient || !stripeConfig)
      throw new HTTPException(501, { message: "Stripe is not configured on this relay" });

    const sig = c.req.header("stripe-signature");
    if (!sig) throw new HTTPException(400, { message: "Missing stripe-signature header" });

    const rawBody = await c.req.text();
    let event: Stripe.Event;
    try {
      event = stripeClient.webhooks.constructEvent(rawBody, sig, stripeConfig.webhookSecret);
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
}
