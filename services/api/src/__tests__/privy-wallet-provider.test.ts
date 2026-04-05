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
const {
  PrivyWalletProvider,
  encodeErc20Transfer,
  queryErc20Balance,
  USDC_CONTRACTS,
  InMemoryWalletStore,
} = await import("../settlement-rails/privy-wallet-provider.js");

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
    mockGet.mockResolvedValue({
      id: "wallet-001",
      address: "0xAgentWallet1234567890abcdef12345678",
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
    it("queries ERC-20 balance via RPC when chain and asset are known", async () => {
      // Mock fetch for RPC call — return 100 USDC (100 * 10^6 = 0x5F5E100)
      const mockRpcFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          jsonrpc: "2.0",
          id: 1,
          result: "0x0000000000000000000000000000000000000000000000000000000005f5e100",
        }),
      });

      const rpcProvider = new PrivyWalletProvider({
        appId: "test-app-id",
        appSecret: "test-app-secret",
        fetch: mockRpcFetch as unknown as typeof globalThis.fetch,
      });

      const balance = await rpcProvider.getBalance("agent-001", "eip155:8453", "USDC");
      expect(balance).toBe(BigInt(100_000_000)); // 100 USDC in 6 decimals

      // RPC call made for balance query (Privy SDK is mocked separately)
      expect(mockRpcFetch).toHaveBeenCalledOnce();
    });

    it("returns MAX_SAFE_INTEGER when RPC fails (fail-open)", async () => {
      const failingFetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));

      const rpcProvider = new PrivyWalletProvider({
        appId: "test-app-id",
        appSecret: "test-app-secret",
        fetch: failingFetch as unknown as typeof globalThis.fetch,
      });

      const balance = await rpcProvider.getBalance("agent-001", "eip155:8453", "USDC");
      expect(balance).toBe(BigInt(Number.MAX_SAFE_INTEGER));
    });

    it("returns MAX_SAFE_INTEGER for unknown chain (no RPC URL)", async () => {
      const balance = await provider.getBalance("agent-001", "eip155:999999", "USDC");
      expect(balance).toBe(BigInt(Number.MAX_SAFE_INTEGER));
    });

    it("returns MAX_SAFE_INTEGER for unknown asset", async () => {
      const balance = await provider.getBalance("agent-001", "eip155:8453", "DAI");
      expect(balance).toBe(BigInt(Number.MAX_SAFE_INTEGER));
    });
  });

  describe("sendTransfer — ERC-20 (USDC)", () => {
    it("encodes ERC-20 transfer calldata for USDC on known chain", async () => {
      await provider.sendTransfer({
        agentId: "agent-001",
        chain: "eip155:8453",
        to: "0xDestination1234567890abcdef12345678",
        asset: "USDC",
        amount: BigInt(5_000_000),
        idempotencyKey: "idem-1",
      });

      expect(mockSendTransaction).toHaveBeenCalledWith(
        "wallet-001",
        expect.objectContaining({
          caip2: "eip155:8453",
          params: {
            transaction: expect.objectContaining({
              // ERC-20: `to` is the USDC contract, not the recipient
              to: USDC_CONTRACTS["eip155:8453"],
              value: 0,
              // `data` contains the transfer(to, amount) calldata
              data: expect.stringContaining("0xa9059cbb"),
              chain_id: 8453,
            }),
          },
        }),
      );
    });

    it("falls back to native transfer for unknown asset", async () => {
      await provider.sendTransfer({
        agentId: "agent-001",
        chain: "eip155:8453",
        to: "0xDest",
        asset: "ETH",
        amount: BigInt(1_000_000_000_000_000),
        idempotencyKey: "idem-2",
      });

      expect(mockSendTransaction).toHaveBeenCalledWith(
        "wallet-001",
        expect.objectContaining({
          params: {
            transaction: expect.objectContaining({
              to: "0xDest",
              value: "1000000000000000",
            }),
          },
        }),
      );
    });
  });

  describe("wallet persistence", () => {
    it("restores wallet from store on restart (no new creation)", async () => {
      const store = new InMemoryWalletStore();
      store.setWalletId("agent-001", "existing-wallet-id", "0xExistingAddr");

      const persistedProvider = new PrivyWalletProvider({
        appId: "test-app-id",
        appSecret: "test-app-secret",
        walletStore: store,
      });

      const address = await persistedProvider.getAddress("agent-001", "eip155:8453");

      // Should have fetched from Privy by ID, not created new
      expect(mockGet).toHaveBeenCalledWith("existing-wallet-id");
      expect(mockCreate).not.toHaveBeenCalled();
      expect(address).toBe("0xAgentWallet1234567890abcdef12345678"); // from mockGet
    });

    it("persists new wallet to store on creation", async () => {
      const store = new InMemoryWalletStore();
      const persistedProvider = new PrivyWalletProvider({
        appId: "test-app-id",
        appSecret: "test-app-secret",
        walletStore: store,
      });

      await persistedProvider.getAddress("agent-new", "eip155:8453");

      expect(store.getWalletId("agent-new")).toBe("wallet-001");
    });
  });

  describe("error handling", () => {
    it("propagates Privy API errors (fail-closed)", async () => {
      mockSendTransaction.mockRejectedValueOnce(new Error("insufficient gas"));

      await expect(
        provider.sendTransfer({
          agentId: "agent-001",
          chain: "eip155:8453",
          to: "0xDest",
          asset: "USDC",
          amount: BigInt(5_000_000),
          idempotencyKey: "idem-err",
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
          idempotencyKey: "idem-err2",
        }),
      ).rejects.toThrow("rate limited");
    });
  });
});

