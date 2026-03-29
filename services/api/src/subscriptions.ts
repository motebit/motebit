/**
 * Subscription management — tier-based access control for the proxy.
 *
 * Stripe is source of truth for billing. The relay caches the active tier locally
 * for fast lookups and issues short-lived Ed25519-signed proxy tokens that the
 * edge proxy can verify without roundtrips.
 *
 * Three tiers:
 *   free — 50 msgs/day, haiku only
 *   pro  — 500 msgs/day, sonnet + haiku, $20 credit pool
 *   byok — unlimited, any model (bring your own key)
 */

import type { Hono } from "hono";
import Stripe from "stripe";
import type { DatabaseDriver } from "@motebit/persistence";
import { canonicalJson, sign, toBase64Url } from "@motebit/crypto";
import type { RelayIdentity } from "./federation.js";
import { createLogger } from "./logger.js";

const logger = createLogger({ service: "relay", module: "subscriptions" });

// ── Tier configuration ──────────────────────────────────────────────────

export type SubscriptionTier = "free" | "pro" | "ultra" | "byok";

const TIER_CONFIG = {
  free: { daily_limit: 0, models: [], max_tokens: 0 }, // no proxy — local inference only
  pro: {
    daily_limit: 500,
    models: ["claude-sonnet-4-20250514"],
    max_tokens: 8192,
  },
  ultra: {
    daily_limit: 1000,
    models: ["claude-opus-4-20250115", "claude-sonnet-4-20250514"],
    max_tokens: 16384,
  },
  byok: { daily_limit: Infinity, models: [], max_tokens: 0 }, // no proxy limits
} as const;

const PROXY_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

// ── Proxy token types ───────────────────────────────────────────────────

export interface ProxyToken {
  mid: string; // motebit_id
  tier: string; // "free" | "pro"
  lim: number; // daily message limit
  models: string[]; // allowed models
  mtk: number; // max_tokens per request
  jti: string; // unique token id (nonce) — prevents replay identification
  iat: number; // issued at (epoch ms)
  exp: number; // expires at (epoch ms)
}

// ── Database schema ─────────────────────────────────────────────────────

