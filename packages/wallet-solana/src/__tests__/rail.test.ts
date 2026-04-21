/**
 * SolanaWalletRail tests — exercise the rail interface against a fake
 * adapter. The Solana RPC client is never touched here; that's the
 * Web3JsRpcAdapter's job and it gets its own integration test (or
 * lives uncovered until devnet wiring is wanted).
 *
 * The point of having a tiny rail + adapter boundary is exactly this:
 * the rail logic is testable in milliseconds with zero network or
 * cryptography setup.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// `rail.ensureGas()` lazily imports `./jupiter.js`. We mock it at the
// module level so the auto-gas branch can be exercised without ever
// hitting the Jupiter HTTP API. `vi.hoisted` is required because
// `vi.mock` is hoisted above plain const declarations.
const { swapUsdcToSolMock } = vi.hoisted(() => ({ swapUsdcToSolMock: vi.fn() }));
vi.mock("../jupiter.js", () => ({
  swapUsdcToSol: swapUsdcToSolMock,
}));

import {
  SolanaWalletRail,
  type SolanaRpcAdapter,
  type SendUsdcArgs,
  InsufficientUsdcBalanceError,
  InvalidSolanaAddressError,
  Web3JsRpcAdapter,
  createSolanaWalletRail,
} from "../index.js";

beforeEach(() => {
  swapUsdcToSolMock.mockReset();
});

function makeAdapter(overrides: Partial<SolanaRpcAdapter> = {}): SolanaRpcAdapter {
  return {
    ownAddress: "11111111111111111111111111111111",
    getUsdcBalance: vi.fn().mockResolvedValue(0n),
    getSolBalance: vi.fn().mockResolvedValue(10_000_000n),
    sendUsdc: vi.fn().mockResolvedValue({
      signature: "sig",
      slot: 0,
      confirmed: true,
    }),
    sendUsdcBatch: vi.fn().mockResolvedValue([]),
    getTransaction: vi.fn().mockResolvedValue({ status: "not_found" }),
    isReachable: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
}

describe("SolanaWalletRail", () => {
  it("exposes a stable rail vocabulary", () => {
    const rail = new SolanaWalletRail(makeAdapter());
    expect(rail.chain).toBe("solana");
    expect(rail.asset).toBe("USDC");
  });

  it("is a sovereign (agent-custody) rail, not a guest rail", () => {
    const rail = new SolanaWalletRail(makeAdapter());
    expect(rail.custody).toBe("agent");
    expect(rail.name).toBe("solana-wallet");
  });

  it("derives address from the adapter (which derives from the identity seed)", () => {
    const adapter = makeAdapter({ ownAddress: "DanielsTestAddressBase58" });
    const rail = new SolanaWalletRail(adapter);
    expect(rail.address).toBe("DanielsTestAddressBase58");
  });

  it("getBalance delegates to adapter and returns micro-USDC", async () => {
    const adapter = makeAdapter({
      getUsdcBalance: vi.fn().mockResolvedValue(1_500_000n),
    });
    const rail = new SolanaWalletRail(adapter);
    expect(await rail.getBalance()).toBe(1_500_000n);
    expect(adapter.getUsdcBalance).toHaveBeenCalledOnce();
  });

  it("send delegates to adapter with toAddress and microAmount", async () => {
    const sendUsdc = vi.fn(async (_args: SendUsdcArgs) => ({
      signature: "5JxYz",
      slot: 42,
      confirmed: true,
    }));
    const rail = new SolanaWalletRail(makeAdapter({ sendUsdc }));

    const result = await rail.send("DestAddress123", 430_000n);

    expect(sendUsdc).toHaveBeenCalledWith({
      toAddress: "DestAddress123",
      microAmount: 430_000n,
    });
    expect(result).toEqual({ signature: "5JxYz", slot: 42, confirmed: true });
  });

  it("propagates InsufficientUsdcBalanceError unchanged", async () => {
    const sendUsdc = vi.fn().mockRejectedValue(new InsufficientUsdcBalanceError(100n, 500n));
    const rail = new SolanaWalletRail(makeAdapter({ sendUsdc }));

    await expect(rail.send("Dest", 500n)).rejects.toBeInstanceOf(InsufficientUsdcBalanceError);
    await expect(rail.send("Dest", 500n)).rejects.toMatchObject({
      available: 100n,
      requested: 500n,
    });
  });

  it("propagates InvalidSolanaAddressError unchanged", async () => {
    const sendUsdc = vi.fn().mockRejectedValue(new InvalidSolanaAddressError("not-base58"));
    const rail = new SolanaWalletRail(makeAdapter({ sendUsdc }));

    await expect(rail.send("not-base58", 1n)).rejects.toBeInstanceOf(InvalidSolanaAddressError);
  });

  it("isAvailable delegates to adapter reachability check", async () => {
    const isReachable = vi.fn().mockResolvedValue(false);
    const rail = new SolanaWalletRail(makeAdapter({ isReachable }));
    expect(await rail.isAvailable()).toBe(false);
    expect(isReachable).toHaveBeenCalledOnce();
  });
});

describe("InsufficientUsdcBalanceError", () => {
  it("captures available and requested amounts in the message", () => {
    const err = new InsufficientUsdcBalanceError(250_000n, 1_000_000n);
    expect(err.name).toBe("InsufficientUsdcBalanceError");
    expect(err.available).toBe(250_000n);
    expect(err.requested).toBe(1_000_000n);
    expect(err.message).toContain("250000");
    expect(err.message).toContain("1000000");
  });
});

describe("InvalidSolanaAddressError", () => {
  it("preserves the offending address and optional cause", () => {
    const cause = new Error("base58 decode failed");
    const err = new InvalidSolanaAddressError("garbage", cause);
    expect(err.name).toBe("InvalidSolanaAddressError");
    expect(err.address).toBe("garbage");
    expect(err.message).toContain("garbage");
    expect(err.cause).toBe(cause);
  });
});

describe("SolanaWalletRail.sendBatch", () => {
  it("delegates to adapter.sendUsdcBatch with all items", async () => {
    const batchResult = [
      { ok: true, signature: "sig-1", slot: 10, reason: null },
      { ok: true, signature: "sig-1", slot: 10, reason: null },
    ];
    const sendUsdcBatch = vi.fn().mockResolvedValue(batchResult);
    const rail = new SolanaWalletRail(makeAdapter({ sendUsdcBatch }));

    const results = await rail.sendBatch([
      { toAddress: "Dest1", microAmount: 100_000n },
      { toAddress: "Dest2", microAmount: 200_000n },
    ]);

    expect(sendUsdcBatch).toHaveBeenCalledOnce();
    expect(sendUsdcBatch).toHaveBeenCalledWith([
      { toAddress: "Dest1", microAmount: 100_000n },
      { toAddress: "Dest2", microAmount: 200_000n },
    ]);
    expect(results).toEqual(batchResult);
  });

  it("returns per-item results including partial failure", async () => {
    const batchResult = [
      { ok: true, signature: "sig-A", slot: 5, reason: null },
      { ok: false, signature: null, slot: 0, reason: "prior chunk failed" },
    ];
    const sendUsdcBatch = vi.fn().mockResolvedValue(batchResult);
    const rail = new SolanaWalletRail(makeAdapter({ sendUsdcBatch }));

    const results = await rail.sendBatch([
      { toAddress: "D1", microAmount: 50_000n },
      { toAddress: "D2", microAmount: 60_000n },
    ]);

    expect(results[0]!.ok).toBe(true);
    expect(results[1]!.ok).toBe(false);
    expect(results[1]!.reason).toBe("prior chunk failed");
  });
});

// ── getSolBalance + ensureGas ────────────────────────────────────────────
//
// `ensureGas` is the auto-gas guard. It returns true when SOL is above
// the floor, returns false when auto-gas is disabled (or impossible
// because the adapter isn't a Web3JsRpcAdapter), attempts a Jupiter
// swap when both autoGas and a Web3JsRpcAdapter are present, and
// returns false on swap failure (caller can still attempt the txn —
// it'll fail with insufficient gas, but that's the honest state).

describe("SolanaWalletRail.getSolBalance", () => {
  it("delegates to adapter.getSolBalance and returns lamports", async () => {
    const getSolBalance = vi.fn().mockResolvedValue(7_654_321n);
    const rail = new SolanaWalletRail(makeAdapter({ getSolBalance }));
    expect(await rail.getSolBalance()).toBe(7_654_321n);
    expect(getSolBalance).toHaveBeenCalledOnce();
  });
});

describe("SolanaWalletRail.ensureGas", () => {
  it("returns true without swapping when SOL balance is at or above the gas floor", async () => {
    // Default mock returns 10_000_000n lamports, well above 5_000_000n floor.
    const rail = new SolanaWalletRail(makeAdapter(), { autoGas: true });
    expect(await rail.ensureGas()).toBe(true);
    expect(swapUsdcToSolMock).not.toHaveBeenCalled();
  });

  it("returns false when below the floor and autoGas is disabled", async () => {
    const rail = new SolanaWalletRail(
      makeAdapter({ getSolBalance: vi.fn().mockResolvedValue(0n) }),
      { autoGas: false },
    );
    expect(await rail.ensureGas()).toBe(false);
    expect(swapUsdcToSolMock).not.toHaveBeenCalled();
  });

  it("returns false when below the floor and the adapter is not a Web3JsRpcAdapter", async () => {
    // autoGas=true but the fake adapter is not a Web3JsRpcAdapter, so the
    // Jupiter swap path can't be reached — degrade honestly.
    const rail = new SolanaWalletRail(
      makeAdapter({ getSolBalance: vi.fn().mockResolvedValue(0n) }),
      { autoGas: true },
    );
    expect(await rail.ensureGas()).toBe(false);
    expect(swapUsdcToSolMock).not.toHaveBeenCalled();
  });

  it("auto-swaps USDC → SOL via Jupiter and returns true on swap success", async () => {
    const adapter = new Web3JsRpcAdapter({
      rpcUrl: "https://api.devnet.solana.com",
      identitySeed: new Uint8Array(32).fill(3),
    });
    vi.spyOn(adapter, "getSolBalance").mockResolvedValue(0n); // below floor
    swapUsdcToSolMock.mockResolvedValue({ signature: "sigSwap", outAmountLamports: 10_000_000n });

    const rail = new SolanaWalletRail(adapter, { autoGas: true });
    expect(await rail.ensureGas()).toBe(true);
    expect(swapUsdcToSolMock).toHaveBeenCalledOnce();
  });

  it("returns false when the Jupiter swap throws (caller can still proceed)", async () => {
    const adapter = new Web3JsRpcAdapter({
      rpcUrl: "https://api.devnet.solana.com",
      identitySeed: new Uint8Array(32).fill(4),
    });
    vi.spyOn(adapter, "getSolBalance").mockResolvedValue(0n);
    swapUsdcToSolMock.mockRejectedValue(new Error("Jupiter quote failed"));

    const rail = new SolanaWalletRail(adapter, { autoGas: true });
    expect(await rail.ensureGas()).toBe(false);
    expect(swapUsdcToSolMock).toHaveBeenCalledOnce();
  });
});

describe("SolanaWalletRail send + sendBatch with autoGas", () => {
  it("calls ensureGas before sending when autoGas is enabled", async () => {
    const getSolBalance = vi.fn().mockResolvedValue(10_000_000n); // above floor
    const sendUsdc = vi.fn().mockResolvedValue({
      signature: "sig",
      slot: 1,
      confirmed: true,
    });
    const rail = new SolanaWalletRail(makeAdapter({ getSolBalance, sendUsdc }), { autoGas: true });
    await rail.send("Dest", 100n);
    expect(getSolBalance).toHaveBeenCalledOnce();
    expect(sendUsdc).toHaveBeenCalledOnce();
  });

  it("does NOT call getSolBalance when autoGas is disabled", async () => {
    const getSolBalance = vi.fn().mockResolvedValue(0n);
    const sendUsdc = vi.fn().mockResolvedValue({
      signature: "sig",
      slot: 1,
      confirmed: true,
    });
    const rail = new SolanaWalletRail(makeAdapter({ getSolBalance, sendUsdc }), { autoGas: false });
    await rail.send("Dest", 100n);
    expect(getSolBalance).not.toHaveBeenCalled();
    expect(sendUsdc).toHaveBeenCalledOnce();
  });

  it("calls ensureGas before sendBatch when autoGas is enabled", async () => {
    const getSolBalance = vi.fn().mockResolvedValue(10_000_000n);
    const sendUsdcBatch = vi.fn().mockResolvedValue([]);
    const rail = new SolanaWalletRail(makeAdapter({ getSolBalance, sendUsdcBatch }), {
      autoGas: true,
    });
    await rail.sendBatch([{ toAddress: "D", microAmount: 1n }]);
    expect(getSolBalance).toHaveBeenCalledOnce();
    expect(sendUsdcBatch).toHaveBeenCalledOnce();
  });
});

// ── createSolanaWalletRail factory ───────────────────────────────────────

describe("createSolanaWalletRail", () => {
  it("constructs a rail backed by Web3JsRpcAdapter, autoGas on by default", () => {
    const rail = createSolanaWalletRail({
      rpcUrl: "https://api.devnet.solana.com",
      identitySeed: new Uint8Array(32).fill(5),
    });
    expect(rail).toBeInstanceOf(SolanaWalletRail);
    expect(rail.chain).toBe("solana");
    expect(rail.asset).toBe("USDC");
    // Address derives from the seed via Web3JsRpcAdapter — non-empty base58.
    expect(rail.address).toMatch(/^[1-9A-HJ-NP-Za-km-z]+$/);
  });

  it("disables autoGas when disableAutoGas: true", async () => {
    const rail = createSolanaWalletRail({
      rpcUrl: "https://api.devnet.solana.com",
      identitySeed: new Uint8Array(32).fill(6),
      disableAutoGas: true,
    });
    // With autoGas disabled, ensureGas returns false at low balance without
    // attempting a swap. Spy on the underlying connection to keep the test
    // network-free.
    const adapter = (rail as unknown as { adapter: Web3JsRpcAdapter }).adapter;
    vi.spyOn(adapter, "getSolBalance").mockResolvedValue(0n);
    expect(await rail.ensureGas()).toBe(false);
    expect(swapUsdcToSolMock).not.toHaveBeenCalled();
  });

  it("forwards usdcMint and commitment to the underlying adapter", () => {
    const rail = createSolanaWalletRail({
      rpcUrl: "https://api.devnet.solana.com",
      identitySeed: new Uint8Array(32).fill(7),
      usdcMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      commitment: "finalized",
    });
    const adapter = (rail as unknown as { adapter: Web3JsRpcAdapter }).adapter;
    expect(adapter.getCommitment()).toBe("finalized");
    expect(adapter.getUsdcMint()).toBe("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
  });
});
