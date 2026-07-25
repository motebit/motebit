/**
 * Unit tests for subscriptionPeriodEndMs — the pure extractor for a Stripe
 * subscription's current period end under the 2025-03-31.basil shape.
 *
 * This proves the basil field-location contract (current_period_end lives on
 * items, not the Subscription object) that the /cancel route depends on. The
 * route handler itself only has non-Stripe-path coverage (no Stripe mock
 * harness in subscription-lifecycle.test.ts), so the field access is proven
 * here instead. See the latent-bug fix in the stripe 17→22 bump (#394): under
 * the pre-basil read, cancel always persisted a null period end.
 */
import { describe, it, expect } from "vitest";
import type Stripe from "stripe";

import { subscriptionPeriodEndMs } from "../subscriptions.js";

/** Minimal basil-shaped Subscription with a single item's period end. */
function subWithItemPeriodEnd(sec: number | undefined): Stripe.Subscription {
  return {
    items: { data: sec === undefined ? [] : [{ current_period_end: sec }] },
  } as unknown as Stripe.Subscription;
}

describe("subscriptionPeriodEndMs", () => {
  it("reads current_period_end from the first item and converts s → ms", () => {
    // 2026-07-01T00:00:00Z in epoch seconds.
    const sec = Math.floor(Date.UTC(2026, 6, 1) / 1000);
    expect(subscriptionPeriodEndMs(subWithItemPeriodEnd(sec))).toBe(sec * 1000);
  });

  it("returns null when the subscription has no items (nothing to read)", () => {
    expect(subscriptionPeriodEndMs(subWithItemPeriodEnd(undefined))).toBeNull();
  });

  it("returns null when the item's current_period_end is not a number", () => {
    const sub = {
      items: { data: [{ current_period_end: undefined }] },
    } as unknown as Stripe.Subscription;
    expect(subscriptionPeriodEndMs(sub)).toBeNull();
  });

  it("regression: the pre-basil top-level field is NOT consulted", () => {
    // A subscription carrying the OLD top-level current_period_end but an empty
    // items array must read as null — proving we do not fall back to the
    // removed field (the exact shape that masked the latent cancel bug).
    const sub = {
      current_period_end: 1_800_000_000,
      items: { data: [] },
    } as unknown as Stripe.Subscription;
    expect(subscriptionPeriodEndMs(sub)).toBeNull();
  });
});
