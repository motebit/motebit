/**
 * Subscription + proxy token management.
 *
 * Hybrid model: $20/mo subscription → $20 in cloud AI credits deposited monthly.
 * Credits deducted per-token by the proxy (actual cost + 20% margin).
 * When credits run out, creature falls back to local inference until next month.
 *
 * The subscription is the funding pipe. The account ledger is the spending engine.
 * Stripe handles recurring billing. The relay credits the account on each cycle.
 */

import type { Hono } from "hono";
import Stripe from "stripe";
import type { DatabaseDriver } from "@motebit/persistence";
import { canonicalJson, sign, toBase64Url } from "@motebit/crypto";
import type { RelayIdentity } from "./federation.js";
import { createLogger } from "./logger.js";
import {
  getAccountBalance,
  getOrCreateAccount,
  creditAccount,
  debitAccount,
  toMicro,
  fromMicro,
} from "./accounts.js";

const logger = createLogger({ service: "relay", module: "proxy-tokens" });

/** All subscribers can access these models. The proxy enforces per-request cost. */
const DEPOSIT_MODELS = [
  "claude-sonnet-4-20250514",
  "claude-opus-4-20250115",
  "claude-haiku-4-5-20251001",
  "gpt-4o",
  "gpt-4o-mini",
  "gemini-2.5-pro",
  "gemini-2.5-flash",
];

const PROXY_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

/** Monthly credit amount in dollars — matches subscription price. */
const MONTHLY_CREDIT_USD = 20;

// ── Stripe helper ───────────────────────────────────────────────────────

function getStripe(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY not configured");
  return new Stripe(key, { apiVersion: "2025-03-31.basil" as Stripe.LatestApiVersion });
}

// ── Subscription table ──────────────────────────────────────────────────

