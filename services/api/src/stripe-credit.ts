/**
 * Stripe Checkout → virtual account credit bridge.
 *
 * Extracted from `accounts.ts` as medium plumbing — the motebit ledger
 * doesn't know about Stripe sessions, so the mapping between a
 * `checkout.session.completed` event and a ledger credit lives here,
 * alongside the Stripe webhook handler in `subscriptions.ts`.
 */

import type { DatabaseDriver } from "@motebit/persistence";
import { toMicro } from "@motebit/virtual-accounts";
import { sqliteAccountStoreFor } from "./account-store-sqlite.js";
import { createLogger } from "./logger.js";

const logger = createLogger({ service: "stripe-credit" });

/**
 * Process a completed Stripe Checkout session. Credits the agent's
 * virtual account. Idempotent: uses the Stripe session ID as deposit
 * reference, so a replayed webhook returns false without double-crediting.
 *
 * @param amount — in DOLLARS (parsed from Stripe metadata). Converted
 *                  to micro-units internally.
 * @returns true if the deposit was applied, false if already processed.
 */
export function processStripeCheckout(
  db: DatabaseDriver,
  sessionId: string,
  motebitId: string,
  amount: number,
  paymentIntent?: string,
): boolean {
  if (amount <= 0) return false;

  const store = sqliteAccountStoreFor(db);

  // Idempotency: skip if this session was already processed.
  if (store.hasDepositWithReference(motebitId, sessionId)) {
    logger.info("stripe.checkout.idempotent", { motebitId, sessionId });
    return false;
  }

  store.credit(
    motebitId,
    toMicro(amount),
    "deposit",
    sessionId,
    paymentIntent ? `Stripe Checkout: ${paymentIntent}` : `Stripe Checkout: ${sessionId}`,
  );

  logger.info("stripe.checkout.credited", {
    motebitId,
    sessionId,
    amount,
    paymentIntent: paymentIntent ?? null,
  });

  return true;
}
