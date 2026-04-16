/**
 * StripeSubscriptionEventAdapter unit tests.
 *
 * Exercises the Stripe → motebit vocabulary mapping with a mocked Stripe
 * SDK — no real API calls. Locks in the contracts of
 * `webhooks/stripe-webhook-adapter.ts`:
 *
 *   - `verifyAndParse` returns `null` on signature failure (never throws).
 *   - Every supported Stripe event type maps to exactly one `kind` on the
 *     motebit-shaped `SubscriptionEvent` union.
 *   - Malformed events (missing metadata, missing nested ids) downgrade
 *     to `{ kind: "ignored" }` so the relay short-circuits on one branch.
 *   - Unknown event types surface as `{ kind: "ignored" }` rather than
 *     throwing — Stripe adds event types without warning.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { StripeSubscriptionEventAdapter } from "../webhooks/stripe-webhook-adapter.js";

// ── Mock Stripe SDK ─────────────────────────────────────────────────────

interface MockStripe {
  webhooks: {
    constructEvent: ReturnType<typeof vi.fn>;
  };
}

function createMockStripe(): MockStripe {
  return {
    webhooks: {
      constructEvent: vi.fn(),
    },
  };
}

function makeAdapter(mock: MockStripe): StripeSubscriptionEventAdapter {
  return new StripeSubscriptionEventAdapter({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    stripeClient: mock as any,
    webhookSecret: "whsec_test_secret",
  });
}

describe("StripeSubscriptionEventAdapter", () => {
  let mock: MockStripe;
  let adapter: StripeSubscriptionEventAdapter;

  beforeEach(() => {
    mock = createMockStripe();
    adapter = makeAdapter(mock);
  });

  // ── Signature handling ────────────────────────────────────────────────

  describe("verifyAndParse — signature handling", () => {
    it("returns null on signature failure (does not throw)", async () => {
      mock.webhooks.constructEvent.mockImplementationOnce(() => {
        throw new Error("Invalid signature");
      });
      const result = await adapter.verifyAndParse("raw-body", "bad-sig");
      expect(result).toBeNull();
    });

    it("passes raw body, signature, and secret to constructEvent", async () => {
      mock.webhooks.constructEvent.mockReturnValueOnce({
        type: "unknown.event",
        data: { object: {} },
      });
      await adapter.verifyAndParse("raw-body-text", "t=123,v1=abc");
      expect(mock.webhooks.constructEvent).toHaveBeenCalledWith(
        "raw-body-text",
        "t=123,v1=abc",
        "whsec_test_secret",
      );
    });
  });

  // ── checkout.session.completed → checkout_completed ───────────────────

  describe("checkout.session.completed", () => {
    it("maps a subscription-mode session with all fields to checkout_completed", async () => {
      mock.webhooks.constructEvent.mockReturnValueOnce({
        type: "checkout.session.completed",
        data: {
          object: {
            mode: "subscription",
            metadata: { motebit_id: "mote-abc" },
            subscription: "sub_123",
            customer: "cus_456",
            customer_details: { email: "User@Example.com" },
            customer_email: null,
          },
        },
      });
      const event = await adapter.verifyAndParse("body", "sig");
      expect(event).toEqual({
        kind: "checkout_completed",
        motebit_id: "mote-abc",
        subscription_id: "sub_123",
        customer_id: "cus_456",
        email: "user@example.com",
      });
    });

    it("extracts ids from nested objects when Stripe expands them", async () => {
      mock.webhooks.constructEvent.mockReturnValueOnce({
        type: "checkout.session.completed",
        data: {
          object: {
            mode: "subscription",
            metadata: { motebit_id: "mote-nested" },
            subscription: { id: "sub_nested_789" },
            customer: { id: "cus_nested_012" },
            customer_details: null,
            customer_email: "fallback@example.com",
          },
        },
      });
      const event = await adapter.verifyAndParse("body", "sig");
      expect(event).toMatchObject({
        kind: "checkout_completed",
        subscription_id: "sub_nested_789",
        customer_id: "cus_nested_012",
        email: "fallback@example.com",
      });
    });

    it("sets email to null when neither customer_details nor customer_email is present", async () => {
      mock.webhooks.constructEvent.mockReturnValueOnce({
        type: "checkout.session.completed",
        data: {
          object: {
            mode: "subscription",
            metadata: { motebit_id: "mote-noemail" },
            subscription: "sub_123",
            customer: "cus_456",
            customer_details: null,
            customer_email: null,
          },
        },
      });
      const event = await adapter.verifyAndParse("body", "sig");
      expect(event).toMatchObject({ kind: "checkout_completed", email: null });
    });

    it("ignores sessions whose mode is not subscription", async () => {
      mock.webhooks.constructEvent.mockReturnValueOnce({
        type: "checkout.session.completed",
        data: {
          object: {
            mode: "payment",
            metadata: { motebit_id: "mote-xyz" },
            subscription: "sub_123",
            customer: "cus_456",
          },
        },
      });
      const event = await adapter.verifyAndParse("body", "sig");
      expect(event).toEqual({ kind: "ignored", type: "checkout.session.completed" });
    });

    it("ignores sessions missing motebit_id metadata", async () => {
      mock.webhooks.constructEvent.mockReturnValueOnce({
        type: "checkout.session.completed",
        data: {
          object: {
            mode: "subscription",
            metadata: {}, // no motebit_id
            subscription: "sub_123",
            customer: "cus_456",
          },
        },
      });
      const event = await adapter.verifyAndParse("body", "sig");
      expect(event).toEqual({ kind: "ignored", type: "checkout.session.completed" });
    });

    it("ignores sessions missing subscription or customer ids", async () => {
      mock.webhooks.constructEvent.mockReturnValueOnce({
        type: "checkout.session.completed",
        data: {
          object: {
            mode: "subscription",
            metadata: { motebit_id: "mote-abc" },
            subscription: null,
            customer: "cus_456",
          },
        },
      });
      const event = await adapter.verifyAndParse("body", "sig");
      expect(event).toEqual({ kind: "ignored", type: "checkout.session.completed" });
    });
  });

  // ── invoice.paid → invoice_paid ───────────────────────────────────────

  describe("invoice.paid", () => {
    it("maps an invoice with string subscription to invoice_paid", async () => {
      mock.webhooks.constructEvent.mockReturnValueOnce({
        type: "invoice.paid",
        data: {
          object: {
            id: "in_test_001",
            subscription: "sub_active_123",
          },
        },
      });
      const event = await adapter.verifyAndParse("body", "sig");
      expect(event).toEqual({
        kind: "invoice_paid",
        subscription_id: "sub_active_123",
        invoice_id: "in_test_001",
      });
    });

    it("extracts subscription id from expanded nested object", async () => {
      mock.webhooks.constructEvent.mockReturnValueOnce({
        type: "invoice.paid",
        data: {
          object: {
            id: "in_test_002",
            subscription: { id: "sub_nested_456" },
          },
        },
      });
      const event = await adapter.verifyAndParse("body", "sig");
      expect(event).toMatchObject({
        kind: "invoice_paid",
        subscription_id: "sub_nested_456",
        invoice_id: "in_test_002",
      });
    });

    it("ignores invoices with no subscription (one-off charges)", async () => {
      mock.webhooks.constructEvent.mockReturnValueOnce({
        type: "invoice.paid",
        data: {
          object: {
            id: "in_oneoff_001",
            subscription: null,
          },
        },
      });
      const event = await adapter.verifyAndParse("body", "sig");
      expect(event).toEqual({ kind: "ignored", type: "invoice.paid" });
    });

    it("ignores invoices missing an id", async () => {
      mock.webhooks.constructEvent.mockReturnValueOnce({
        type: "invoice.paid",
        data: {
          object: {
            id: null,
            subscription: "sub_123",
          },
        },
      });
      const event = await adapter.verifyAndParse("body", "sig");
      expect(event).toEqual({ kind: "ignored", type: "invoice.paid" });
    });
  });

  // ── customer.subscription.deleted → subscription_deleted ──────────────

  describe("customer.subscription.deleted", () => {
    it("maps a cancellation to subscription_deleted with the subscription id", async () => {
      mock.webhooks.constructEvent.mockReturnValueOnce({
        type: "customer.subscription.deleted",
        data: {
          object: {
            id: "sub_cancelled_789",
          },
        },
      });
      const event = await adapter.verifyAndParse("body", "sig");
      expect(event).toEqual({
        kind: "subscription_deleted",
        subscription_id: "sub_cancelled_789",
      });
    });
  });

  // ── Unknown event types ──────────────────────────────────────────────

  describe("unknown event types", () => {
    it("surfaces as ignored with the type preserved for logging", async () => {
      mock.webhooks.constructEvent.mockReturnValueOnce({
        type: "charge.succeeded",
        data: { object: {} },
      });
      const event = await adapter.verifyAndParse("body", "sig");
      expect(event).toEqual({ kind: "ignored", type: "charge.succeeded" });
    });

    it("does not throw on events Stripe adds in the future", async () => {
      mock.webhooks.constructEvent.mockReturnValueOnce({
        type: "some.future.stripe.event.type",
        data: { object: { arbitrary: "payload" } },
      });
      await expect(adapter.verifyAndParse("body", "sig")).resolves.toEqual({
        kind: "ignored",
        type: "some.future.stripe.event.type",
      });
    });
  });
});
