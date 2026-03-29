/**
 * Subscription cancellation tests.
 *
 * Tests the POST /api/v1/subscriptions/:motebitId/cancel endpoint
 * and the cancelling state in the status endpoint.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createSyncRelay } from "../index.js";
import type { SyncRelay } from "../index.js";
const API_TOKEN = "test-token";

// Mock Stripe — avoid real API calls
const mockStripeUpdate = vi.fn();
vi.mock("stripe", () => {
  return {
    default: class Stripe {
      webhooks = { constructEvent: vi.fn() };
      subscriptions = { update: mockStripeUpdate };
      customers = { create: vi.fn() };
      checkout = { sessions: { create: vi.fn(), retrieve: vi.fn() } };
    },
  };
});

describe("Subscription cancellation", () => {
  let relay: SyncRelay;

  beforeEach(async () => {
    mockStripeUpdate.mockReset();

    // Set env vars so Stripe constructor works
    process.env.STRIPE_SECRET_KEY = "sk_test_fake";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_fake";

    relay = await createSyncRelay({
      apiToken: API_TOKEN,
      enableDeviceAuth: true,
      x402: {
        payToAddress: "0x0000000000000000000000000000000000000000",
        network: "eip155:84532",
        testnet: true,
      },
    });
  });

  afterEach(() => {
    relay.close();
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_WEBHOOK_SECRET;
  });

  it("returns 404 when no subscription exists", async () => {
    const res = await relay.app.request("/api/v1/subscriptions/nonexistent-id/cancel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("no active subscription");
  });

  it("returns 404 when subscription has no stripe_subscription_id", async () => {
    const now = Date.now();
    relay.moteDb.db
      .prepare(
        "INSERT INTO relay_subscriptions (motebit_id, tier, status, created_at, updated_at) VALUES (?, 'free', 'active', ?, ?)",
      )
      .run("free-user", now, now);

    const res = await relay.app.request("/api/v1/subscriptions/free-user/cancel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(404);
  });

  it("cancels active subscription at period end", async () => {
    const now = Date.now();
    const periodEnd = Math.floor((now + 30 * 24 * 60 * 60 * 1000) / 1000); // 30 days from now in seconds

    relay.moteDb.db
      .prepare(
        `INSERT INTO relay_subscriptions
         (motebit_id, tier, stripe_customer_id, stripe_subscription_id, status, created_at, updated_at)
         VALUES (?, 'pro', 'cus_test', 'sub_test', 'active', ?, ?)`,
      )
      .run("pro-user", now, now);

    mockStripeUpdate.mockResolvedValue({
      id: "sub_test",
      cancel_at_period_end: true,
      current_period_end: periodEnd,
    });

    const res = await relay.app.request("/api/v1/subscriptions/pro-user/cancel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; active_until: number };
    expect(body.status).toBe("cancelling");
    expect(body.active_until).toBe(periodEnd * 1000);

    // Verify Stripe was called correctly
    expect(mockStripeUpdate).toHaveBeenCalledWith("sub_test", {
      cancel_at_period_end: true,
    });

    // Verify database was updated
    const row = relay.moteDb.db
      .prepare("SELECT status, current_period_end FROM relay_subscriptions WHERE motebit_id = ?")
      .get("pro-user") as { status: string; current_period_end: number };
    expect(row.status).toBe("cancelling");
    expect(row.current_period_end).toBe(periodEnd * 1000);
  });

  it("returns 409 when already cancelling", async () => {
    const now = Date.now();
    relay.moteDb.db
      .prepare(
        `INSERT INTO relay_subscriptions
         (motebit_id, tier, stripe_customer_id, stripe_subscription_id, status, created_at, updated_at)
         VALUES (?, 'pro', 'cus_test', 'sub_test', 'cancelling', ?, ?)`,
      )
      .run("cancelling-user", now, now);

    const res = await relay.app.request("/api/v1/subscriptions/cancelling-user/cancel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(409);
  });

  it("returns 409 when already cancelled", async () => {
    const now = Date.now();
    relay.moteDb.db
      .prepare(
        `INSERT INTO relay_subscriptions
         (motebit_id, tier, stripe_customer_id, stripe_subscription_id, status, created_at, updated_at)
         VALUES (?, 'free', 'cus_test', 'sub_test', 'cancelled', ?, ?)`,
      )
      .run("cancelled-user", now, now);

    const res = await relay.app.request("/api/v1/subscriptions/cancelled-user/cancel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(409);
  });

  it("status endpoint includes cancellation info", async () => {
    const now = Date.now();
    const periodEnd = now + 30 * 24 * 60 * 60 * 1000;

    relay.moteDb.db
      .prepare(
        `INSERT INTO relay_subscriptions
         (motebit_id, tier, stripe_customer_id, stripe_subscription_id, status, current_period_end, created_at, updated_at)
         VALUES (?, 'pro', 'cus_test', 'sub_test', 'cancelling', ?, ?, ?)`,
      )
      .run("status-user", periodEnd, now, now);

    const res = await relay.app.request("/api/v1/subscriptions/status-user/status");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; active_until: number; tier: string };
    expect(body.status).toBe("cancelling");
    expect(body.active_until).toBe(periodEnd);
    expect(body.tier).toBe("pro");
  });
});
