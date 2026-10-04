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

  it("sendPayout forwards the durable-nonce payout to the adapter, with the lane and the hooks (#990)", async () => {
    const tx = { signature: "p", kind: "payout" as const, nonceAccount: "N", nonceValue: "v" };
    const durable = vi.fn().mockResolvedValue({
      tx,
      final: { status: "finalized", ok: true, slot: 42 },
    });
    const adapter = makeAdapter({ sendUsdcDurable: durable });
    const op = new OperatorSolanaTransfer(adapter);
    const lane = { account: "N", nonceValue: "v" };
    const hooks = { beforeBroadcast: vi.fn() };
    const result = await op.sendPayout("UserSovereignWalletBase58", 950_000n, lane, hooks);
    expect(durable).toHaveBeenCalledWith(
      { toAddress: "UserSovereignWalletBase58", microAmount: 950_000n },
      lane,
      hooks,
    );
    expect(result.final).toEqual({ status: "finalized", ok: true, slot: 42 });
    expect(adapter.sendUsdc).not.toHaveBeenCalled(); // never a blockhash payout
  });

  it("sendPayout propagates the adapter's pre-send errors, and refuses an adapter with no durable path", async () => {
    const insufficient = new OperatorSolanaTransfer(
      makeAdapter({
        sendUsdcDurable: vi
          .fn()
          .mockRejectedValue(new InsufficientUsdcBalanceError(100_000n, 950_000n)),
      }),
    );
    const lane = { account: "N", nonceValue: "v" };
    await expect(insufficient.sendPayout("UserWallet", 950_000n, lane)).rejects.toBeInstanceOf(
      InsufficientUsdcBalanceError,
    );
    const invalid = new OperatorSolanaTransfer(
      makeAdapter({
        sendUsdcDurable: vi.fn().mockRejectedValue(new InvalidSolanaAddressError("x", null)),
      }),
    );
    await expect(invalid.sendPayout("x", 1n, lane)).rejects.toBeInstanceOf(
      InvalidSolanaAddressError,
    );
    await expect(
      new OperatorSolanaTransfer(makeAdapter()).sendPayout("UserWallet", 1n, lane),
    ).rejects.toThrow(/durable-nonce/);
  });

  it("isAvailable delegates to the adapter", async () => {
    const adapter = makeAdapter({ isReachable: vi.fn().mockResolvedValue(false) });
    const op = new OperatorSolanaTransfer(adapter);
    expect(await op.isAvailable()).toBe(false);
  });

  it("recordsBroadcasts only over an adapter that honours the hooks, has the nonce lane, reads any nonce account, the durable send, the kill AND the finalized read (#990)", () => {
    const full = {
      honorsBroadcastHooks: true as const,
      prepareNonceLane: vi.fn(),
      readNonceAccount: vi.fn(),
      sendUsdcDurable: vi.fn(),
      broadcastNonceKill: vi.fn(),
      getFinalizedStatus: vi.fn(),
    };
    expect(new OperatorSolanaTransfer(makeAdapter(full)).recordsBroadcasts).toBe(true);
    expect(new OperatorSolanaTransfer(makeAdapter()).recordsBroadcasts).toBe(false);
    for (const key of Object.keys(full) as Array<keyof typeof full>) {
      const partial: Partial<SolanaRpcAdapter> = { ...full };
      delete partial[key];
      expect(new OperatorSolanaTransfer(makeAdapter(partial)).recordsBroadcasts, key).toBe(false);
    }
  });

  it("prepareNonceLane, broadcastNonceKill and getFinalizedStatus delegate; missing ⇒ unavailable / refused / unknown — never evidence", async () => {
    const lane = { account: "N", nonceValue: "v" };
    const op = new OperatorSolanaTransfer(
      makeAdapter({
        prepareNonceLane: vi.fn().mockResolvedValue({ status: "ready", ...lane }),
        broadcastNonceKill: vi.fn().mockResolvedValue({
          tx: { signature: "k", kind: "kill", nonceAccount: "N", nonceValue: "v" },
          sent: true,
        }),
        getFinalizedStatus: vi.fn().mockResolvedValue({ status: "finalized", ok: true, slot: 1 }),
      }),
    );
    expect(await op.prepareNonceLane()).toEqual({ status: "ready", ...lane });
    const read = vi.fn().mockResolvedValue({ status: "ready", ...lane, observedSlot: 9 });
    const reader = new OperatorSolanaTransfer(makeAdapter({ readNonceAccount: read }));
    expect(await reader.readNonceAccount("N", { minContextSlot: 5 })).toMatchObject({
      observedSlot: 9,
    });
    expect(read).toHaveBeenCalledWith("N", { minContextSlot: 5 });
    expect((await new OperatorSolanaTransfer(makeAdapter()).readNonceAccount("N")).status).toBe(
      "unavailable",
    );
    expect((await op.broadcastNonceKill(lane)).sent).toBe(true);
    expect(await op.getFinalizedStatus("k")).toEqual({ status: "finalized", ok: true, slot: 1 });
    const bare = new OperatorSolanaTransfer(makeAdapter());
    expect((await bare.prepareNonceLane()).status).toBe("unavailable");
    await expect(bare.broadcastNonceKill(lane)).rejects.toThrow(/kill/);
    expect(await bare.getFinalizedStatus("k")).toMatchObject({
      status: "unknown",
      reason: "rpc_error",
    });
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
