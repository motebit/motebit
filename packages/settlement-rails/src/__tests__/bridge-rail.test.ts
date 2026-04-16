/**
 * BridgeSettlementRail unit tests.
 *
 * Tests the rail adapter with a mocked Bridge client — no real API calls.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { BridgeSettlementRail } from "../bridge-rail.js";
import { SettlementRailRegistry } from "../index.js";
import { isDepositableRail } from "@motebit/sdk";
import type { BridgeClient, BridgeTransfer } from "../bridge-rail.js";

// --- Mock Bridge client ---

function createMockBridgeClient(overrides?: Partial<BridgeClient>): BridgeClient {
  const defaultTransfer: BridgeTransfer = {
    id: "bridge-transfer-001",
    state: "awaiting_funds",
    amount: "5.000000",
    receipt: {},
    source: { paymentRail: "base" },
    destination: { paymentRail: "base" },
  };

  return {
    createTransfer: vi.fn().mockResolvedValue(defaultTransfer),
    getTransfer: vi.fn().mockResolvedValue(defaultTransfer),
    isReachable: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
}

function completedTransfer(transferId = "bridge-transfer-001"): BridgeTransfer {
  return {
    id: transferId,
    state: "payment_processed",
    amount: "5.000000",
    receipt: {
      sourceTxHash: "0xsource123",
      destinationTxHash: "0xdest456",
    },
    source: { paymentRail: "base" },
    destination: { paymentRail: "base" },
  };
}

describe("BridgeSettlementRail", () => {
  let client: ReturnType<typeof createMockBridgeClient>;
  let rail: BridgeSettlementRail;

  beforeEach(() => {
    client = createMockBridgeClient();
    rail = new BridgeSettlementRail({
      bridgeClient: client,
      customerId: "cust-001",
      sourcePaymentRail: "base",
      sourceCurrency: "usdc",
      maxPollAttempts: 3,
      pollIntervalMs: 10, // fast for tests
    });
  });

  it("has correct railType and name", () => {
    expect(rail.railType).toBe("orchestration");
    expect(rail.name).toBe("bridge");
    expect(rail.supportsDeposit).toBe(false);
  });

  it("is not depositable", () => {
    expect(isDepositableRail(rail)).toBe(false);
  });

  describe("isAvailable", () => {
    it("returns true when Bridge API is reachable", async () => {
      expect(await rail.isAvailable()).toBe(true);
      expect(client.isReachable).toHaveBeenCalled();
    });

    it("returns false when Bridge API is unreachable", async () => {
      (client.isReachable as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false);
      expect(await rail.isAvailable()).toBe(false);
    });

    it("returns false on network error", async () => {
      (client.isReachable as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error("ECONNREFUSED"),
      );
      expect(await rail.isAvailable()).toBe(false);
    });
  });

  describe("withdraw — crypto→crypto (instant path)", () => {
    it("creates transfer and polls for completion", async () => {
      // getTransfer returns completed on first poll
      (client.getTransfer as ReturnType<typeof vi.fn>).mockResolvedValue(completedTransfer());

      const result = await rail.withdraw(
        "agent-001",
        5.0,
        "USDC",
        "0x1234567890abcdef1234567890abcdef12345678",
        "idem-key-1",
      );

      expect(result.amount).toBe(5.0);
      expect(result.currency).toBe("USDC");
      expect(result.proof.reference).toBe("0xdest456");
      expect(result.proof.railType).toBe("orchestration");
      expect(result.proof.network).toBe("base");
      expect(result.proof.confirmedAt).toBeGreaterThan(0);

      expect(client.createTransfer).toHaveBeenCalledWith(
        expect.objectContaining({
          onBehalfOf: "cust-001",
          amount: "5.000000",
          sourceCurrency: "usdc",
          sourcePaymentRail: "base",
          destinationCurrency: "usdc",
          destinationPaymentRail: "base",
          destinationAddress: "0x1234567890abcdef1234567890abcdef12345678",
          idempotencyKey: "idem-key-1",
        }),
      );
    });

    it("falls back to pending when poll times out", async () => {
      // getTransfer always returns awaiting_funds — never completes
      const result = await rail.withdraw(
        "agent-001",
        5.0,
        "USDC",
        "0x1234567890abcdef1234567890abcdef12345678",
        "idem-key-2",
      );

      expect(result.proof.reference).toBe("bridge:bridge-transfer-001");
      expect(result.proof.confirmedAt).toBe(0); // Pending
      expect(result.proof.railType).toBe("orchestration");

      // Polled maxPollAttempts times
      expect(client.getTransfer).toHaveBeenCalledTimes(3);
    });

    it("throws when transfer enters terminal failure state", async () => {
      (client.getTransfer as ReturnType<typeof vi.fn>).mockResolvedValue({
        ...completedTransfer(),
        state: "error",
      });

      await expect(
        rail.withdraw(
          "agent-001",
          5.0,
          "USDC",
          "0x1234567890abcdef1234567890abcdef12345678",
          "idem-key-3",
        ),
      ).rejects.toThrow("Bridge transfer bridge-transfer-001 failed: error");
    });
  });

  describe("withdraw — fiat destination (async path)", () => {
    it("creates transfer and returns pending immediately", async () => {
      const result = await rail.withdraw(
        "agent-001",
        100.0,
        "USD",
        "ext-account-001",
        "idem-key-fiat-1",
      );

      expect(result.amount).toBe(100.0);
      expect(result.proof.reference).toBe("bridge:bridge-transfer-001");
      expect(result.proof.railType).toBe("orchestration");
      expect(result.proof.confirmedAt).toBe(0); // Pending — webhook completes

      // Should NOT have polled (fiat destination skips polling)
      expect(client.getTransfer).not.toHaveBeenCalled();

      expect(client.createTransfer).toHaveBeenCalledWith(
        expect.objectContaining({
          destinationCurrency: "usd",
          destinationPaymentRail: "wire",
          externalAccountId: "ext-account-001",
        }),
      );
    });
  });

  describe("withdraw — validation", () => {
    it("rejects zero or negative amounts", async () => {
      await expect(
        rail.withdraw("agent-001", 0, "USDC", "0x1234567890abcdef1234567890abcdef12345678", "k1"),
      ).rejects.toThrow("Withdrawal amount must be positive");
    });

    it("rejects empty destination", async () => {
      await expect(rail.withdraw("agent-001", 5.0, "USDC", "", "k2")).rejects.toThrow(
        "Destination is required",
      );
    });

    it("propagates Bridge API errors (fail-closed)", async () => {
      (client.createTransfer as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("Bridge API: 401 Unauthorized"),
      );

      await expect(rail.withdraw("agent-001", 5.0, "USDC", "ext-acct", "k3")).rejects.toThrow(
        "Bridge API: 401 Unauthorized",
      );
    });
  });

  describe("attachProof", () => {
    it("logs without throwing", async () => {
      await expect(
        rail.attachProof("settle-001", {
          reference: "0xdest456",
          railType: "orchestration",
          network: "base",
          confirmedAt: Date.now(),
        }),
      ).resolves.toBeUndefined();
    });

    it("calls onProofAttached callback when provided", async () => {
      const onProof = vi.fn();
      const railWithCallback = new BridgeSettlementRail({
        bridgeClient: client,
        customerId: "cust-001",
        sourcePaymentRail: "base",
        sourceCurrency: "usdc",
        onProofAttached: onProof,
      });

      const proof = {
        reference: "0xdest456",
        railType: "orchestration" as const,
        network: "base",
        confirmedAt: Date.now(),
      };
      await railWithCallback.attachProof("settle-002", proof);

      expect(onProof).toHaveBeenCalledOnce();
      expect(onProof).toHaveBeenCalledWith("settle-002", proof);
    });
  });
});

describe("SettlementRailRegistry with Bridge", () => {
  it("registers and retrieves Bridge rail", () => {
    const registry = new SettlementRailRegistry();
    const rail = new BridgeSettlementRail({
      bridgeClient: createMockBridgeClient(),
      customerId: "cust-001",
      sourcePaymentRail: "base",
      sourceCurrency: "usdc",
    });

    registry.register(rail);

    expect(registry.get("bridge")).toBe(rail);
    expect(registry.getByType("orchestration")).toHaveLength(1);
    expect(registry.getByType("orchestration")[0]!.name).toBe("bridge");
  });

  it("coexists with Stripe and x402 rails", async () => {
    const { StripeSettlementRail } = await import("../stripe-rail.js");
    const { X402SettlementRail } = await import("../x402-rail.js");

    const registry = new SettlementRailRegistry();

    registry.register(
      new StripeSettlementRail({
        stripeClient: {
          balance: { retrieve: vi.fn().mockResolvedValue({}) },
          checkout: { sessions: { create: vi.fn() } },
          webhooks: { constructEvent: vi.fn() },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
        webhookSecret: "whsec_test",
      }),
    );

    registry.register(
      new X402SettlementRail({
        facilitatorClient: {
          url: "https://x402.org/facilitator",
          getSupported: vi.fn().mockResolvedValue({ kinds: [] }),
          settle: vi.fn(),
        },
        network: "eip155:84532",
        payToAddress: "0xRelay",
      }),
    );

    registry.register(
      new BridgeSettlementRail({
        bridgeClient: createMockBridgeClient(),
        customerId: "cust-001",
        sourcePaymentRail: "base",
        sourceCurrency: "usdc",
      }),
    );

    expect(registry.list()).toHaveLength(3);
    expect(registry.getByType("fiat")).toHaveLength(1);
    expect(registry.getByType("protocol")).toHaveLength(1);
    expect(registry.getByType("orchestration")).toHaveLength(1);
  });
});
