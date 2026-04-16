/**
 * SubscriptionEventAdapter — Stripe webhook plumbing, hidden behind a
 * motebit-shaped interface.
 *
 * ## Why this adapter exists
 *
 * Per `services/api/CLAUDE.md` rule 1, the relay must never inline protocol
 * plumbing. The same doctrine extends to **medium plumbing** — direct SDK
 * coupling to Stripe's webhook schema, signature algorithm, and event types.
 * `subscriptions.ts` previously imported `Stripe`, called
 * `stripe.webhooks.constructEvent()`, and switched on `event.type` inside
 * the relay's webhook handler. That marries Stripe's API surface to the
 * relay's account-crediting logic; Stripe ships API version bumps ~2×/year,
 * and every bump risks breaking the relay.
 *
 * This adapter follows the same pattern as
 * `settlement-rails/stripe-rail.ts` (which wraps Stripe Checkout for the
 * deposit path): the interface speaks motebit, the implementation speaks
 * Stripe, and the relay never sees `Stripe.Event` on the happy path.
 *
 * ## Shape
 *
 *   - `SubscriptionEvent` — closed discriminated union in motebit vocabulary.
 *     Adding a new subscription event = adding a new `kind`, not a new
 *     `Stripe.*EventType` branch in the relay.
 *   - `SubscriptionEventAdapter` — single method `verifyAndParse(rawBody,
 *     signature)`. Returns `null` on signature failure (never throws),
 *     `SubscriptionEvent` on a recognized event, or a sentinel
 *     `{ kind: "ignored" }` for event types the relay does not dispatch on.
 *   - `StripeSubscriptionEventAdapter` — the concrete implementation that
 *     owns `Stripe.webhooks.constructEvent` and the event-type switch.
 *
 * The relay's route handler becomes:
 *   const event = await adapter.verifyAndParse(rawBody, signature);
 *   if (event === null) return 400;
 *   switch (event.kind) { ... }
 */

import type Stripe from "stripe";
import { createLogger } from "../logger.js";

const logger = createLogger({ service: "relay", module: "stripe-webhook-adapter" });

// ── Motebit-shaped subscription event union ─────────────────────────────

/**
 * Motebit-shaped subscription status. Maps from Stripe's status vocabulary.
 * Only the statuses the relay acts on are enumerated; everything else
 * collapses to "unknown" (the relay logs and moves on).
 */
export type SubscriptionStatus =
  | "active"
  | "past_due"
  | "canceled"
  | "unpaid"
  | "incomplete"
  | "incomplete_expired"
  | "trialing"
  | "paused"
  | "unknown";

/**
 * Closed union of webhook events the relay dispatches on. Every branch is
 * what `subscriptions.ts` currently handles; ignored event types surface as
 * `{ kind: "ignored" }` so the route handler's switch can remain exhaustive.
 */
export type SubscriptionEvent =
  | {
      kind: "checkout_completed";
      /** The motebit_id extracted from checkout session metadata. */
      motebit_id: string;
      /** Stripe subscription id. */
      subscription_id: string;
      /** Stripe customer id. */
      customer_id: string;
      /** Billing email, lowercased. `null` when Stripe did not surface one. */
      email: string | null;
    }
  | {
      kind: "invoice_paid";
      /** Stripe subscription id the invoice was issued for. */
      subscription_id: string;
      /** Stripe invoice id — used for idempotency on renewals. */
      invoice_id: string;
    }
  | {
      kind: "subscription_deleted";
      /** Stripe subscription id. */
      subscription_id: string;
    }
  | {
      kind: "ignored";
      /** The Stripe event type for debug logging. */
      type: string;
    };

// ── Interface ───────────────────────────────────────────────────────────

export interface SubscriptionEventAdapter {
  /**
   * Verify the webhook signature and parse the event into motebit vocabulary.
   *
   * Returns `null` on signature failure — the route handler returns HTTP 400.
   * Returns a `SubscriptionEvent` on success; `kind: "ignored"` for event
   * types the relay does not act on.
   *
   * MUST NOT throw on signature failure — callers rely on the null contract
   * to distinguish "bad signature" (400) from "parse error" (500).
   */
  verifyAndParse(rawBody: string, signature: string): Promise<SubscriptionEvent | null>;
}

// ── Stripe implementation ───────────────────────────────────────────────

export interface StripeSubscriptionEventAdapterConfig {
  /** Stripe SDK instance — the caller owns construction and secret-key wiring. */
  stripeClient: Stripe;
  /** Webhook signing secret (Stripe dashboard → Webhooks → endpoint). */
  webhookSecret: string;
}

/**
 * Concrete SubscriptionEventAdapter that speaks Stripe. Owns
 * `stripe.webhooks.constructEvent` and the event-type switch. Extracts
 * motebit-shaped fields from nested Stripe objects so the route handler
 * never reads Stripe's schema directly.
 */
export class StripeSubscriptionEventAdapter implements SubscriptionEventAdapter {
  private readonly stripe: Stripe;
  private readonly webhookSecret: string;

  constructor(config: StripeSubscriptionEventAdapterConfig) {
    this.stripe = config.stripeClient;
    this.webhookSecret = config.webhookSecret;
  }

  verifyAndParse(rawBody: string, signature: string): Promise<SubscriptionEvent | null> {
    let event: Stripe.Event;
    try {
      event = this.stripe.webhooks.constructEvent(rawBody, signature, this.webhookSecret);
    } catch (err) {
      logger.warn("webhook.signature_failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      return Promise.resolve(null);
    }

    return Promise.resolve(this.mapEvent(event));
  }

  /**
   * Stripe.Event → SubscriptionEvent. Isolated so tests can exercise the
   * mapping directly without constructing signatures.
   */
  private mapEvent(event: Stripe.Event): SubscriptionEvent {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object;
        if (session.mode !== "subscription") {
          return { kind: "ignored", type: event.type };
        }

        const motebitId = session.metadata?.motebit_id;
        if (!motebitId) {
          return { kind: "ignored", type: event.type };
        }

        const subscriptionId =
          typeof session.subscription === "string"
            ? session.subscription
            : (session.subscription?.id ?? null);
        const customerId =
          typeof session.customer === "string" ? session.customer : (session.customer?.id ?? null);

        if (!subscriptionId || !customerId) {
          return { kind: "ignored", type: event.type };
        }

        const rawEmail = session.customer_details?.email ?? session.customer_email ?? "";
        const email = rawEmail.toLowerCase() || null;

        return {
          kind: "checkout_completed",
          motebit_id: motebitId,
          subscription_id: subscriptionId,
          customer_id: customerId,
          email,
        };
      }

      case "invoice.paid": {
        const invoice = event.data.object;
        const subscriptionId =
          typeof invoice.subscription === "string"
            ? invoice.subscription
            : (invoice.subscription?.id ?? null);
        if (!subscriptionId) {
          return { kind: "ignored", type: event.type };
        }
        const invoiceId = invoice.id;
        if (!invoiceId) {
          return { kind: "ignored", type: event.type };
        }
        return {
          kind: "invoice_paid",
          subscription_id: subscriptionId,
          invoice_id: invoiceId,
        };
      }

      case "customer.subscription.deleted": {
        const subscription = event.data.object;
        return {
          kind: "subscription_deleted",
          subscription_id: subscription.id,
        };
      }

      default:
        return { kind: "ignored", type: event.type };
    }
  }
}
