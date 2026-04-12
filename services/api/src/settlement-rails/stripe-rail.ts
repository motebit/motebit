/**
 * StripeSettlementRail — Stripe Checkout as a SettlementRail adapter.
 *
 * Wraps Stripe's Checkout Session API behind the SettlementRail interface.
 * Deposits create interactive Checkout sessions (redirect flow).
 * Withdrawals are manual (admin-completed) — the rail records intent.
 */

import type Stripe from "stripe";
import type {
  DepositableSettlementRail,
  PaymentProof,
  DepositResult,
  WithdrawalResult,
} from "@motebit/sdk";
import { createLogger } from "../logger.js";

const logger = createLogger({ service: "stripe-rail" });

export interface StripeRailConfig {
  /** Stripe SDK instance (pre-configured with secret key). */
  stripeClient: Stripe;
  /** Webhook signing secret for signature verification. */
  webhookSecret: string;
  /** Currency code for checkout sessions. Default: "usd". */
  currency?: string;
  /** Callback to persist proof. Injected by relay — the rail does not own storage. */
  onProofAttached?: (settlementId: string, proof: PaymentProof) => void;
}

export class StripeSettlementRail implements DepositableSettlementRail {
  readonly railType = "fiat" as const;
  readonly name = "stripe";
  readonly supportsDeposit = true as const;

  private readonly stripe: Stripe;
  readonly webhookSecret: string;
  private readonly currency: string;
  private readonly onProofAttached?: (settlementId: string, proof: PaymentProof) => void;

  constructor(config: StripeRailConfig) {
    this.stripe = config.stripeClient;
    this.webhookSecret = config.webhookSecret;
    this.currency = config.currency ?? "usd";
    this.onProofAttached = config.onProofAttached;
  }

  async isAvailable(): Promise<boolean> {
    try {
      // Light API call to verify credentials are valid
      await this.stripe.balance.retrieve();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Create a Stripe Checkout session for deposit.
   * Returns a redirect URL (interactive flow) — the actual credit happens
   * asynchronously via the webhook when checkout.session.completed fires.
   */
  async deposit(
    motebitId: string,
    amount: number,
    currency: string,
    idempotencyKey: string,
    /**
     * Optional client-provided URL to redirect to after checkout completes.
     * When omitted, falls back to the public canonical web app so users
     * never land on a raw JSON response from the relay.
     */
    returnUrl?: string,
  ): Promise<DepositResult | { redirectUrl: string }> {
    if (amount <= 0) {
      throw new Error("Deposit amount must be positive");
    }
    if (amount < 0.5) {
      throw new Error("Minimum deposit amount is $0.50");
    }

    const successUrl = returnUrl ?? "https://motebit.com";
    const cancelUrl = returnUrl ?? "https://motebit.com";

    const session = await this.stripe.checkout.sessions.create(
      {
        mode: "payment",
        payment_method_types: ["card"],
        line_items: [
          {
            price_data: {
              currency: currency || this.currency,
              product_data: {
                name: `Motebit Agent Deposit (${motebitId.slice(0, 8)}...)`,
              },
              unit_amount: Math.round(amount * 100), // Stripe uses cents
            },
            quantity: 1,
          },
        ],
        metadata: { motebit_id: motebitId, amount: String(amount) },
        success_url: successUrl,
        cancel_url: cancelUrl,
      },
      { idempotencyKey },
    );

    logger.info("stripe.checkout.created", {
      motebitId,
      sessionId: session.id,
      amount,
    });

    return { redirectUrl: session.url ?? "" };
  }

  /**
   * Withdrawals are admin-completed (manual payout).
   * The rail records the intent and returns a pending result.
   */
  withdraw(
    motebitId: string,
    amount: number,
    currency: string,
    destination: string,
    _idempotencyKey: string,
  ): Promise<WithdrawalResult> {
    // Stripe withdrawals are manual — the admin completes them via the admin panel.
    // The rail returns a pending proof that will be updated when the admin completes.
    logger.info("stripe.withdrawal.pending", {
      motebitId,
      amount,
      currency,
      destination,
    });

    return Promise.resolve({
      amount,
      currency,
      proof: {
        reference: `pending:${motebitId}:${Date.now()}`,
        railType: "fiat",
        network: "stripe",
        confirmedAt: 0, // Not confirmed yet — admin must complete
      },
    });
  }

  /**
   * Attach a payment proof (e.g., Stripe charge/session ID) to a settlement record.
   * Called from the webhook handler after checkout.session.completed.
   */
  attachProof(settlementId: string, proof: PaymentProof): Promise<void> {
    logger.info("stripe.proof.attached", {
      settlementId,
      reference: proof.reference,
      railType: proof.railType,
    });
    this.onProofAttached?.(settlementId, proof);
    return Promise.resolve();
  }

  /**
   * Verify a Stripe webhook signature and parse the event.
   * This is Stripe-specific and not part of the SettlementRail interface,
   * but exposed for the webhook route handler.
   */
  constructWebhookEvent(rawBody: string, signature: string): Stripe.Event {
    return this.stripe.webhooks.constructEvent(rawBody, signature, this.webhookSecret);
  }
}
