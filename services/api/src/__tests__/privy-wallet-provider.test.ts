/**
 * PrivyWalletProvider unit tests.
 *
 * Tests with mocked Privy SDK — no real API calls.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { WalletProvider } from "../settlement-rails/direct-asset-rail.js";

// --- Mock @privy-io/node ---

const mockCreate = vi.fn();
const mockSendTransaction = vi.fn();
const mockGet = vi.fn();

vi.mock("@privy-io/node", () => ({
  PrivyClient: vi.fn().mockImplementation(() => ({
    wallets: () => ({
      create: mockCreate,
      get: mockGet,
      ethereum: () => ({
        sendTransaction: mockSendTransaction,
      }),
    }),
  })),
}));

// Import after mock is set up
const { PrivyWalletProvider } = await import("../settlement-rails/privy-wallet-provider.js");

describe("PrivyWalletProvider", () => {
  let provider: WalletProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockCreate.mockResolvedValue({
      id: "wallet-001",
      address: "0xAgentWallet1234567890abcdef12345678",
      chain_type: "ethereum",
    });
    mockSendTransaction.mockResolvedValue({
      hash: "0xtx_privy_abc123",
      caip2: "eip155:8453",
    });
    provider = new PrivyWalletProvider({
      appId: "test-app-id",
      appSecret: "test-app-secret",
    });
  });

  describe("getAddress", () => {
    it("creates wallet on first call and returns address", async () => {
      const address = await provider.getAddress("agent-001", "eip155:8453");

      expect(address).toBe("0xAgentWallet1234567890abcdef12345678");
      expect(mockCreate).toHaveBeenCalledWith({ chain_type: "ethereum" });
    });

    it("caches wallet and reuses on subsequent calls", async () => {
      await provider.getAddress("agent-001", "eip155:8453");
      await provider.getAddress("agent-001", "eip155:8453");
      await provider.getAddress("agent-001", "eip155:8453");

      // Only one create call despite 3 getAddress calls
      expect(mockCreate).toHaveBeenCalledOnce();
    });

    it("creates separate wallets for different agents", async () => {
      mockCreate
        .mockResolvedValueOnce({
          id: "wallet-001",
          address: "0xAddr1",
          chain_type: "ethereum",
        })
        .mockResolvedValueOnce({
          id: "wallet-002",
          address: "0xAddr2",
          chain_type: "ethereum",
        });

      const addr1 = await provider.getAddress("agent-001", "eip155:8453");
      const addr2 = await provider.getAddress("agent-002", "eip155:8453");

      expect(addr1).toBe("0xAddr1");
      expect(addr2).toBe("0xAddr2");
      expect(mockCreate).toHaveBeenCalledTimes(2);
    });
  });

  describe("getBalance", () => {
    it("returns max safe integer (ledger is source of truth)", async () => {
      const balance = await provider.getBalance("agent-001", "eip155:8453", "USDC");
      expect(balance).toBe(BigInt(Number.MAX_SAFE_INTEGER));
    });
  });

  describe("sendTransfer", () => {
    it("creates wallet if needed, then sends transaction", async () => {
      const result = await provider.sendTransfer({
        agentId: "agent-001",
        chain: "eip155:8453",
        to: "0xDestination",
        asset: "USDC",
        amount: BigInt(5_000_000),
        idempotencyKey: "idem-1",
      });

      expect(result.txHash).toBe("0xtx_privy_abc123");

      // Wallet created
      expect(mockCreate).toHaveBeenCalledOnce();

      // Transaction sent with correct params
      expect(mockSendTransaction).toHaveBeenCalledWith("wallet-001", {
        caip2: "eip155:8453",
        params: {
          transaction: {
            to: "0xDestination",
            value: "5000000",
            chain_id: 8453,
          },
        },
      });
    });

    it("reuses cached wallet for subsequent transfers", async () => {
      await provider.sendTransfer({
        agentId: "agent-001",
        chain: "eip155:8453",
        to: "0xDest1",
        asset: "USDC",
        amount: BigInt(1_000_000),
        idempotencyKey: "idem-1",
      });

      await provider.sendTransfer({
        agentId: "agent-001",
        chain: "eip155:8453",
        to: "0xDest2",
        asset: "USDC",
        amount: BigInt(2_000_000),
        idempotencyKey: "idem-2",
      });

      expect(mockCreate).toHaveBeenCalledOnce(); // wallet cached
      expect(mockSendTransaction).toHaveBeenCalledTimes(2);
    });

    it("parses chain ID from CAIP-2", async () => {
      await provider.sendTransfer({
        agentId: "agent-001",
        chain: "eip155:1",
        to: "0xDest",
        asset: "USDC",
        amount: BigInt(100),
        idempotencyKey: "idem-3",
      });

      expect(mockSendTransaction).toHaveBeenCalledWith(
        "wallet-001",
        expect.objectContaining({
          caip2: "eip155:1",
          params: expect.objectContaining({
            transaction: expect.objectContaining({
              chain_id: 1,
            }),
          }),
        }),
      );
    });

    it("propagates Privy API errors (fail-closed)", async () => {
      mockSendTransaction.mockRejectedValueOnce(new Error("insufficient gas"));

      await expect(
        provider.sendTransfer({
          agentId: "agent-001",
          chain: "eip155:8453",
          to: "0xDest",
          asset: "USDC",
          amount: BigInt(5_000_000),
          idempotencyKey: "idem-4",
        }),
      ).rejects.toThrow("insufficient gas");
    });

    it("propagates wallet creation errors (fail-closed)", async () => {
      mockCreate.mockRejectedValueOnce(new Error("rate limited"));

      await expect(
        provider.sendTransfer({
          agentId: "agent-new",
          chain: "eip155:8453",
          to: "0xDest",
          asset: "USDC",
          amount: BigInt(1_000_000),
          idempotencyKey: "idem-5",
        }),
      ).rejects.toThrow("rate limited");
    });
  });
});