describe("encodeErc20Transfer", () => {
  it("encodes transfer(to, amount) with correct selector", () => {
    const calldata = encodeErc20Transfer(
      "0x1234567890abcdef1234567890abcdef12345678",
      BigInt(5_000_000),
    );

    // Starts with transfer selector
    expect(calldata.startsWith("0xa9059cbb")).toBe(true);
    // Total length: 10 (selector) + 64 (address) + 64 (amount) = 138 chars
    expect(calldata.length).toBe(138);
    // Address is left-padded to 32 bytes
    expect(calldata.slice(10, 74)).toBe(
      "0000000000000000000000001234567890abcdef1234567890abcdef12345678",
    );
    // Amount is left-padded to 32 bytes
    expect(calldata.slice(74)).toBe(
      "00000000000000000000000000000000000000000000000000000000004c4b40",
    );
  });

  it("handles large amounts", () => {
    const calldata = encodeErc20Transfer(
      "0x0000000000000000000000000000000000000001",
      BigInt("1000000000000000000"), // 1e18
    );

    expect(calldata.startsWith("0xa9059cbb")).toBe(true);
    expect(calldata.length).toBe(138);
  });
});

describe("queryErc20Balance", () => {
  it("returns balance from successful RPC call", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        jsonrpc: "2.0",
        id: 1,
        result: "0x00000000000000000000000000000000000000000000000000000000004c4b40",
      }),
    });

    const balance = await queryErc20Balance(
      "https://rpc.example.com",
      "0xUSDC",
      "0xWallet1234567890abcdef1234567890abcdef",
      mockFetch as unknown as typeof globalThis.fetch,
    );

    expect(balance).toBe(BigInt(5_000_000));

    // Verify the RPC request shape
    const [url, init] = mockFetch.mock.calls[0]!;
    expect(url).toBe("https://rpc.example.com");
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.method).toBe("eth_call");
  });

  it("returns null on RPC error", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "error" } }),
    });

    const balance = await queryErc20Balance(
      "https://rpc.example.com",
      "0xUSDC",
      "0xWallet",
      mockFetch as unknown as typeof globalThis.fetch,
    );
    expect(balance).toBeNull();
  });

  it("returns null on network failure", async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));

    const balance = await queryErc20Balance(
      "https://rpc.example.com",
      "0xUSDC",
      "0xWallet",
      mockFetch as unknown as typeof globalThis.fetch,
    );
    expect(balance).toBeNull();
  });

  it("returns null on HTTP error", async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 500 });

    const balance = await queryErc20Balance(
      "https://rpc.example.com",
      "0xUSDC",
      "0xWallet",
      mockFetch as unknown as typeof globalThis.fetch,
    );
    expect(balance).toBeNull();
  });
});

describe("USDC_CONTRACTS", () => {
  it("has entries for major chains", () => {
    expect(USDC_CONTRACTS["eip155:1"]).toBeDefined(); // Ethereum
    expect(USDC_CONTRACTS["eip155:8453"]).toBeDefined(); // Base
    expect(USDC_CONTRACTS["eip155:84532"]).toBeDefined(); // Base Sepolia
    expect(USDC_CONTRACTS["eip155:137"]).toBeDefined(); // Polygon
    expect(USDC_CONTRACTS["eip155:42161"]).toBeDefined(); // Arbitrum
    expect(USDC_CONTRACTS["eip155:10"]).toBeDefined(); // Optimism
  });
});
