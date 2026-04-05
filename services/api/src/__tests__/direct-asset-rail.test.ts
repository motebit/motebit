/**
 * DirectAssetRail unit tests.
 *
 * Tests the rail adapter with a mock wallet provider — no real chain interactions.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { DirectAssetRail } from "../settlement-rails/direct-asset-rail.js";
import { SettlementRailRegistry } from "../settlement-rails/index.js";
import { isDepositableRail } from "@motebit/sdk";
import type { WalletProvider } from "../settlement-rails/direct-asset-rail.js";

// --- Mock wallet provider ---

function createMockWallet(overrides?: Partial<WalletProvider>): WalletProvider {
  return {
    getAddress: vi.fn().mockResolvedValue("0xAgentWallet1234567890abcdef12345678"),
    getBalance: vi.fn().mockResolvedValue(BigInt(100_000_000)), // 100 USDC (6 decimals)
    sendTransfer: vi.fn().mockResolvedValue({ txHash: "0xtx_abc123def456" }),
    ...overrides,
  };
}

describe("DirectAssetRail", () => {
  let wallet: ReturnType<typeof createMockWallet>;
  let rail: DirectAssetRail;

  beforeEach(() => {
    wallet = createMockWallet();
    rail = new DirectAssetRail({
      walletProvider: wallet,
      chain: "eip155:8453",
      asset: "USDC",
      decimals: 6,
    });
  });

  it("has correct railType and name", () => {
    expect(rail.railType).toBe("direct_asset");
    expect(rail.name).toBe("direct-asset");
    expect(rail.supportsDeposit).toBe(true);
  });

  it("is depositable", () => {
    expect(isDepositableRail(rail)).toBe(true);
  });

  describe("isAvailable", () => {
    it("returns true when wallet provider is functional", async () => {
      expect(await rail.isAvailable()).toBe(true);
      expect(wallet.getAddress).toHaveBeenCalledWith("__health_check__", "eip155:8453");
    });

    it("returns false when wallet provider throws", async () => {
      (wallet.getAddress as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error("provider unreachable"),
      );
      expect(await rail.isAvailable()).toBe(false);
    });
  });

  describe("deposit", () => {
    it("returns agent wallet address as deposit instructions", async () => {
      const result = await rail.deposit("agent-001", 50.0, "USDC", "idem-1");

      expect("amount" in result).toBe(true);
      if ("amount" in result && !("redirectUrl" in result)) {
        expect(result.amount).toBe(50.0);
        expect(result.proof.reference).toBe(
          "deposit-address:0xAgentWallet1234567890abcdef12345678",
        );
        expect(result.proof.railType).toBe("direct_asset");
        expect(result.proof.network).toBe("eip155:8453");
        expect(result.proof.confirmedAt).toBe(0); // Not confirmed until tokens arrive
      }

      expect(wallet.getAddress).toHaveBeenCalledWith("agent-001", "eip155:8453");
    });
  });

  describe("withdraw", () => {
    it("signs and broadcasts transfer, returns tx hash proof", async () => {
      const result = await rail.withdraw(
        "agent-001",
        5.0,
        "USDC",
        "0xDestination1234567890abcdef12345678",
        "idem-w1",
      );

      expect(result.amount).toBe(5.0);
      expect(result.currency).toBe("USDC");
      expect(result.proof.reference).toBe("0xtx_abc123def456");
      expect(result.proof.railType).toBe("direct_asset");
      expect(result.proof.network).toBe("eip155:8453");
      expect(result.proof.confirmedAt).toBeGreaterThan(0);

      expect(wallet.sendTransfer).toHaveBeenCalledWith({
        agentId: "agent-001",
        chain: "eip155:8453",
        to: "0xDestination1234567890abcdef12345678",
        asset: "USDC",
        amount: BigInt(5_000_000), // 5.0 * 10^6
        idempotencyKey: "idem-w1",
      });
    });

    it("checks balance before signing", async () => {
      // Balance is 100 USDC, withdraw 50 — should succeed
      await rail.withdraw("agent-001", 50.0, "USDC", "0xDest1234567890abcdef1234567890ab", "k1");
      expect(wallet.getBalance).toHaveBeenCalledWith("agent-001", "eip155:8453", "USDC");
      expect(wallet.sendTransfer).toHaveBeenCalled();
    });

    it("throws on insufficient onchain balance", async () => {
      (wallet.getBalance as ReturnType<typeof vi.fn>).mockResolvedValueOnce(BigInt(1_000_000)); // 1 USDC

      await expect(
        rail.withdraw("agent-001", 50.0, "USDC", "0xDest1234567890abcdef1234567890ab", "k2"),
      ).rejects.toThrow("Insufficient onchain balance");
    });

    it("converts amount to token decimals correctly", async () => {
      await rail.withdraw("agent-001", 0.01, "USDC", "0xDest1234567890abcdef1234567890ab", "k3");

      expect(wallet.sendTransfer).toHaveBeenCalledWith(
        expect.objectContaining({
          amount: BigInt(10_000), // 0.01 * 10^6
        }),
      );
    });

    it("uses configurable decimals", async () => {
      const rail18 = new DirectAssetRail({
        walletProvider: wallet,
        chain: "eip155:1",
        asset: "DAI",
        decimals: 18,
      });

      // Need high balance for 18 decimal token
      (wallet.getBalance as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        BigInt("1000000000000000000000"), // 1000 DAI
      );

      await rail18.withdraw("agent-001", 1.0, "DAI", "0xDest1234567890abcdef1234567890ab", "k4");

      expect(wallet.sendTransfer).toHaveBeenCalledWith(
        expect.objectContaining({
          amount: BigInt("1000000000000000000"), // 1.0 * 10^18
        }),
      );
    });

    it("rejects zero or negative amounts", async () => {
      await expect(
        rail.withdraw("agent-001", 0, "USDC", "0xDest1234567890abcdef1234567890ab", "k5"),
      ).rejects.toThrow("Withdrawal amount must be positive");
    });

    it("rejects empty destination", async () => {
      await expect(rail.withdraw("agent-001", 5.0, "USDC", "", "k6")).rejects.toThrow(
        "Destination address is required",
      );
    });

    it("propagates wallet errors (fail-closed)", async () => {
      (wallet.sendTransfer as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error("transaction reverted"),
      );

      await expect(
        rail.withdraw("agent-001", 5.0, "USDC", "0xDest1234567890abcdef1234567890ab", "k7"),
      ).rejects.toThrow("transaction reverted");
    });
  });

  describe("attachProof", () => {
    it("logs without throwing", async () => {
      await expect(
        rail.attachProof("settle-001", {
          reference: "0xtx_abc123",
          railType: "direct_asset",
          network: "eip155:8453",
          confirmedAt: Date.now(),
        }),
      ).resolves.toBeUndefined();
    });

    it("calls onProofAttached callback when provided", async () => {
      const onProof = vi.fn();
      const railWithCallback = new DirectAssetRail({
        walletProvider: wallet,
        chain: "eip155:8453",
        asset: "USDC",
        onProofAttached: onProof,
      });

      const proof = {
        reference: "0xtx_def789",
        railType: "direct_asset" as const,
        network: "eip155:8453",
        confirmedAt: Date.now(),
      };
      await railWithCallback.attachProof("settle-002", proof);

      expect(onProof).toHaveBeenCalledOnce();
      expect(onProof).toHaveBeenCalledWith("settle-002", proof);
    });
  });
});

describe("SettlementRailRegistry — all 4 rail types", () => {
  it("registers and retrieves all 4 rail types", async () => {
    const { StripeSettlementRail } = await import("../settlement-rails/stripe-rail.js");
    const { X402SettlementRail } = await import("../settlement-rails/x402-rail.js");
    const { BridgeSettlementRail } = await import("../settlement-rails/bridge-rail.js");

    const registry = new SettlementRailRegistry();

    // Fiat
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

    // Protocol
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

    // Orchestration
    registry.register(
      new BridgeSettlementRail({
        bridgeClient: {
          createTransfer: vi.fn(),
          getTransfer: vi.fn(),
          isReachable: vi.fn().mockResolvedValue(true),
        },
        customerId: "cust-001",
        sourcePaymentRail: "base",
        sourceCurrency: "usdc",
      }),
    );

    // Direct asset
    registry.register(
      new DirectAssetRail({
        walletProvider: createMockWallet(),
        chain: "eip155:8453",
        asset: "USDC",
      }),
    );

    expect(registry.list()).toHaveLength(4);
    expect(registry.getByType("fiat")).toHaveLength(1);
    expect(registry.getByType("protocol")).toHaveLength(1);
    expect(registry.getByType("orchestration")).toHaveLength(1);
    expect(registry.getByType("direct_asset")).toHaveLength(1);

    // Depositable check
    const fiatRail = registry.get("stripe")!;
    const directRail = registry.get("direct-asset")!;
    const protocolRail = registry.get("x402")!;
    const orchRail = registry.get("bridge")!;

    expect(isDepositableRail(fiatRail)).toBe(true);
    expect(isDepositableRail(directRail)).toBe(true);
    expect(isDepositableRail(protocolRail)).toBe(false);
    expect(isDepositableRail(orchRail)).toBe(false);
  });
});