/** Track subscription status (minimal — Stripe is source of truth). */
export function createSubscriptionTables(db: DatabaseDriver): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS relay_subscriptions (
      motebit_id TEXT PRIMARY KEY,
      email TEXT,
      stripe_customer_id TEXT,
      stripe_subscription_id TEXT,
      status TEXT NOT NULL DEFAULT 'inactive',
      current_period_end INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_relay_subs_stripe_sub
      ON relay_subscriptions (stripe_subscription_id) WHERE stripe_subscription_id IS NOT NULL;
  `);
  // Migration: add billing_email column if table already exists without it
  try {
    db.exec("ALTER TABLE relay_subscriptions ADD COLUMN email TEXT");
  } catch {
    // Column already exists — expected on subsequent boots
  }
}

// ── Proxy token types ───────────────────────────────────────────────────

export interface ProxyToken {
  mid: string; // motebit_id
  bal: number; // balance in micro-units (1 USD = 1,000,000)
  models: string[]; // allowed models
  jti: string; // unique token id (nonce) — prevents replay identification
  iat: number; // issued at (epoch ms)
  exp: number; // expires at (epoch ms)
}

// ── Proxy token issuance ────────────────────────────────────────────────

/**
 * Issue a signed proxy token for the given agent.
 *
 * Format: base64url(payload_json) + "." + base64url(Ed25519(payload_bytes))
 *
 * The proxy can verify the signature with the relay's public key and enforce
 * balance > 0 without any relay roundtrip.
 */
export async function issueProxyToken(
  motebitId: string,
  balanceMicro: number,
  relayIdentity: RelayIdentity,
): Promise<string> {
  const now = Date.now();

  const payload: ProxyToken = {
    mid: motebitId,
    bal: balanceMicro,
    models: [...DEPOSIT_MODELS],
    jti: crypto.randomUUID(),
    iat: now,
    exp: now + PROXY_TOKEN_TTL_MS,
  };

  const payloadBytes = new TextEncoder().encode(canonicalJson(payload));
  const signature = await sign(payloadBytes, relayIdentity.privateKey);

  return toBase64Url(payloadBytes) + "." + toBase64Url(signature);
}

// ── Route registration ──────────────────────────────────────────────────

export function registerProxyTokenRoutes(
  app: Hono,
  db: DatabaseDriver,
  relayIdentity: RelayIdentity,
): void {
  // ── POST /api/v1/agents/:motebitId/proxy-token ────────────────────────
  // Issue a signed proxy token carrying the agent's current balance.
  // The proxy checks bal > 0 before serving and debits after each response.
  app.post("/api/v1/agents/:motebitId/proxy-token", async (c) => {
    const motebitId = c.req.param("motebitId");

    const account = getAccountBalance(db, motebitId);
    const balance = account?.balance ?? 0;

    // Issue token even with zero balance — the proxy will reject (402)
    // and the client will fall back to local inference.
    try {
      const token = await issueProxyToken(motebitId, balance, relayIdentity);

      logger.info("proxy-token.issued", {
        motebitId,
        balance: fromMicro(balance),
      });

      return c.json({
        token,
        balance,
        balance_usd: fromMicro(balance),
        models: balance > 0 ? [...DEPOSIT_MODELS] : [],
        expires_at: Date.now() + PROXY_TOKEN_TTL_MS,
      });
    } catch (err) {
      logger.error("proxy-token.failed", {
        motebitId,
        error: err instanceof Error ? err.message : String(err),
      });
      return c.json({ error: "failed to issue proxy token" }, 500);
    }
  });

  // ── POST /api/v1/agents/:motebitId/debit ──────────────────────────────
  // Called by the proxy after each message to deduct actual compute cost.
  // Authenticated via shared secret (x-relay-secret header), not user auth.
  app.post("/api/v1/agents/:motebitId/debit", async (c) => {
    const secret = c.req.header("x-relay-secret");
    const expectedSecret = process.env.RELAY_PROXY_SECRET;
    if (!expectedSecret || secret !== expectedSecret) {
      return c.json({ error: "unauthorized" }, 401);
    }

    const motebitId = c.req.param("motebitId");
    const body = await c.req.json<{
      amount: number;
      reference_id: string;
      description?: string;
    }>();

    if (typeof body.amount !== "number" || body.amount <= 0) {
      return c.json({ error: "amount must be a positive number (micro-units)" }, 400);
    }

    const newBalance = debitAccount(
      db,
      motebitId,
      body.amount,
      "fee",
      body.reference_id,
      body.description ?? "Cloud AI usage",
    );

    if (newBalance === null) {
      // Insufficient balance — the message was already served (fire-and-forget)
      // Log but don't error — the 20% margin absorbs occasional overruns
      logger.warn("proxy-debit.insufficient", {
        motebitId,
        amount: body.amount,
      });
      return c.json({ success: false, balance: 0 });
    }

    logger.info("proxy-debit.success", {
      motebitId,
      amount: body.amount,
      balanceAfter: newBalance,
    });

    return c.json({ success: true, balance: newBalance });
  });

  // ── GET /api/v1/subscriptions/session-status ────────────────────────────
  // Verify a checkout session and activate subscription + credits if paid.
  // Called by the web app on return from Stripe (no webhook needed for activation).
  app.get("/api/v1/subscriptions/session-status", async (c) => {
    const sessionId = c.req.query("session_id");
    if (!sessionId) return c.json({ error: "session_id required" }, 400);

    try {
      const stripe = getStripe();
      const session = await stripe.checkout.sessions.retrieve(sessionId);

      if (session.status === "complete" && session.payment_status === "paid") {
        const motebitId = session.metadata?.motebit_id;
        if (!motebitId) return c.json({ status: "complete", error: "no motebit_id" });

        const subscriptionId =
          typeof session.subscription === "string"
            ? session.subscription
            : session.subscription?.id;
        const customerId =
          typeof session.customer === "string" ? session.customer : session.customer?.id;

        if (subscriptionId && customerId) {
          // Extract email from Stripe session
          const email =
            (session.customer_details?.email ?? session.customer_email ?? "").toLowerCase() || null;

          // Upsert subscription
          const now = Date.now();
          const existingRow = db
            .prepare("SELECT motebit_id FROM relay_subscriptions WHERE motebit_id = ?")
            .get(motebitId);

          if (existingRow) {
            db.prepare(
              `UPDATE relay_subscriptions
               SET email = COALESCE(?, email), stripe_customer_id = ?, stripe_subscription_id = ?, status = 'active', updated_at = ?
               WHERE motebit_id = ?`,
            ).run(email, customerId, subscriptionId, now, motebitId);
          } else {
            db.prepare(
              `INSERT INTO relay_subscriptions (motebit_id, email, stripe_customer_id, stripe_subscription_id, status, created_at, updated_at)
               VALUES (?, ?, ?, ?, 'active', ?, ?)`,
            ).run(motebitId, email, customerId, subscriptionId, now, now);
          }

          // Credit account (idempotent via reference_id)
          const refId = `sub:${subscriptionId}:initial`;
          const existingTxn = db
            .prepare("SELECT transaction_id FROM relay_transactions WHERE reference_id = ?")
            .get(refId);
          if (!existingTxn) {
            getOrCreateAccount(db, motebitId);
            creditAccount(
              db,
              motebitId,
              toMicro(MONTHLY_CREDIT_USD),
              "deposit",
              refId,
              `Motebit Cloud subscription — $${MONTHLY_CREDIT_USD} credits`,
            );
          }

          const account = getAccountBalance(db, motebitId);
          logger.info("session-status.activated", { motebitId, subscriptionId });

          return c.json({
            status: "complete",
            motebit_id: motebitId,
            balance: account?.balance ?? 0,
            balance_usd: fromMicro(account?.balance ?? 0),
          });
        }
      }

      if (session.status === "expired") return c.json({ status: "expired" });
      return c.json({ status: "open" });
    } catch (err) {
      logger.error("session-status.failed", {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
      return c.json({ error: "failed to retrieve session" }, 500);
    }
  });

  // ── POST /api/v1/subscriptions/checkout ─────────────────────────────────
  // Create a Stripe subscription checkout ($20/mo → $20 credits/month).
  app.post("/api/v1/subscriptions/checkout", async (c) => {
    const body = await c.req.json<{
      motebit_id: string;
      return_url?: string;
    }>();

    if (!body.motebit_id || typeof body.motebit_id !== "string") {
      return c.json({ error: "motebit_id required" }, 400);
    }

    const priceId = process.env.STRIPE_CLOUD_PRICE_ID;
    if (!priceId) {
      logger.error("checkout.missing_price_id", {});
      return c.json({ error: "subscription checkout not configured" }, 500);
    }

    // Check if already subscribed
    const existing = db
      .prepare("SELECT status FROM relay_subscriptions WHERE motebit_id = ? AND status = 'active'")
      .get(body.motebit_id) as { status: string } | undefined;
    if (existing) {
      return c.json({ error: "already subscribed" }, 409);
    }

    try {
      const stripe = getStripe();

      // Reuse Stripe customer if we have one
      const subRow = db
        .prepare(
          "SELECT stripe_customer_id FROM relay_subscriptions WHERE motebit_id = ? AND stripe_customer_id IS NOT NULL",
        )
        .get(body.motebit_id) as { stripe_customer_id: string } | undefined;

      let customerId = subRow?.stripe_customer_id;
      if (!customerId) {
        const customer = await stripe.customers.create({
          metadata: { motebit_id: body.motebit_id },
        });
        customerId = customer.id;
      }

      const session = await stripe.checkout.sessions.create({
        customer: customerId,
        mode: "subscription",
        line_items: [{ price: priceId, quantity: 1 }],
        metadata: { motebit_id: body.motebit_id },
        success_url:
          body.return_url ??
          `${c.req.url.split("/api")[0]}/?checkout_session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: body.return_url ?? `${c.req.url.split("/api")[0]}/`,
      });

      logger.info("subscription.checkout.created", {
        motebitId: body.motebit_id,
        sessionId: session.id,
      });

      return c.json({ checkout_url: session.url, session_id: session.id });
    } catch (err) {
      logger.error("subscription.checkout.failed", {
        motebitId: body.motebit_id,
        error: err instanceof Error ? err.message : String(err),
      });
      return c.json({ error: "failed to create checkout" }, 500);
    }
  });

  // ── POST /api/v1/subscriptions/webhook ────────────────────────────────
  // Stripe webhook: credits account on new subscription + each renewal.
  app.post("/api/v1/subscriptions/webhook", async (c) => {
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!webhookSecret) {
      return c.json({ error: "webhook not configured" }, 500);
    }

    const signature = c.req.header("stripe-signature");
    if (!signature) {
      return c.json({ error: "missing stripe-signature" }, 400);
    }

    let event: Stripe.Event;
    try {
      const stripe = getStripe();
      const rawBody = await c.req.text();
      event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
    } catch (err) {
      logger.warn("webhook.signature_failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      return c.json({ error: "invalid signature" }, 400);
    }

    try {
      switch (event.type) {
        case "checkout.session.completed": {
          const session = event.data.object;
          if (session.mode !== "subscription") break;

          const motebitId = session.metadata?.motebit_id;
          if (!motebitId) break;

          const subscriptionId =
            typeof session.subscription === "string"
              ? session.subscription
              : session.subscription?.id;
          const customerId =
            typeof session.customer === "string" ? session.customer : session.customer?.id;

          if (!subscriptionId || !customerId) break;

          const email =
            (session.customer_details?.email ?? session.customer_email ?? "").toLowerCase() || null;

          // Upsert subscription record
          const now = Date.now();
          const existingRow = db
            .prepare("SELECT motebit_id FROM relay_subscriptions WHERE motebit_id = ?")
            .get(motebitId);

          if (existingRow) {
            db.prepare(
              `UPDATE relay_subscriptions
               SET email = COALESCE(?, email), stripe_customer_id = ?, stripe_subscription_id = ?, status = 'active', updated_at = ?
               WHERE motebit_id = ?`,
            ).run(email, customerId, subscriptionId, now, motebitId);
          } else {
            db.prepare(
              `INSERT INTO relay_subscriptions (motebit_id, email, stripe_customer_id, stripe_subscription_id, status, created_at, updated_at)
               VALUES (?, ?, ?, ?, 'active', ?, ?)`,
            ).run(motebitId, email, customerId, subscriptionId, now, now);
          }

          // Credit the account with monthly credits
          getOrCreateAccount(db, motebitId);
          creditAccount(
            db,
            motebitId,
            toMicro(MONTHLY_CREDIT_USD),
            "deposit",
            `sub:${subscriptionId}:initial`,
            `Motebit Cloud subscription — $${MONTHLY_CREDIT_USD} credits`,
          );

          logger.info("subscription.activated", {
            motebitId,
            subscriptionId,
            creditUsd: MONTHLY_CREDIT_USD,
          });
          break;
        }

        case "invoice.paid": {
          // Monthly renewal — credit the account again
          const invoice = event.data.object;
          const subscriptionId =
            typeof invoice.subscription === "string"
              ? invoice.subscription
              : invoice.subscription?.id;
          if (!subscriptionId) break;

          const row = db
            .prepare("SELECT motebit_id FROM relay_subscriptions WHERE stripe_subscription_id = ?")
            .get(subscriptionId) as { motebit_id: string } | undefined;
          if (!row) break;

          // Idempotency: use invoice ID as reference
          const refId = `sub:${subscriptionId}:${invoice.id}`;
          const existingTxn = db
            .prepare("SELECT transaction_id FROM relay_transactions WHERE reference_id = ?")
            .get(refId);
          if (existingTxn) break; // Already credited for this invoice

          creditAccount(
            db,
            row.motebit_id,
            toMicro(MONTHLY_CREDIT_USD),
            "deposit",
            refId,
            `Motebit Cloud renewal — $${MONTHLY_CREDIT_USD} credits`,
          );

          logger.info("subscription.renewed", {
            motebitId: row.motebit_id,
            subscriptionId,
            invoiceId: invoice.id,
            creditUsd: MONTHLY_CREDIT_USD,
          });
          break;
        }

        case "customer.subscription.deleted": {
          const subscription = event.data.object;
          const subId = subscription.id;

          const row = db
            .prepare("SELECT motebit_id FROM relay_subscriptions WHERE stripe_subscription_id = ?")
            .get(subId) as { motebit_id: string } | undefined;
          if (!row) break;

          db.prepare(
            "UPDATE relay_subscriptions SET status = 'cancelled', updated_at = ? WHERE stripe_subscription_id = ?",
          ).run(Date.now(), subId);

          // Don't claw back credits — user keeps what they have until it runs out
          logger.info("subscription.cancelled", {
            motebitId: row.motebit_id,
            subscriptionId: subId,
          });
          break;
        }

        default:
          logger.debug("webhook.unhandled", { type: event.type });
      }
    } catch (err) {
      logger.error("webhook.processing_failed", {
        type: event.type,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    return c.json({ received: true });
  });

  // ── POST /api/v1/subscriptions/:motebitId/cancel ──────────────────────
  // Cancel subscription at period end. User keeps remaining credits.
  app.post("/api/v1/subscriptions/:motebitId/cancel", async (c) => {
    const motebitId = c.req.param("motebitId");

    const row = db
      .prepare(
        "SELECT stripe_subscription_id, status FROM relay_subscriptions WHERE motebit_id = ?",
      )
      .get(motebitId) as { stripe_subscription_id: string | null; status: string } | undefined;

    if (!row?.stripe_subscription_id || row.status !== "active") {
      return c.json({ error: "no active subscription" }, 404);
    }

    try {
      const stripe = getStripe();
      const updated = await stripe.subscriptions.update(row.stripe_subscription_id, {
        cancel_at_period_end: true,
      });

      const periodEndSec = updated.current_period_end;
      const periodEnd = typeof periodEndSec === "number" ? periodEndSec * 1000 : null;
      db.prepare(
        "UPDATE relay_subscriptions SET status = 'cancelling', current_period_end = ?, updated_at = ? WHERE motebit_id = ?",
      ).run(periodEnd, Date.now(), motebitId);

      logger.info("subscription.cancel_scheduled", { motebitId, activeUntil: periodEnd });

      return c.json({ status: "cancelling", active_until: periodEnd });
    } catch (err) {
      logger.error("subscription.cancel_failed", {
        motebitId,
        error: err instanceof Error ? err.message : String(err),
      });
      return c.json({ error: "failed to cancel" }, 500);
    }
  });

  // ── GET /api/v1/subscriptions/:motebitId/status ───────────────────────
  // Returns subscription status + credit balance.
  app.get("/api/v1/subscriptions/:motebitId/status", (c) => {
    const motebitId = c.req.param("motebitId");

    const sub = db
      .prepare("SELECT status, current_period_end FROM relay_subscriptions WHERE motebit_id = ?")
      .get(motebitId) as { status: string; current_period_end: number | null } | undefined;

    const account = getOrCreateAccount(db, motebitId);

    return c.json({
      motebit_id: motebitId,
      subscribed: sub?.status === "active" || sub?.status === "cancelling",
      subscription_status: sub?.status ?? "none",
      ...(sub?.status === "cancelling" && sub.current_period_end != null
        ? { active_until: sub.current_period_end }
        : {}),
      balance: account.balance,
      balance_usd: fromMicro(account.balance),
      models: account.balance > 0 ? [...DEPOSIT_MODELS] : [],
    });
  });
}
