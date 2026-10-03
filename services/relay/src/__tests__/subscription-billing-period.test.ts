/**
 * One credit per billing period.
 *
 * A new subscriber's first period is announced three ways: the
 * `checkout.session.completed` webhook (C), the checkout-return
 * `session-status` read (S), and the first invoice's `invoice.paid` with
 * `billing_reason: "subscription_create"` (I). Stripe delivers webhooks in no
 * guaranteed order and redelivers them; the web app may read session-status
 * any number of times. All three pay for the SAME period, so together they
 * credit it exactly once — under the period's key `sub:<id>:initial`. Each
 * later period is one `invoice.paid` with `billing_reason:
 * "subscription_cycle"`, credited once under its invoice. An invoice that
 * opens no period (`subscription_update` proration, `manual`, …) credits
 * nothing.
 *
 * Real routes, real Stripe signatures (`generateTestHeaderString`), a Stripe
 * client whose `checkout.sessions.retrieve` answers from the test.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import Stripe from "stripe";
import type { SyncRelay } from "../index.js";
import { createTestRelay } from "./test-helpers.js";
import { getAccountBalance, toMicro } from "../accounts.js";

const hook = vi.hoisted(() => ({
  retrieve: null as null | ((id: string) => Promise<unknown>),
}));
vi.mock("stripe", async (importOriginal) => {
  const m = await importOriginal<{ default: new (...a: never[]) => object }>();
  const Real = m.default;
  class TestStripe extends Real {
    constructor(...a: never[]) {
      super(...a);
      const self = this as unknown as {
        checkout: { sessions: { retrieve: (id: string) => Promise<unknown> } };
      };
      self.checkout.sessions.retrieve = (id: string) => {
        if (hook.retrieve == null) throw new Error("no retrieve stub");
        return hook.retrieve(id);
      };
    }
  }
  return { ...m, default: TestStripe };
});

const WEBHOOK_SECRET = "whsec_billing_period_test";
const SECRET_KEY = "sk_test_billing_period";
const stripe = new Stripe(SECRET_KEY);
const SUBS = "/api/v1/subscriptions/webhook";
const PERIOD = toMicro(20);

afterEach(() => {
  hook.retrieve = null;
  delete process.env.STRIPE_SECRET_KEY;
  vi.restoreAllMocks();
});

async function relayWithStripe(): Promise<SyncRelay> {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  process.env.STRIPE_SECRET_KEY = SECRET_KEY;
  return createTestRelay({
    enableDeviceAuth: false,
    stripe: { secretKey: SECRET_KEY, webhookSecret: WEBHOOK_SECRET },
  });
}

function signedEvent(type: string, object: Record<string, unknown>) {
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

interface Sub {
  motebitId: string;
  subId: string;
  session: Record<string, unknown>;
}
function newSub(): Sub {
  const motebitId = `m-period-${crypto.randomUUID()}`;
  const subId = `sub_${crypto.randomUUID().replace(/-/g, "")}`;
  return {
    motebitId,
    subId,
    session: {
      id: `cs_${crypto.randomUUID().replace(/-/g, "")}`,
      object: "checkout.session",
      mode: "subscription",
      status: "complete",
      payment_status: "paid",
      metadata: { motebit_id: motebitId },
      subscription: subId,
      customer: "cus_period",
      customer_details: { email: "period@example.com" },
    },
  };
}
const checkoutEvent = (s: Sub) => signedEvent("checkout.session.completed", s.session);
const invoiceEvent = (s: Sub, invoiceId: string, billingReason: string | null) =>
  signedEvent("invoice.paid", {
    id: invoiceId,
    object: "invoice",
    billing_reason: billingReason,
    parent: { subscription_details: { subscription: s.subId } },
  });

async function deliver(relay: SyncRelay, ev: { payload: string; signature: string }) {
  const res = await relay.app.request(SUBS, {
    method: "POST",
    headers: { "Content-Type": "application/json", "stripe-signature": ev.signature },
    body: ev.payload,
  });
  expect(res.status, await res.clone().text()).toBe(200);
}
async function sessionStatus(relay: SyncRelay, s: Sub) {
  hook.retrieve = async () => s.session;
  const res = await relay.app.request(
    `/api/v1/subscriptions/session-status?session_id=${String(s.session.id)}`,
    { method: "GET" },
  );
  expect(res.status, await res.clone().text()).toBe(200);
}

const balance = (relay: SyncRelay, id: string): number =>
  getAccountBalance(relay.moteDb.db, id)?.balance ?? 0;
const credits = (relay: SyncRelay, id: string): number =>
  (
    relay.moteDb.db
      .prepare("SELECT COUNT(*) AS n FROM relay_transactions WHERE motebit_id = ? AND amount > 0")
      .get(id) as { n: number }
  ).n;

type Door = "C" | "S" | "I";
function permutations<T>(xs: readonly T[]): T[][] {
  if (xs.length <= 1) return [[...xs]];
  return xs.flatMap((x, i) =>
    permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((rest) => [x, ...rest]),
  );
}
/** Every order of every door set that includes the checkout webhook. */
const ORDERS: Door[][] = [
  ...permutations<Door>(["C", "I"]),
  ...permutations<Door>(["C", "S", "I"]),
];
/**
 * none: each door once. each: every door delivered twice back to back.
 * tail: the whole sequence replayed after it completes (a late redelivery
 * storm).
 */
