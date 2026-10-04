/**
 * The freeze at the money chokepoint, seen from a provider's webhook.
 *
 * A webhook is delivered by a provider that retries only on a non-2xx. A
 * freeze landing after the entry check (here: while the request body is read)
 * makes the credit refused at the write — and if the handler then answers 2xx
 * the provider never retries and the credit is lost. Each money-moving
 * webhook must answer a refused-by-freeze write with a 503 and, on the
 * provider's replay after unfreeze, credit exactly once.
 *
 * Real routes, real Stripe signatures (`generateTestHeaderString`), the real
 * admin freeze/unfreeze routes.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import Stripe from "stripe";
import type { SyncRelay } from "../index.js";
import { createTestRelay, JSON_AUTH } from "./test-helpers.js";
import { getAccountBalance, toMicro } from "../accounts.js";

const WEBHOOK_SECRET = "whsec_freeze_webhooks_test";
const stripe = new Stripe("sk_test_freeze_webhooks");

afterEach(() => {
  vi.restoreAllMocks();
});

const settle = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function relayWithStripe(): Promise<SyncRelay> {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  return createTestRelay({
    enableDeviceAuth: false,
    stripe: { secretKey: "sk_test_freeze_webhooks", webhookSecret: WEBHOOK_SECRET },
  });
}

async function freeze(relay: SyncRelay): Promise<void> {
  const res = await relay.app.request("/api/v1/admin/freeze", {
    method: "POST",
    headers: JSON_AUTH,
    body: JSON.stringify({ reason: "freeze-webhooks" }),
  });
  expect(res.status, await res.clone().text()).toBe(200);
}
async function unfreeze(relay: SyncRelay): Promise<void> {
  const res = await relay.app.request("/api/v1/admin/unfreeze", {
    method: "POST",
    headers: JSON_AUTH,
  });
  expect(res.status, await res.clone().text()).toBe(200);
}

function signedEvent(
  type: string,
  object: Record<string, unknown>,
): {
  payload: string;
  signature: string;
} {
  const payload = JSON.stringify({
    id: `evt_${crypto.randomUUID().replace(/-/g, "")}`,
    object: "event",
    type,
    api_version: "2025-03-31.basil",
    created: Math.floor(Date.now() / 1000),
    data: { object },
  });
  const signature = stripe.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });
  return { payload, signature };
}

/** Deliver a webhook (the provider's delivery: same bytes, same signature). */
async function deliver(
  relay: SyncRelay,
  path: string,
  ev: { payload: string; signature: string },
): Promise<Response> {
  return relay.app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "stripe-signature": ev.signature },
    body: ev.payload,
  });
}

/**
 * Deliver a webhook whose body stream is held open: the request passes the
 * freeze middleware's entry check, the freeze lands while the handler awaits
 * the body, then the body arrives.
 */
async function deliverFreezingMidFlight(
  relay: SyncRelay,
  path: string,
  ev: { payload: string; signature: string },
): Promise<Response> {
  let push!: (c: Uint8Array) => void;
  let end!: () => void;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      push = (c) => controller.enqueue(c);
      end = () => controller.close();
    },
  });
  const pending = relay.app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "stripe-signature": ev.signature },
    body: stream,
    duplex: "half",
  } as RequestInit);
  await settle(20);
  await freeze(relay);
  push(new TextEncoder().encode(ev.payload));
  end();
  return pending;
}

const balance = (relay: SyncRelay, id: string): number =>
  getAccountBalance(relay.moteDb.db, id)?.balance ?? 0;
const txCount = (relay: SyncRelay, ref: string): number =>
  (
    relay.moteDb.db
      .prepare("SELECT COUNT(*) AS n FROM relay_transactions WHERE reference_id = ?")
      .get(ref) as { n: number }
  ).n;
const subRow = (relay: SyncRelay, id: string): unknown =>
  relay.moteDb.db.prepare("SELECT status FROM relay_subscriptions WHERE motebit_id = ?").get(id);

const SUBS = "/api/v1/subscriptions/webhook";

function checkoutEvent(motebitId: string, subId: string) {
  return signedEvent("checkout.session.completed", {
    id: `cs_${crypto.randomUUID().replace(/-/g, "")}`,
    object: "checkout.session",
    mode: "subscription",
    metadata: { motebit_id: motebitId },
    subscription: subId,
    customer: "cus_fz",
    customer_details: { email: "FZ@example.com" },
  });
}
function invoiceEvent(subId: string, invoiceId: string) {
  return signedEvent("invoice.paid", {
    id: invoiceId,
    object: "invoice",
    billing_reason: "subscription_cycle",
    parent: { subscription_details: { subscription: subId } },
  });
}

