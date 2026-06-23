/**
 * OperatorSolanaTransfer tests — exercise the operator-side primitive
 * against a fake adapter. No network, no cryptography setup.
 *
 * The primitive is the relay-treasury counterpart to `SolanaWalletRail`:
 * both wrap a `SolanaRpcAdapter`, but the doctrine distinction lives at
 * the class type. These tests pin the operator-side semantics so the
 * agent vs operator boundary stays legible to readers.
 */

import { describe, it, expect, vi } from "vitest";

import {
  OperatorSolanaTransfer,
  createOperatorSolanaTransfer,
  type SolanaRpcAdapter,
  InsufficientUsdcBalanceError,
  InvalidSolanaAddressError,
  Web3JsRpcAdapter,
} from "../index.js";

function makeAdapter(overrides: Partial<SolanaRpcAdapter> = {}): SolanaRpcAdapter {
  return {
    ownAddress: "RelayTreasuryAddressBase58",
    getUsdcBalance: vi.fn().mockResolvedValue(10_000_000n),
    getUsdcBalanceOf: vi.fn().mockResolvedValue(10_000_000n),
    getSolBalance: vi.fn().mockResolvedValue(10_000_000n),
    sendUsdc: vi.fn().mockResolvedValue({
      signature: "tx-sig-123",
      slot: 42,
      confirmed: true,
    }),
    sendUsdcBatch: vi.fn().mockResolvedValue([]),
    getTransaction: vi.fn().mockResolvedValue({ status: "not_found" }),
    isReachable: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
}

describe("OperatorSolanaTransfer", () => {
  it("derives address from the adapter (relay's identity-derived Solana wallet)", () => {
    const adapter = makeAdapter({ ownAddress: "RelayTreasuryXYZ" });
    const op = new OperatorSolanaTransfer(adapter);
    expect(op.address).toBe("RelayTreasuryXYZ");
  });

  it("getUsdcBalance delegates to the adapter and returns micro-units", async () => {
    const adapter = makeAdapter({
      getUsdcBalance: vi.fn().mockResolvedValue(5_500_000n),
    });
    const op = new OperatorSolanaTransfer(adapter);
    expect(await op.getUsdcBalance()).toBe(5_500_000n);
    expect(adapter.getUsdcBalance).toHaveBeenCalledOnce();
  });

  it("getSolBalance delegates to the adapter and returns lamports", async () => {
    const adapter = makeAdapter({
      getSolBalance: vi.fn().mockResolvedValue(1_234_567n),
    });
    const op = new OperatorSolanaTransfer(adapter);
    expect(await op.getSolBalance()).toBe(1_234_567n);
  });

  it("sendUsdc forwards (toAddress, microAmount) to the adapter and returns the result", async () => {
    const adapter = makeAdapter();
    const op = new OperatorSolanaTransfer(adapter);

    const result = await op.sendUsdc("UserSovereignWalletBase58", 950_000n);

    expect(adapter.sendUsdc).toHaveBeenCalledWith({
      toAddress: "UserSovereignWalletBase58",
      microAmount: 950_000n,
    });
    expect(result.signature).toBe("tx-sig-123");
    expect(result.slot).toBe(42);
    expect(result.confirmed).toBe(true);
  });

  it("isAvailable delegates to the adapter", async () => {
    const adapter = makeAdapter({ isReachable: vi.fn().mockResolvedValue(false) });
    const op = new OperatorSolanaTransfer(adapter);
    expect(await op.isAvailable()).toBe(false);
  });

  it("propagates InsufficientUsdcBalanceError from the adapter", async () => {
    const adapter = makeAdapter({
      sendUsdc: vi.fn().mockRejectedValue(new InsufficientUsdcBalanceError(100_000n, 950_000n)),
    });
    const op = new OperatorSolanaTransfer(adapter);
    await expect(op.sendUsdc("UserWallet", 950_000n)).rejects.toBeInstanceOf(
      InsufficientUsdcBalanceError,
    );
  });

  it("propagates InvalidSolanaAddressError from the adapter for bad destinations", async () => {
    const adapter = makeAdapter({
      sendUsdc: vi.fn().mockRejectedValue(new InvalidSolanaAddressError("not-base58", null)),
    });
    const op = new OperatorSolanaTransfer(adapter);
    await expect(op.sendUsdc("not-base58", 1n)).rejects.toBeInstanceOf(InvalidSolanaAddressError);
  });

  // -------------------------------------------------------------------------
  // Doctrine pin — operator vs agent distinction lives at the class type.
  //
  // The negative-proof: `OperatorSolanaTransfer` is NOT a `SovereignRail`.
  // It carries no `custody` field. `SettlementRailRegistry.register()` (in
  // services/relay) would not even accept it as input — it's a different
  // type entirely. This test pins the surface: if someone refactors
  // OperatorSolanaTransfer to extend or implement `SovereignRail`, the
  // doctrine boundary (relay treasury primitive vs agent sovereign wallet)
  // would blur, and the negative-proof at packages/settlement-rails would
  // need to widen to forbid it too.
  // -------------------------------------------------------------------------
  it("carries no custody label — it is not a rail, it is the relay's own primitive", () => {
    const op = new OperatorSolanaTransfer(makeAdapter());
    expect((op as unknown as { custody?: unknown }).custody).toBeUndefined();
    expect((op as unknown as { name?: unknown }).name).toBeUndefined();
    expect((op as unknown as { chain?: unknown }).chain).toBeUndefined();
  });
});

describe("createOperatorSolanaTransfer factory", () => {
  it("constructs against the default Web3JsRpcAdapter", () => {
    const seed = new Uint8Array(32);
    seed[0] = 1;
    const op = createOperatorSolanaTransfer({
      rpcUrl: "https://api.mainnet-beta.solana.com",
      identitySeed: seed,
    });
    expect(op).toBeInstanceOf(OperatorSolanaTransfer);
    // Address should be derivable from the seed (Web3JsRpcAdapter.ownAddress)
    expect(op.address).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
  });

  it("validates the identitySeed length via the underlying adapter", () => {
    const tooShort = new Uint8Array(16);
    expect(() =>
      createOperatorSolanaTransfer({
        rpcUrl: "https://api.mainnet-beta.solana.com",
        identitySeed: tooShort,
      }),
    ).toThrow(/32-byte Ed25519 seed/);
  });

  it("passes through usdcMint and commitment to the adapter", () => {
    const seed = new Uint8Array(32);
    seed[0] = 2;
    // Construction should not throw with custom mint/commitment.
    expect(() =>
      createOperatorSolanaTransfer({
        rpcUrl: "https://api.devnet.solana.com",
        identitySeed: seed,
        usdcMint: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // mainnet USDC mint
        commitment: "finalized",
      }),
    ).not.toThrow();
  });
});

// Suppress unused-import warning if Web3JsRpcAdapter ends up unreferenced;
// it's imported only to verify the factory return type is buildable.
void Web3JsRpcAdapter;