const REPLAYS = ["none", "each", "tail"] as const;

describe("subscription credits — one credit per billing period, any order, any replay", () => {
  for (const order of ORDERS) {
    for (const replay of REPLAYS) {
      it(`first period via ${order.join("→")} (replay: ${replay}) credits once`, async () => {
        const relay = await relayWithStripe();
        try {
          const s = newSub();
          const firstInvoice = invoiceEvent(s, `in_${crypto.randomUUID()}`, "subscription_create");
          const checkout = checkoutEvent(s);
          const run = async (d: Door) => {
            if (d === "C") await deliver(relay, checkout);
            else if (d === "I") await deliver(relay, firstInvoice);
            else await sessionStatus(relay, s);
          };
          const sequence =
            replay === "each"
              ? order.flatMap((d) => [d, d])
              : replay === "tail"
                ? [...order, ...order]
                : order;
          for (const d of sequence) await run(d);

          expect(balance(relay, s.motebitId), "the first period is credited once").toBe(PERIOD);
          expect(credits(relay, s.motebitId)).toBe(1);

          // The second period: one subscription_cycle invoice, redelivered.
          const renewal = invoiceEvent(s, `in_${crypto.randomUUID()}`, "subscription_cycle");
          await deliver(relay, renewal);
          await deliver(relay, renewal);
          expect(balance(relay, s.motebitId), "each later period once").toBe(2 * PERIOD);

          // A late redelivery of the first period's announcements changes nothing.
          for (const d of order) await run(d);
          expect(balance(relay, s.motebitId)).toBe(2 * PERIOD);
          expect(credits(relay, s.motebitId)).toBe(2);
        } finally {
          await relay.close();
        }
      });
    }
  }

  for (const reason of ["subscription_update", "manual", "subscription_threshold", null]) {
    it(`an invoice that opens no billing period (billing_reason: ${String(reason)}) credits nothing`, async () => {
      const relay = await relayWithStripe();
      try {
        const s = newSub();
        await deliver(relay, checkoutEvent(s));
        expect(balance(relay, s.motebitId)).toBe(PERIOD);
        await deliver(relay, invoiceEvent(s, `in_${crypto.randomUUID()}`, reason));
        expect(balance(relay, s.motebitId)).toBe(PERIOD);
        expect(credits(relay, s.motebitId)).toBe(1);
      } finally {
        await relay.close();
      }
    });
  }
});