describe("subscription webhook — a freeze landing mid-delivery", () => {
  it("checkout_completed: 503 while frozen (no row, no credit); the replay after unfreeze credits once", async () => {
    const relay = await relayWithStripe();
    try {
      const id = "fz-sub-checkout";
      const ev = checkoutEvent(id, "sub_fz_checkout");

      const res = await deliverFreezingMidFlight(relay, SUBS, ev);
      expect(res.status, await res.clone().text()).toBe(503);
      expect(((await res.json()) as { code?: string }).code).toBe("EMERGENCY_FROZEN");
      expect(balance(relay, id)).toBe(0);
      expect(subRow(relay, id), "the subscription row and the credit are one transaction").toBe(
        undefined,
      );

      await unfreeze(relay);
      const replay = await deliver(relay, SUBS, ev);
      expect(replay.status, await replay.clone().text()).toBe(200);
      expect(balance(relay, id)).toBe(toMicro(20));
      expect(subRow(relay, id)).toEqual({ status: "active" });

      const again = await deliver(relay, SUBS, ev);
      expect(again.status).toBe(200);
      expect(balance(relay, id), "exactly one credit").toBe(toMicro(20));
      expect(txCount(relay, "sub:sub_fz_checkout:initial")).toBe(1);
    } finally {
      await relay.close();
    }
  });

  it("invoice_paid (renewal): 503 while frozen (no credit); the replay after unfreeze credits once", async () => {
    const relay = await relayWithStripe();
    try {
      const id = "fz-sub-renewal";
      expect((await deliver(relay, SUBS, checkoutEvent(id, "sub_fz_renew"))).status).toBe(200);
      expect(balance(relay, id)).toBe(toMicro(20));

      const ev = invoiceEvent("sub_fz_renew", "in_fz_renew_1");
      const res = await deliverFreezingMidFlight(relay, SUBS, ev);
      expect(res.status, await res.clone().text()).toBe(503);
      expect(((await res.json()) as { code?: string }).code).toBe("EMERGENCY_FROZEN");
      expect(balance(relay, id), "FROZEN: the renewal is not credited").toBe(toMicro(20));

      await unfreeze(relay);
      const replay = await deliver(relay, SUBS, ev);
      expect(replay.status, await replay.clone().text()).toBe(200);
      expect(balance(relay, id), "RESUME: the renewal credited").toBe(toMicro(40));
      const again = await deliver(relay, SUBS, ev);
      expect(again.status).toBe(200);
      expect(balance(relay, id), "exactly one renewal credit").toBe(toMicro(40));
      expect(txCount(relay, "sub:sub_fz_renew:in_fz_renew_1")).toBe(1);
    } finally {
      await relay.close();
    }
  });

  it("a processing failure that leaves money unmoved is a 500 (retried), never a 200; the retry credits once", async () => {
    const relay = await relayWithStripe();
    try {
      const id = "fz-sub-fail";
      const db = relay.moteDb.db;
      db.exec(`CREATE TEMP TRIGGER fz_fail_credit BEFORE INSERT ON main.relay_transactions
               BEGIN SELECT RAISE(ABORT, 'disk on fire'); END;`);
      const ev = checkoutEvent(id, "sub_fz_fail");
      const res = await deliver(relay, SUBS, ev);
      expect(res.status, await res.clone().text()).toBe(500);
      expect(balance(relay, id)).toBe(0);
      expect(subRow(relay, id), "rolled back with the credit").toBe(undefined);

      db.exec("DROP TRIGGER temp.fz_fail_credit");
      expect((await deliver(relay, SUBS, ev)).status).toBe(200);
      expect((await deliver(relay, SUBS, ev)).status).toBe(200);
      expect(balance(relay, id), "exactly one credit").toBe(toMicro(20));
    } finally {
      await relay.close();
    }
  });
});

describe("deposit webhook (Stripe Checkout) — a freeze landing mid-delivery", () => {
  it("checkout.session.completed: 503 while frozen (no credit); the replay after unfreeze credits once", async () => {
    const relay = await relayWithStripe();
    try {
      const id = "fz-deposit-webhook";
      const sessionId = `cs_${crypto.randomUUID().replace(/-/g, "")}`;
      const ev = signedEvent("checkout.session.completed", {
        id: sessionId,
        object: "checkout.session",
        mode: "payment",
        metadata: { motebit_id: id, amount: "7.5" },
        payment_intent: "pi_fz_deposit",
      });
      const path = "/api/v1/stripe/webhook";

      const res = await deliverFreezingMidFlight(relay, path, ev);
      expect(res.status, await res.clone().text()).toBe(503);
      expect(((await res.json()) as { code?: string }).code).toBe("EMERGENCY_FROZEN");
      expect(balance(relay, id)).toBe(0);

      await unfreeze(relay);
      const replay = await deliver(relay, path, ev);
      expect(replay.status, await replay.clone().text()).toBe(200);
      expect(balance(relay, id)).toBe(toMicro(7.5));
      expect((await deliver(relay, path, ev)).status).toBe(200);
      expect(balance(relay, id), "exactly one credit").toBe(toMicro(7.5));
    } finally {
      await relay.close();
    }
  });
});
