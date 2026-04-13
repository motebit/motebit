/**
 * Custody boundary — the type-level expression of the sovereignty doctrine.
 *
 * The relay's `SettlementRailRegistry` accepts only `GuestRail` (relay-custody
 * rails like Stripe, x402, Bridge). `SovereignRail` implementations (agent-custody
 * rails like `SolanaWalletRail`) must not be registerable at the relay — the
 * compiler rejects the attempt.
 *
 * This file tests both sides:
 *   1. Positive: every registered rail has custody="relay".
 *   2. Negative: a @ts-expect-error assertion proves the compiler refuses a
 *      SovereignRail argument to registry.register(). If someone widens the
 *      registry to accept any SettlementRail, this file stops compiling —
 *      which is the whole point.
 *
 * Doctrine: "relay is a convenience layer, not a trust root" is now mechanical.
 */
import { describe, it, expect } from "vitest";
import type { SovereignRail } from "@motebit/sdk";
import {
  SettlementRailRegistry,
  StripeSettlementRail,
  X402SettlementRail,
  BridgeSettlementRail,
} from "../settlement-rails/index.js";

describe("custody boundary", () => {
  it("every GuestRail implementation declares custody='relay'", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stripe = new StripeSettlementRail({
      stripeClient: { balance: { retrieve: async () => ({}) } } as any,
      webhookSecret: "whsec_test",
    });
    const x402 = new X402SettlementRail({
      facilitatorClient: {
        url: "https://example",
        getSupported: async () => ({ kinds: [] }),
        settle: async () => ({ success: true, transaction: "0x", network: "eip155:8453" }),
      },
      network: "eip155:8453",
      payToAddress: "0x0000000000000000000000000000000000000000",
    });
    const bridge = new BridgeSettlementRail({
      bridgeClient: {
        createTransfer: async () => ({ id: "t", state: "awaiting_funds", amount: "0" }),
        getTransfer: async () => ({ id: "t", state: "payment_processed", amount: "0" }),
        isReachable: async () => true,
      },
      customerId: "cust_test",
      sourcePaymentRail: "base",
      sourceCurrency: "usdc",
    });

    expect(stripe.custody).toBe("relay");
    expect(x402.custody).toBe("relay");
    expect(bridge.custody).toBe("relay");
  });

  it("registry refuses a sovereign rail at the type level", () => {
    const registry = new SettlementRailRegistry();

    // Construct a minimal SovereignRail (no actual Solana import needed —
    // we're testing the type boundary, not the behavior).
    const sovereign: SovereignRail = {
      custody: "agent",
      name: "solana-wallet",
      chain: "solana",
      asset: "USDC",
      address: "11111111111111111111111111111111",
      getBalance: async () => 0n,
      isAvailable: async () => true,
    };

    // @ts-expect-error — SovereignRail is not assignable to GuestRail.
    // If this line compiles, the custody boundary is broken: the registry
    // has been widened to accept any rail, which violates the sovereignty
    // doctrine. Do not silence this error — fix the type.
    registry.register(sovereign);

    // Runtime: even though we bypassed the type system, the rail has
    // custody="agent", which is observable and auditable.
    expect(sovereign.custody).toBe("agent");
  });
});
