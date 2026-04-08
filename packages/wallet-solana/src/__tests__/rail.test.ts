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

import { describe, it, expect, vi } from "vitest";

import {
  SolanaWalletRail,
  type SolanaRpcAdapter,
  type SendUsdcArgs,
  InsufficientUsdcBalanceError,
  InvalidSolanaAddressError,
} from "../index.js";

function makeAdapter(overrides: Partial<SolanaRpcAdapter> = {}): SolanaRpcAdapter {
  return {
    ownAddress: "11111111111111111111111111111111",
    getUsdcBalance: vi.fn().mockResolvedValue(0n),
    sendUsdc: vi.fn().mockResolvedValue({
      signature: "sig",
      slot: 0,
      confirmed: true,
    }),
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
