/**
 * Stripe Checkout → virtual account credit bridge.
 *
 * Extracted from `accounts.ts` as medium plumbing — the motebit ledger
 * doesn't know about Stripe sessions, so the mapping between a
 * `checkout.session.completed` event and a ledger credit lives here,
 * alongside the Stripe webhook handler in `subscriptions.ts`.
 */

import type { DatabaseDriver } from "@motebit/persistence";
import { parsePositiveMicro } from "@motebit/protocol";
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
  // Validate the converted value: a sub-micro or non-finite amount would
  // write a 0-micro (or corrupt) deposit row.
  const amountMicro = parsePositiveMicro(amount);
  if (amountMicro === null) return false;

  const store = sqliteAccountStoreFor(db);

  // Idempotency: skip if this session was already processed. The check and
  // the credit are ONE transaction, so the dedup reads exactly what committed:
  // a credit whose ledger row failed rolled its balance back with it, and a
  // replay credits once.
  const applied = db.transaction(() => {
    if (store.hasDepositWithReference(motebitId, sessionId)) return false;
    store.credit(
      motebitId,
      amountMicro,
      "deposit",
      sessionId,
      paymentIntent ? `Stripe Checkout: ${paymentIntent}` : `Stripe Checkout: ${sessionId}`,
    );
    return true;
  });
  if (!applied) {
    logger.info("stripe.checkout.idempotent", { motebitId, sessionId });
    return false;
  }

  logger.info("stripe.checkout.credited", {
    motebitId,
    sessionId,
    amount,
    paymentIntent: paymentIntent ?? null,
  });

  return true;
}
