/**
 * sweepWalletRail — move a sovereign wallet's accrued USDC to a destination.
 * Pure logic against a fake wallet; no network.
 */
import { describe, it, expect, vi } from "vitest";
import { sweepWalletRail, type SweepableWallet } from "../sweep.js";

function fakeWallet(over: Partial<SweepableWallet> = {}): SweepableWallet {
  return {
    isAvailable: vi.fn().mockResolvedValue(true),
    getBalance: vi.fn().mockResolvedValue(0n),
    send: vi.fn().mockResolvedValue({ signature: "sig-1" }),
    ...over,
  };
}

const DEST = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgHkv";

describe("sweepWalletRail", () => {
  it("sweeps the FULL balance when at/above the floor", async () => {
    const send = vi.fn().mockResolvedValue({ signature: "sig-xyz" });
    const wallet = fakeWallet({ getBalance: vi.fn().mockResolvedValue(500_000n), send });
    const res = await sweepWalletRail(wallet, DEST, 1_000n);
    expect(res).toEqual({ swept: true, balanceMicro: 500_000n, signature: "sig-xyz" });
    // Sends the entire balance to the destination — nothing left behind.
    expect(send).toHaveBeenCalledWith(DEST, 500_000n);
  });

  it("does NOT sweep when the balance is below the floor (no gas burned on dust)", async () => {
    const send = vi.fn();
    const wallet = fakeWallet({ getBalance: vi.fn().mockResolvedValue(999n), send });
    const res = await sweepWalletRail(wallet, DEST, 1_000n);
    expect(res).toEqual({ swept: false, balanceMicro: 999n, reason: "below_min" });
    expect(send).not.toHaveBeenCalled();
  });

  it("sweeps exactly at the floor (>= boundary)", async () => {
    const send = vi.fn().mockResolvedValue({ signature: "sig-floor" });
    const wallet = fakeWallet({ getBalance: vi.fn().mockResolvedValue(1_000n), send });
    const res = await sweepWalletRail(wallet, DEST, 1_000n);
    expect(res.swept).toBe(true);
    expect(send).toHaveBeenCalledWith(DEST, 1_000n);
  });

  it("does NOT read balance or send when the rail is unreachable", async () => {
    const getBalance = vi.fn();
    const send = vi.fn();
    const wallet = fakeWallet({
      isAvailable: vi.fn().mockResolvedValue(false),
      getBalance,
      send,
    });
    const res = await sweepWalletRail(wallet, DEST, 1_000n);
    expect(res).toEqual({ swept: false, balanceMicro: 0n, reason: "rail_unavailable" });
    expect(getBalance).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("propagates a send failure (insufficient gas / RPC error) for the caller's loop to catch", async () => {
    const wallet = fakeWallet({
      getBalance: vi.fn().mockResolvedValue(500_000n),
      send: vi.fn().mockRejectedValue(new Error("insufficient SOL for gas")),
    });
    await expect(sweepWalletRail(wallet, DEST, 1_000n)).rejects.toThrow("insufficient SOL");
  });
});
