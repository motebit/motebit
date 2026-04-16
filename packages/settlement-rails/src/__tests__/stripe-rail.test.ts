/**
 * StripeSettlementRail unit tests.
 *
 * Tests the rail adapter with a mocked Stripe SDK — no real API calls.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { StripeSettlementRail } from "../stripe-rail.js";
import { SettlementRailRegistry } from "../index.js";

// --- Mock Stripe SDK ---

function createMockStripe() {
  return {
    balance: {
      retrieve: vi.fn().mockResolvedValue({ available: [{ amount: 1000 }] }),
    },
    checkout: {
      sessions: {
        create: vi.fn().mockResolvedValue({
          id: "cs_test_mock_session",
          url: "https://checkout.stripe.com/pay/cs_test_mock_session",
        }),
      },
    },
    webhooks: {
      constructEvent: vi.fn().mockReturnValue({
        id: "evt_test_123",
        type: "checkout.session.completed",
        data: {
          object: {
            id: "cs_test_mock_session",
            metadata: { motebit_id: "agent-001", amount: "25.00" },
            payment_intent: "pi_test_xyz",
          },
        },
      }),
    },
  };
}

describe("StripeSettlementRail", () => {
  let mockStripe: ReturnType<typeof createMockStripe>;
  let rail: StripeSettlementRail;

  beforeEach(() => {
    mockStripe = createMockStripe();
    rail = new StripeSettlementRail({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      stripeClient: mockStripe as any,
      webhookSecret: "whsec_test_secret",
      currency: "usd",
    });
  });

  it("has correct railType and name", () => {
    expect(rail.railType).toBe("fiat");
    expect(rail.name).toBe("stripe");
    expect(rail.supportsDeposit).toBe(true);
  });

  describe("isAvailable", () => {
    it("returns true when Stripe API is reachable", async () => {
      const available = await rail.isAvailable();
      expect(available).toBe(true);
      expect(mockStripe.balance.retrieve).toHaveBeenCalled();
    });

    it("returns false when Stripe API is unreachable", async () => {
      mockStripe.balance.retrieve.mockRejectedValueOnce(new Error("API key invalid"));
      const available = await rail.isAvailable();
      expect(available).toBe(false);
    });
  });

  describe("deposit", () => {
    it("creates a Stripe Checkout session and returns redirectUrl", async () => {
      const result = await rail.deposit("agent-001", 25.0, "usd", "idem-key-1");

      expect("redirectUrl" in result).toBe(true);
      if ("redirectUrl" in result) {
        expect(result.redirectUrl).toBe("https://checkout.stripe.com/pay/cs_test_mock_session");
      }

      expect(mockStripe.checkout.sessions.create).toHaveBeenCalledWith(
        expect.objectContaining({
          mode: "payment",
          payment_method_types: ["card"],
          line_items: [
            expect.objectContaining({
              price_data: expect.objectContaining({
                currency: "usd",
                unit_amount: 2500, // $25 in cents
              }),
              quantity: 1,
            }),
          ],
          metadata: { motebit_id: "agent-001", amount: "25" },
        }),
        { idempotencyKey: "idem-key-1" },
      );
    });

    it("uses caller-provided returnUrl for success/cancel when supplied", async () => {
      await rail.deposit("agent-002", 10.0, "usd", "idem-key-2", "https://app.example.com/billing");

      expect(mockStripe.checkout.sessions.create).toHaveBeenCalledWith(
        expect.objectContaining({
          success_url: "https://app.example.com/billing",
          cancel_url: "https://app.example.com/billing",
        }),
        expect.anything(),
      );
    });

    it("defaults to https://motebit.com when returnUrl is omitted", async () => {
      await rail.deposit("agent-002b", 10.0, "usd", "idem-key-2b");

      expect(mockStripe.checkout.sessions.create).toHaveBeenCalledWith(
        expect.objectContaining({
          success_url: "https://motebit.com",
          cancel_url: "https://motebit.com",
        }),
        expect.anything(),
      );
    });

    it("rejects zero or negative amounts", async () => {
      await expect(rail.deposit("agent-003", 0, "usd", "k1")).rejects.toThrow(
        "Deposit amount must be positive",
      );
      await expect(rail.deposit("agent-003", -5, "usd", "k2")).rejects.toThrow(
        "Deposit amount must be positive",
      );
    });

    it("rejects amounts below $0.50 minimum", async () => {
      await expect(rail.deposit("agent-003", 0.25, "usd", "k3")).rejects.toThrow(
        "Minimum deposit amount is $0.50",
      );
    });

    it("handles empty checkout URL gracefully", async () => {
      mockStripe.checkout.sessions.create.mockResolvedValueOnce({
        id: "cs_test_no_url",
        url: null,
      });
      const result = await rail.deposit("agent-004", 5.0, "usd", "idem-key-4");
      expect("redirectUrl" in result).toBe(true);
      if ("redirectUrl" in result) {
        expect(result.redirectUrl).toBe("");
      }
    });
  });

  describe("withdraw", () => {
    it("returns a pending withdrawal result", async () => {
      const result = await rail.withdraw("agent-001", 10.0, "USD", "pending", "idem-key-w1");

      expect(result.amount).toBe(10.0);
      expect(result.currency).toBe("USD");
      expect(result.proof.railType).toBe("fiat");
      expect(result.proof.network).toBe("stripe");
      expect(result.proof.confirmedAt).toBe(0); // Not confirmed yet
      expect(result.proof.reference).toMatch(/^pending:agent-001:/);
    });
  });

  describe("attachProof", () => {
    it("logs the proof attachment without throwing", async () => {
      await expect(
        rail.attachProof("settlement-001", {
          reference: "pi_test_xyz",
          railType: "fiat",
          network: "stripe",
          confirmedAt: Date.now(),
        }),
      ).resolves.toBeUndefined();
    });

    it("calls onProofAttached callback when provided", async () => {
      const onProof = vi.fn();
      const railWithCallback = new StripeSettlementRail({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        stripeClient: mockStripe as any,
        webhookSecret: "whsec_test_secret",
        onProofAttached: onProof,
      });

      const proof = {
        reference: "pi_test_abc",
        railType: "fiat" as const,
        network: "stripe",
        confirmedAt: Date.now(),
      };
      await railWithCallback.attachProof("settle-stripe-001", proof);

      expect(onProof).toHaveBeenCalledOnce();
      expect(onProof).toHaveBeenCalledWith("settle-stripe-001", proof);
    });
  });

  describe("constructWebhookEvent", () => {
    it("delegates to Stripe SDK for webhook verification", () => {
      const event = rail.constructWebhookEvent("raw-body", "sig-header");

      expect(mockStripe.webhooks.constructEvent).toHaveBeenCalledWith(
        "raw-body",
        "sig-header",
        "whsec_test_secret",
      );
      expect(event.type).toBe("checkout.session.completed");
    });

    it("throws when signature is invalid", () => {
      mockStripe.webhooks.constructEvent.mockImplementationOnce(() => {
        throw new Error("Invalid signature");
      });
      expect(() => rail.constructWebhookEvent("bad-body", "bad-sig")).toThrow("Invalid signature");
    });
  });

  describe("logger injection", () => {
    it("emits events to the injected logger", async () => {
      const events: Array<{ event: string; data?: Record<string, unknown> }> = [];
      const railWithLogger = new StripeSettlementRail({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        stripeClient: mockStripe as any,
        webhookSecret: "whsec_test",
        logger: {
          info: (event, data) => events.push({ event, data }),
          warn: () => {},
          error: () => {},
        },
      });

      await railWithLogger.deposit("agent-001", 25.0, "usd", "idem-log-1");
      expect(events.some((e) => e.event === "stripe.checkout.created")).toBe(true);
    });

    it("is silent when no logger is injected", async () => {
      const spy = vi.spyOn(console, "log");
      await rail.deposit("agent-001", 25.0, "usd", "idem-silent");
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });
  });
});

describe("SettlementRailRegistry", () => {
  it("registers and retrieves rails by name", () => {
    const registry = new SettlementRailRegistry();
    const mockStripe = createMockStripe();
    const rail = new StripeSettlementRail({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      stripeClient: mockStripe as any,
      webhookSecret: "whsec_test",
    });

    registry.register(rail);

    expect(registry.get("stripe")).toBe(rail);
    expect(registry.get("nonexistent")).toBeUndefined();
  });

  it("lists all registered rails", () => {
    const registry = new SettlementRailRegistry();
    const mockStripe = createMockStripe();
    const rail = new StripeSettlementRail({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      stripeClient: mockStripe as any,
      webhookSecret: "whsec_test",
    });

    expect(registry.list()).toHaveLength(0);
    registry.register(rail);
    expect(registry.list()).toHaveLength(1);
    expect(registry.list()[0]!.name).toBe("stripe");
  });

  it("filters rails by type", () => {
    const registry = new SettlementRailRegistry();
    const mockStripe = createMockStripe();
    const rail = new StripeSettlementRail({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      stripeClient: mockStripe as any,
      webhookSecret: "whsec_test",
    });

    registry.register(rail);

    expect(registry.getByType("fiat")).toHaveLength(1);
    expect(registry.getByType("protocol")).toHaveLength(0);
    expect(registry.getByType("orchestration")).toHaveLength(0);
  });

  it("replaces existing rail with same name", () => {
    const registry = new SettlementRailRegistry();
    const mockStripe1 = createMockStripe();
    const mockStripe2 = createMockStripe();
    const rail1 = new StripeSettlementRail({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      stripeClient: mockStripe1 as any,
      webhookSecret: "whsec_1",
    });
    const rail2 = new StripeSettlementRail({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      stripeClient: mockStripe2 as any,
      webhookSecret: "whsec_2",
    });

    registry.register(rail1);
    registry.register(rail2);

    expect(registry.list()).toHaveLength(1);
    expect(registry.get("stripe")).toBe(rail2);
  });

  it("manifest describes registered rails as relay-custody", () => {
    const registry = new SettlementRailRegistry();
    const mockStripe = createMockStripe();
    registry.register(
      new StripeSettlementRail({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        stripeClient: mockStripe as any,
        webhookSecret: "whsec_test",
      }),
    );
    const manifest = registry.manifest();
    expect(manifest).toHaveLength(1);
    expect(manifest[0]).toEqual({
      name: "stripe",
      custody: "relay",
      railType: "fiat",
      supportsDeposit: true,
    });
  });
});
