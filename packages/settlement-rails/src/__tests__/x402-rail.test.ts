/**
 * X402SettlementRail unit tests.
 *
 * Tests the rail adapter with a mocked x402 facilitator — no real API calls.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { X402SettlementRail } from "../x402-rail.js";
import { SettlementRailRegistry, isManualPayoutRail, payoutValidityMsOf } from "../index.js";
import { isDepositableRail, isWithdrawableRail, isBatchableRail } from "@motebit/sdk";
import type { X402FacilitatorClient } from "../x402-rail.js";

// --- Mock x402 facilitator ---

function createMockFacilitator(overrides?: Partial<X402FacilitatorClient>): X402FacilitatorClient {
  return {
    url: "https://x402.org/facilitator",
    getSupported: vi.fn().mockResolvedValue({
      kinds: [{ x402Version: 1, scheme: "exact", network: "eip155:84532" }],
      extensions: [],
      signers: {},
    }),
    settle: vi.fn().mockResolvedValue({
      success: true,
      transaction: "0xabc123def456",
      network: "eip155:84532",
      payer: "0xPayer",
    }),
    ...overrides,
  };
}

describe("X402SettlementRail", () => {
  let facilitator: ReturnType<typeof createMockFacilitator>;
  let rail: X402SettlementRail;

  beforeEach(() => {
    facilitator = createMockFacilitator();
    rail = new X402SettlementRail({
      facilitatorClient: facilitator,
      network: "eip155:84532",
      payToAddress: "0xRelayOperator",
    });
  });

  it("has correct railType and name", () => {
    expect(rail.railType).toBe("protocol");
    expect(rail.name).toBe("x402");
  });

  it("does not support deposit (pay-per-request)", () => {
    expect(rail.supportsDeposit).toBe(false);
  });

  describe("isAvailable", () => {
    it("returns true when facilitator reports supported kinds", async () => {
      const available = await rail.isAvailable();
      expect(available).toBe(true);
      expect(facilitator.getSupported).toHaveBeenCalled();
    });

    it("returns false when facilitator returns empty kinds", async () => {
      (facilitator.getSupported as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        kinds: [],
      });
      const available = await rail.isAvailable();
      expect(available).toBe(false);
    });

    it("returns false when facilitator is unreachable", async () => {
      (facilitator.getSupported as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error("ECONNREFUSED"),
      );
      const available = await rail.isAvailable();
      expect(available).toBe(false);
    });
  });

  // #948: the withdraw this rail carried put the idempotency key where the
  // EIP-3009 signature belongs — no facilitator can execute that. The relay
  // cannot sign one (it holds no EVM treasury key), so the method is removed
  // at the type level, like Bridge's: no relay path can hand x402 a payout.
  describe("withdraw is structurally absent (#948)", () => {
    it("declares supportsWithdraw false and has no withdraw method", () => {
      expect(rail.supportsWithdraw).toBe(false);
      expect(rail.supportsBatch).toBe(false);
      expect((rail as unknown as { withdraw?: unknown }).withdraw).toBeUndefined();
      expect(
        (X402SettlementRail.prototype as unknown as { withdraw?: unknown }).withdraw,
      ).toBeUndefined();
    });

    it("is rejected by the withdrawable and batchable type guards", () => {
      expect(isWithdrawableRail(rail)).toBe(false);
      expect(isBatchableRail(rail)).toBe(false);
    });

    it("declares no payout horizon (it never sends a payout)", () => {
      expect(isManualPayoutRail(rail)).toBe(false);
      expect(payoutValidityMsOf(rail)).toBeNull();
    });

    it("never calls the facilitator's settle", async () => {
      await rail.isAvailable();
      await rail.attachProof("s-1", { reference: "0x1", railType: "protocol", confirmedAt: 1 });
      expect(facilitator.settle).not.toHaveBeenCalled();
    });
  });

  describe("attachProof", () => {
    it("logs the proof attachment without throwing", async () => {
      await expect(
        rail.attachProof("settlement-001", {
          reference: "0xabc123",
          railType: "protocol",
          network: "eip155:84532",
          confirmedAt: Date.now(),
        }),
      ).resolves.toBeUndefined();
    });

    it("calls onProofAttached callback when provided", async () => {
      const onProof = vi.fn();
      const railWithCallback = new X402SettlementRail({
        facilitatorClient: createMockFacilitator(),
        network: "eip155:84532",
        payToAddress: "0xRelay",
        onProofAttached: onProof,
      });

      const proof = {
        reference: "0xdef456",
        railType: "protocol" as const,
        network: "eip155:84532",
        confirmedAt: Date.now(),
      };
      await railWithCallback.attachProof("settle-002", proof);

      expect(onProof).toHaveBeenCalledOnce();
      expect(onProof).toHaveBeenCalledWith("settle-002", proof);
    });

    it("does not throw when onProofAttached is not provided", async () => {
      // Default rail (no callback) — already tested above, but explicit
      await expect(
        rail.attachProof("settle-003", {
          reference: "0x999",
          railType: "protocol",
          confirmedAt: Date.now(),
        }),
      ).resolves.toBeUndefined();
    });
  });
});

describe("SettlementRailRegistry with x402", () => {
  it("registers and retrieves x402 rail by name", () => {
    const registry = new SettlementRailRegistry();
    const rail = new X402SettlementRail({
      facilitatorClient: createMockFacilitator(),
      network: "eip155:84532",
      payToAddress: "0xRelay",
    });

    registry.register(rail);

    expect(registry.get("x402")).toBe(rail);
    expect(registry.getByType("protocol")).toHaveLength(1);
    expect(registry.getByType("protocol")[0]!.name).toBe("x402");
  });

  it("isDepositableRail returns false for x402", () => {
    const rail = new X402SettlementRail({
      facilitatorClient: createMockFacilitator(),
      network: "eip155:84532",
      payToAddress: "0xRelay",
    });
    expect(isDepositableRail(rail)).toBe(false);
  });

  it("isDepositableRail returns true for Stripe", async () => {
    const { StripeSettlementRail } = await import("../stripe-rail.js");
    const stripeRail = new StripeSettlementRail({
      stripeClient: {
        balance: { retrieve: vi.fn().mockResolvedValue({}) },
        checkout: { sessions: { create: vi.fn() } },
        webhooks: { constructEvent: vi.fn() },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      webhookSecret: "whsec_test",
    });
    expect(isDepositableRail(stripeRail)).toBe(true);
  });

  it("coexists with Stripe rail in registry", async () => {
    // Importing StripeSettlementRail to verify multi-rail coexistence
    const { StripeSettlementRail } = await import("../stripe-rail.js");

    const registry = new SettlementRailRegistry();

    const stripeRail = new StripeSettlementRail({
      stripeClient: {
        balance: { retrieve: vi.fn().mockResolvedValue({}) },
        checkout: { sessions: { create: vi.fn() } },
        webhooks: { constructEvent: vi.fn() },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      webhookSecret: "whsec_test",
    });

    const x402Rail = new X402SettlementRail({
      facilitatorClient: createMockFacilitator(),
      network: "eip155:84532",
      payToAddress: "0xRelay",
    });

    registry.register(stripeRail);
    registry.register(x402Rail);

    expect(registry.list()).toHaveLength(2);
    expect(registry.getByType("fiat")).toHaveLength(1);
    expect(registry.getByType("protocol")).toHaveLength(1);
    expect(registry.get("stripe")!.railType).toBe("fiat");
    expect(registry.get("x402")!.railType).toBe("protocol");
  });
});