/** Create subscription tables. Idempotent. */
export function createSubscriptionTables(db: DatabaseDriver): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS relay_subscriptions (
      motebit_id TEXT PRIMARY KEY,
      tier TEXT NOT NULL DEFAULT 'free',
      stripe_customer_id TEXT,
      stripe_subscription_id TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      current_period_start INTEGER,
      current_period_end INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_relay_subs_stripe_customer
      ON relay_subscriptions (stripe_customer_id) WHERE stripe_customer_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_relay_subs_stripe_sub
      ON relay_subscriptions (stripe_subscription_id) WHERE stripe_subscription_id IS NOT NULL;

  `);
  // Note: usage tracking is handled by the proxy's Vercel KV (single source of truth).
  // No relay-side usage table — the relay reads the proxy's counter via Upstash REST API.
}

// ── Tier lookups ────────────────────────────────────────────────────────

/** Get the current subscription tier for an agent. Defaults to "free". */
export function getSubscriptionTier(db: DatabaseDriver, motebitId: string): SubscriptionTier {
  const row = db
    .prepare("SELECT tier FROM relay_subscriptions WHERE motebit_id = ? AND status = 'active'")
    .get(motebitId) as { tier: string } | undefined;
  if (!row) return "free";
  const tier = row.tier as SubscriptionTier;
  return tier === "pro" || tier === "ultra" || tier === "byok" ? tier : "free";
}

/** Get or initialize a subscription record. Returns the current tier. */
function getOrCreateSubscription(db: DatabaseDriver, motebitId: string): SubscriptionTier {
  const existing = db
    .prepare("SELECT tier FROM relay_subscriptions WHERE motebit_id = ?")
    .get(motebitId) as { tier: string } | undefined;
  if (existing) return existing.tier as SubscriptionTier;

  const now = Date.now();
  db.prepare(
    "INSERT INTO relay_subscriptions (motebit_id, tier, status, created_at, updated_at) VALUES (?, 'free', 'active', ?, ?)",
  ).run(motebitId, now, now);
  return "free";
}

// ── Usage tracking ──────────────────────────────────────────────────────
//
// Single source of truth: the proxy's Vercel KV (Upstash Redis).
// The proxy increments `proxy:sub:{mid}:{date}` on every message at the edge.
// The relay reads that same counter via the Upstash REST API — no shadow table,
// no divergence. If KV is unreachable, usage defaults to 0 (the proxy enforces
// limits independently, so the relay's read is for display, not enforcement).

function todayDateString(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD in UTC
}

/**
 * Read the proxy's authoritative daily usage counter from Vercel KV (Upstash REST API).
 * Returns 0 if KV is unreachable or not configured — the proxy enforces limits
 * independently, so the relay's read is for display and token-issuance gating only.
 */
async function getProxyDailyUsage(motebitId: string): Promise<number> {
  const kvUrl = process.env["KV_REST_API_URL"];
  const kvToken = process.env["KV_REST_API_TOKEN"];
  if (!kvUrl || !kvToken) return 0;

  const key = `proxy:sub:${motebitId}:${todayDateString()}`;
  try {
    const res = await fetch(`${kvUrl}/get/${key}`, {
      headers: { Authorization: `Bearer ${kvToken}` },
    });
    if (!res.ok) return 0;
    const data = (await res.json()) as { result: string | null };
    return data.result != null ? parseInt(data.result, 10) : 0;
  } catch {
    return 0;
  }
}

// ── Proxy token issuance ────────────────────────────────────────────────

/**
 * Issue a signed proxy token for the given agent.
 *
 * Format: base64url(payload_json) + "." + base64url(Ed25519(payload_bytes))
 *
 * The proxy can verify the signature with the relay's public key and enforce
 * tier limits without any relay roundtrip.
 */
export async function issueProxyToken(
  motebitId: string,
  tier: SubscriptionTier,
  relayIdentity: RelayIdentity,
): Promise<string> {
  // byok agents use their own key — no proxy token needed
  if (tier === "byok") {
    throw new Error("byok agents do not use proxy tokens");
  }

  const config = TIER_CONFIG[tier];
  const now = Date.now();

  const payload: ProxyToken = {
    mid: motebitId,
    tier,
    lim: config.daily_limit,
    models: [...config.models],
    mtk: config.max_tokens,
    jti: crypto.randomUUID(),
    iat: now,
    exp: now + PROXY_TOKEN_TTL_MS,
  };

  const payloadBytes = new TextEncoder().encode(canonicalJson(payload));
  const signature = await sign(payloadBytes, relayIdentity.privateKey);

  return toBase64Url(payloadBytes) + "." + toBase64Url(signature);
}

// ── Stripe helpers ──────────────────────────────────────────────────────

function getStripe(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY not configured");
  return new Stripe(key, { apiVersion: "2025-03-31.basil" as Stripe.LatestApiVersion });
}

// ── Route registration ──────────────────────────────────────────────────

export function registerSubscriptionRoutes(
  app: Hono,
  db: DatabaseDriver,
  relayIdentity: RelayIdentity,
): void {
  // ── POST /api/v1/subscriptions/checkout ───────────────────────────────
  // Creates a Stripe Checkout session. Supports embedded (web) and hosted (fallback) modes.
  app.post("/api/v1/subscriptions/checkout", async (c) => {
    const body = await c.req.json<{
      motebit_id: string;
      tier?: "pro" | "ultra";
      ui_mode?: "embedded" | "hosted";
      return_url?: string;
      success_url?: string;
      cancel_url?: string;
    }>();
    const { motebit_id } = body;
    const tier = body.tier ?? "pro";
    const uiMode = body.ui_mode ?? "embedded";

    if (!motebit_id || typeof motebit_id !== "string") {
      return c.json({ error: "motebit_id required" }, 400);
    }

    const priceId =
      tier === "ultra" ? process.env.STRIPE_ULTRA_PRICE_ID : process.env.STRIPE_PRO_PRICE_ID;
    if (!priceId) {
      logger.error("checkout.missing_price_id", { tier });
      return c.json({ error: "subscription checkout not configured" }, 500);
    }

    // If already subscribed to requested tier (or higher), don't create another checkout
    const currentTier = getSubscriptionTier(db, motebit_id);
    if (currentTier === tier || (currentTier === "ultra" && tier === "pro")) {
      return c.json({ error: `already subscribed to ${currentTier}` }, 409);
    }

    try {
      const stripe = getStripe();

      // Reuse existing Stripe customer if we have one
      const existing = db
        .prepare(
          "SELECT stripe_customer_id FROM relay_subscriptions WHERE motebit_id = ? AND stripe_customer_id IS NOT NULL",
        )
        .get(motebit_id) as { stripe_customer_id: string } | undefined;

      let customerId = existing?.stripe_customer_id;
      if (!customerId) {
        const customer = await stripe.customers.create({
          metadata: { motebit_id },
        });
        customerId = customer.id;
      }

      if (uiMode === "embedded") {
        // Embedded mode: return client secret for Stripe.js embedded checkout
        const session = await stripe.checkout.sessions.create({
          customer: customerId,
          mode: "subscription",
          ui_mode: "embedded",
          line_items: [{ price: priceId, quantity: 1 }],
          metadata: { motebit_id, tier },
          return_url:
            body.return_url ??
            `${c.req.url.split("/api")[0]}/?checkout_session_id={CHECKOUT_SESSION_ID}`,
        });

        logger.info("checkout.created", {
          motebitId: motebit_id,
          sessionId: session.id,
          uiMode: "embedded",
          tier,
        });
        return c.json({ clientSecret: session.client_secret, session_id: session.id });
      }

      // Hosted mode: redirect-based checkout (CLI, fallback)
      const session = await stripe.checkout.sessions.create({
        customer: customerId,
        mode: "subscription",
        line_items: [{ price: priceId, quantity: 1 }],
        metadata: { motebit_id, tier },
        success_url:
          body.success_url ??
          `${c.req.url.split("/api")[0]}/subscription/success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: body.cancel_url ?? `${c.req.url.split("/api")[0]}/subscription/cancel`,
      });

      logger.info("checkout.created", {
        motebitId: motebit_id,
        sessionId: session.id,
        uiMode: "hosted",
        tier,
      });
      return c.json({ checkout_url: session.url, session_id: session.id });
    } catch (err) {
      logger.error("checkout.failed", {
        motebitId: motebit_id,
        error: err instanceof Error ? err.message : String(err),
      });
      return c.json({ error: "failed to create checkout session" }, 500);
    }
  });

  // ── POST /api/v1/subscriptions/webhook ────────────────────────────────
  // Stripe webhook handler. Verifies signature and processes billing events.
  app.post("/api/v1/subscriptions/webhook", async (c) => {
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!webhookSecret) {
      logger.error("webhook.missing_secret", {});
      return c.json({ error: "webhook not configured" }, 500);
    }

    const signature = c.req.header("stripe-signature");
    if (!signature) {
      return c.json({ error: "missing stripe-signature header" }, 400);
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
          const session = event.data.object as Stripe.Checkout.Session;
          if (session.mode !== "subscription") break;

          const motebitId = session.metadata?.motebit_id;
          if (!motebitId) {
            logger.warn("webhook.checkout.missing_motebit_id", { sessionId: session.id });
            break;
          }

          const subscriptionId =
            typeof session.subscription === "string"
              ? session.subscription
              : session.subscription?.id;

          const customerId =
            typeof session.customer === "string" ? session.customer : session.customer?.id;

          if (!subscriptionId || !customerId) {
            logger.warn("webhook.checkout.missing_ids", { sessionId: session.id });
            break;
          }

          const checkoutTier = session.metadata?.tier === "ultra" ? "ultra" : "pro";
          const now = Date.now();
          // Upsert subscription record
          const existingRow = db
            .prepare("SELECT motebit_id FROM relay_subscriptions WHERE motebit_id = ?")
            .get(motebitId);

          if (existingRow) {
            db.prepare(
              `UPDATE relay_subscriptions
               SET tier = ?, stripe_customer_id = ?, stripe_subscription_id = ?,
                   status = 'active', updated_at = ?
               WHERE motebit_id = ?`,
            ).run(checkoutTier, customerId, subscriptionId, now, motebitId);
          } else {
            db.prepare(
              `INSERT INTO relay_subscriptions
                 (motebit_id, tier, stripe_customer_id, stripe_subscription_id, status, created_at, updated_at)
               VALUES (?, ?, ?, ?, 'active', ?, ?)`,
            ).run(motebitId, checkoutTier, customerId, subscriptionId, now, now);
          }

          logger.info("webhook.subscription.activated", {
            motebitId,
            subscriptionId,
            customerId,
          });
          break;
        }

        case "customer.subscription.updated": {
          const subscription = event.data.object as Stripe.Subscription;
          const subId = subscription.id;

          const row = db
            .prepare("SELECT motebit_id FROM relay_subscriptions WHERE stripe_subscription_id = ?")
            .get(subId) as { motebit_id: string } | undefined;

          if (!row) {
            logger.warn("webhook.subscription.updated.unknown", { subscriptionId: subId });
            break;
          }

          const now = Date.now();
          const status = subscription.status;
          const isActive = status === "active" || status === "trialing";

          db.prepare(
            `UPDATE relay_subscriptions
             SET tier = ?, status = ?, current_period_start = ?, current_period_end = ?, updated_at = ?
             WHERE stripe_subscription_id = ?`,
          ).run(
            isActive ? "pro" : "free",
            isActive ? "active" : "past_due",
            subscription.current_period_start * 1000,
            subscription.current_period_end * 1000,
            now,
            subId,
          );

          logger.info("webhook.subscription.updated", {
            motebitId: row.motebit_id,
            subscriptionId: subId,
            stripeStatus: status,
            tier: isActive ? "pro" : "free",
          });
          break;
        }

        case "customer.subscription.deleted": {
          const subscription = event.data.object as Stripe.Subscription;
          const subId = subscription.id;

          const row = db
            .prepare("SELECT motebit_id FROM relay_subscriptions WHERE stripe_subscription_id = ?")
            .get(subId) as { motebit_id: string } | undefined;

          if (!row) {
            logger.warn("webhook.subscription.deleted.unknown", { subscriptionId: subId });
            break;
          }

          const now = Date.now();
          db.prepare(
            `UPDATE relay_subscriptions
             SET tier = 'free', status = 'cancelled', updated_at = ?
             WHERE stripe_subscription_id = ?`,
          ).run(now, subId);

          logger.info("webhook.subscription.cancelled", {
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
      // Return 200 to Stripe so it doesn't retry — we logged the error
      return c.json({ received: true, error: "processing failed" });
    }

    return c.json({ received: true });
  });

  // ── GET /api/v1/subscriptions/:motebitId/status ───────────────────────
  // Returns subscription tier, usage, and limits.
  // Usage is read from the proxy's KV counter (single source of truth).
  app.get("/api/v1/subscriptions/:motebitId/status", async (c) => {
    const motebitId = c.req.param("motebitId");

    const tier = getOrCreateSubscription(db, motebitId);
    const config = TIER_CONFIG[tier];
    const usage = await getProxyDailyUsage(motebitId);

    return c.json({
      motebit_id: motebitId,
      tier,
      daily_limit: config.daily_limit === Infinity ? null : config.daily_limit,
      daily_used: usage,
      daily_remaining:
        config.daily_limit === Infinity ? null : Math.max(0, config.daily_limit - usage),
      models: [...config.models],
      max_tokens: config.max_tokens,
    });
  });

  // ── POST /api/v1/subscriptions/:motebitId/proxy-token ─────────────────
  // Issue a signed proxy token for the edge proxy.
  app.post("/api/v1/subscriptions/:motebitId/proxy-token", async (c) => {
    const motebitId = c.req.param("motebitId");

    const tier = getOrCreateSubscription(db, motebitId);

    if (tier === "byok") {
      return c.json({ error: "byok agents use their own API key" }, 400);
    }

    // Check usage from proxy KV (single source of truth) before issuing token
    const config = TIER_CONFIG[tier];
    const usage = await getProxyDailyUsage(motebitId);

    if (usage >= config.daily_limit) {
      return c.json(
        {
          error: "daily limit reached",
          tier,
          daily_limit: config.daily_limit,
          daily_used: usage,
        },
        429,
      );
    }

    try {
      const token = await issueProxyToken(motebitId, tier, relayIdentity);

      logger.info("proxy-token.issued", {
        motebitId,
        tier,
        dailyUsage: usage,
      });

      return c.json({
        token,
        tier,
        expires_at: Date.now() + PROXY_TOKEN_TTL_MS,
        daily_used: usage,
        daily_remaining: Math.max(0, config.daily_limit - usage),
      });
    } catch (err) {
      logger.error("proxy-token.failed", {
        motebitId,
        error: err instanceof Error ? err.message : String(err),
      });
      return c.json({ error: "failed to issue proxy token" }, 500);
    }
  });
}
