/**
 * Subscription lifecycle endpoint tests.
 *
 * Tests the non-Stripe paths (error paths and database-only paths) for
 * session-status, cancel, resubscribe, status, checkout, and webhook
 * endpoints registered via registerProxyTokenRoutes in subscriptions.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { SyncRelay } from "../index.js";
import { AUTH_HEADER, createTestRelay } from "./test-helpers.js";

let relay: SyncRelay;

beforeEach(async () => {
  // No stripe config — Stripe calls will fail
  relay = await createTestRelay();
});

afterEach(() => {
  relay.close();
});

// ── Helpers ──────────────────────────────────────────────────────────────

/** Seed a subscription record directly in the database. */
function seedSubscription(
  motebitId: string,
  status: string,
  stripeSubId = "sub_test_123",
  periodEnd?: number,
): void {
  const now = Date.now();
  relay.moteDb.db
    .prepare(
      `INSERT OR REPLACE INTO relay_subscriptions
       (motebit_id, stripe_customer_id, stripe_subscription_id, status, current_period_end, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(motebitId, "cus_test_123", stripeSubId, status, periodEnd ?? null, now, now);
}

// ── GET /api/v1/subscriptions/session-status ─────────────────────────────

describe("GET /api/v1/subscriptions/session-status", () => {
  it("returns 400 when session_id is missing", async () => {
    const res = await relay.app.request("/api/v1/subscriptions/session-status", {
      method: "GET",
      headers: AUTH_HEADER,
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("session_id required");
  });

  it("returns 500 when Stripe is not configured", async () => {
    const res = await relay.app.request(
      "/api/v1/subscriptions/session-status?session_id=cs_test_abc",
      { method: "GET", headers: AUTH_HEADER },
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("failed to retrieve session");
  });
});

// ── POST /api/v1/subscriptions/:motebitId/cancel ────────────────────────

describe("POST /api/v1/subscriptions/:motebitId/cancel", () => {
  it("returns 404 when no subscription exists", async () => {
    const res = await relay.app.request("/api/v1/subscriptions/nonexistent-mote/cancel", {
      method: "POST",
      headers: { ...AUTH_HEADER, "Content-Type": "application/json" },
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("no active subscription");
  });

  it("returns 404 for non-existent motebit_id", async () => {
    const res = await relay.app.request("/api/v1/subscriptions/does-not-exist-at-all/cancel", {
      method: "POST",
      headers: { ...AUTH_HEADER, "Content-Type": "application/json" },
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("no active subscription");
  });
});

// ── POST /api/v1/subscriptions/:motebitId/resubscribe ───────────────────

describe("POST /api/v1/subscriptions/:motebitId/resubscribe", () => {
  it("returns 404 when no subscription exists", async () => {
    const res = await relay.app.request("/api/v1/subscriptions/nonexistent-mote/resubscribe", {
      method: "POST",
      headers: { ...AUTH_HEADER, "Content-Type": "application/json" },
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("no cancelling subscription to resume");
  });

  it("returns 404 when subscription is active (not cancelling)", async () => {
    seedSubscription("active-mote", "active");

    const res = await relay.app.request("/api/v1/subscriptions/active-mote/resubscribe", {
      method: "POST",
      headers: { ...AUTH_HEADER, "Content-Type": "application/json" },
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("no cancelling subscription to resume");
  });
});

// ── GET /api/v1/subscriptions/:motebitId/status ─────────────────────────

describe("GET /api/v1/subscriptions/:motebitId/status", () => {
  it("returns none status with zero balance when no subscription exists", async () => {
    const res = await relay.app.request("/api/v1/subscriptions/fresh-mote/status", {
      method: "GET",
      headers: AUTH_HEADER,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      motebit_id: "fresh-mote",
      subscribed: false,
      subscription_status: "none",
      balance: 0,
      balance_usd: 0,
    });
    expect(body.models).toEqual([]);
  });

  it("returns correct structure for an active subscription", async () => {
    seedSubscription("sub-mote", "active");

    const res = await relay.app.request("/api/v1/subscriptions/sub-mote/status", {
      method: "GET",
      headers: AUTH_HEADER,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.motebit_id).toBe("sub-mote");
    expect(body.subscribed).toBe(true);
    expect(body.subscription_status).toBe("active");
    expect(typeof body.balance).toBe("number");
    expect(typeof body.balance_usd).toBe("number");
    expect(Array.isArray(body.models)).toBe(true);
  });

  it("returns cancelling status with active_until when subscription is cancelling", async () => {
    const periodEnd = Date.now() + 30 * 24 * 60 * 60 * 1000; // 30 days from now
    seedSubscription("cancel-mote", "cancelling", "sub_cancel_123", periodEnd);

    const res = await relay.app.request("/api/v1/subscriptions/cancel-mote/status", {
      method: "GET",
      headers: AUTH_HEADER,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.subscribed).toBe(true);
    expect(body.subscription_status).toBe("cancelling");
    expect(body.active_until).toBe(periodEnd);
  });

  it("returns subscribed: false for cancelled subscription", async () => {
    seedSubscription("done-mote", "cancelled");

    const res = await relay.app.request("/api/v1/subscriptions/done-mote/status", {
      method: "GET",
      headers: AUTH_HEADER,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.subscribed).toBe(false);
    expect(body.subscription_status).toBe("cancelled");
    expect(body.active_until).toBeUndefined();
  });

  it("returns non-empty models when balance is positive", async () => {
    // Seed account with positive balance
    relay.moteDb.db
      .prepare(
        `INSERT INTO relay_accounts (motebit_id, balance, currency, created_at, updated_at)
         VALUES (?, ?, 'USD', ?, ?)`,
      )
      .run("funded-mote", 1_000_000, Date.now(), Date.now());

    const res = await relay.app.request("/api/v1/subscriptions/funded-mote/status", {
      method: "GET",
      headers: AUTH_HEADER,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.balance).toBe(1_000_000);
    expect(body.balance_usd).toBe(1);
    expect(body.models.length).toBeGreaterThan(0);
  });
});

// ── POST /api/v1/subscriptions/checkout ─────────────────────────────────

describe("POST /api/v1/subscriptions/checkout", () => {
  it("returns 400 when motebit_id is missing", async () => {
    const res = await relay.app.request("/api/v1/subscriptions/checkout", {
      method: "POST",
      headers: { ...AUTH_HEADER, "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("motebit_id required");
  });

  it("returns 409 when agent is already subscribed", async () => {
    const original = process.env.STRIPE_CLOUD_PRICE_ID;
    process.env.STRIPE_CLOUD_PRICE_ID = "price_test_fake";

    try {
      seedSubscription("already-sub-mote", "active");

      const res = await relay.app.request("/api/v1/subscriptions/checkout", {
        method: "POST",
        headers: { ...AUTH_HEADER, "Content-Type": "application/json" },
        body: JSON.stringify({ motebit_id: "already-sub-mote" }),
      });
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error).toBe("already subscribed");
    } finally {
      if (original !== undefined) {
        process.env.STRIPE_CLOUD_PRICE_ID = original;
      } else {
        delete process.env.STRIPE_CLOUD_PRICE_ID;
      }
    }
  });

  it("returns 500 when STRIPE_CLOUD_PRICE_ID is not set", async () => {
    // Ensure env var is not set
    const original = process.env.STRIPE_CLOUD_PRICE_ID;
    delete process.env.STRIPE_CLOUD_PRICE_ID;

    try {
      const res = await relay.app.request("/api/v1/subscriptions/checkout", {
        method: "POST",
        headers: { ...AUTH_HEADER, "Content-Type": "application/json" },
        body: JSON.stringify({ motebit_id: "test-mote" }),
      });
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error).toBe("subscription checkout not configured");
    } finally {
      if (original !== undefined) process.env.STRIPE_CLOUD_PRICE_ID = original;
    }
  });
});

// ── POST /api/v1/subscriptions/webhook ──────────────────────────────────

describe("POST /api/v1/subscriptions/webhook", () => {
  it("returns 500 when STRIPE_WEBHOOK_SECRET is not set", async () => {
    const original = process.env.STRIPE_WEBHOOK_SECRET;
    delete process.env.STRIPE_WEBHOOK_SECRET;

    try {
      const res = await relay.app.request("/api/v1/subscriptions/webhook", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "stripe-signature": "t=123,v1=abc",
        },
        body: JSON.stringify({ type: "checkout.session.completed" }),
      });
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error).toBe("webhook not configured");
    } finally {
      if (original !== undefined) process.env.STRIPE_WEBHOOK_SECRET = original;
    }
  });

  it("returns 400 when stripe-signature header is missing", async () => {
    const original = process.env.STRIPE_WEBHOOK_SECRET;
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_test_secret";

    try {
      const res = await relay.app.request("/api/v1/subscriptions/webhook", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "checkout.session.completed" }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("missing stripe-signature");
    } finally {
      if (original !== undefined) {
        process.env.STRIPE_WEBHOOK_SECRET = original;
      } else {
        delete process.env.STRIPE_WEBHOOK_SECRET;
      }
    }
  });
});
