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
  // rail.ts statically imports the gas-floor constant from the same
  // module (single-source since the swapSolToUsdc mirror landed) — the
  // mock must carry it or every rail test fails at import time.
  GAS_FLOOR_LAMPORTS: 5_000_000n,
}));

import {
  SolanaWalletRail,
  type SolanaRpcAdapter,
  type SendUsdcArgs,
  InsufficientUsdcBalanceError,
  InvalidSolanaAddressError,
  Web3JsRpcAdapter,
  createSolanaWalletRail,
  SOLANA_TX_LANDING_HORIZON_MS,
} from "../index.js";

beforeEach(() => {
  swapUsdcToSolMock.mockReset();
});

function makeAdapter(overrides: Partial<SolanaRpcAdapter> = {}): SolanaRpcAdapter {
  return {
    ownAddress: "11111111111111111111111111111111",
    getUsdcBalance: vi.fn().mockResolvedValue(0n),
    getUsdcBalanceOf: vi.fn().mockResolvedValue(0n),
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

// ── buildP2pPayment (the delegator-client P2P proof capability) ──────────

describe("SolanaWalletRail.buildP2pPayment", () => {
  it("broadcasts a 2-leg proof (worker + relay fee) in one atomic tx", async () => {
    const sendUsdcBatch = vi.fn().mockResolvedValue([
      { ok: true, signature: "atomic-sig", slot: 5, reason: null },
      { ok: true, signature: "atomic-sig", slot: 5, reason: null },
    ]);
    const rail = new SolanaWalletRail(makeAdapter({ sendUsdcBatch }));

    const proof = await rail.buildP2pPayment({
      workerAddress: "Worker1111111111111111111111111111111111111",
      amountMicro: 500_000,
      treasuryAddress: "Treasury11111111111111111111111111111111111",
      feeAmountMicro: 26_316,
    });

    // One atomic batch carrying exactly two legs.
    expect(sendUsdcBatch).toHaveBeenCalledTimes(1);
    expect(sendUsdcBatch.mock.calls[0]?.[0]).toHaveLength(2);
    expect(proof.tx_hash).toBe("atomic-sig");
    expect(proof.to_address).toBe("Worker1111111111111111111111111111111111111");
    expect(proof.amount_micro).toBe(500_000);
    expect(proof.fee_to_address).toBe("Treasury11111111111111111111111111111111111");
    expect(proof.fee_amount_micro).toBe(26_316);
    // Single-operator P2P carries no executor (B) fee leg.
    expect(proof.b_fee_to_address).toBeUndefined();
    expect(proof.b_fee_amount_micro).toBeUndefined();
  });

  it("broadcasts a 3-leg proof for cross-operator federated P2P", async () => {
    const sendUsdcBatch = vi.fn().mockResolvedValue([
      { ok: true, signature: "fed-sig", slot: 9, reason: null },
      { ok: true, signature: "fed-sig", slot: 9, reason: null },
      { ok: true, signature: "fed-sig", slot: 9, reason: null },
    ]);
    const rail = new SolanaWalletRail(makeAdapter({ sendUsdcBatch }));

    const proof = await rail.buildP2pPayment({
      workerAddress: "Worker1111111111111111111111111111111111111",
      amountMicro: 902_500,
      treasuryAddress: "TreasuryA1111111111111111111111111111111111",
      feeAmountMicro: 50_000,
      executorTreasuryAddress: "TreasuryB1111111111111111111111111111111111",
      executorFeeAmountMicro: 47_500,
      network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
    });

    expect(sendUsdcBatch.mock.calls[0]?.[0]).toHaveLength(3);
    expect(proof.tx_hash).toBe("fed-sig");
    expect(proof.b_fee_to_address).toBe("TreasuryB1111111111111111111111111111111111");
    expect(proof.b_fee_amount_micro).toBe(47_500);
    expect(proof.network).toBe("solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1");
  });

  it("runs the gas check before broadcasting when autoGas is enabled", async () => {
    const sendUsdcBatch = vi.fn().mockResolvedValue([
      { ok: true, signature: "s", slot: 1, reason: null },
      { ok: true, signature: "s", slot: 1, reason: null },
    ]);
    // Low SOL → ensureGas runs; with a non-web3 mock adapter it returns false
    // without throwing, and the broadcast still proceeds (honest degradation).
    const getSolBalance = vi.fn().mockResolvedValue(0n);
    const rail = new SolanaWalletRail(makeAdapter({ sendUsdcBatch, getSolBalance }), {
      autoGas: true,
    });

    await rail.buildP2pPayment({
      workerAddress: "W11111111111111111111111111111111111111111",
      amountMicro: 1,
      treasuryAddress: "T11111111111111111111111111111111111111111",
      feeAmountMicro: 1,
    });

    expect(getSolBalance).toHaveBeenCalled();
    expect(sendUsdcBatch).toHaveBeenCalledTimes(1);
  });
});

describe("SolanaWalletRail.swapSolToUsdc — the owner-invoked funding-side swap", () => {
  it("throws honestly when the rail has no web3 adapter", async () => {
    const adapter: SolanaRpcAdapter = {
      getSolBalance: async () => 0n,
      getUsdcBalance: async () => 0n,
      sendUsdc: async () => ({ signature: "x" }) as never,
    } as never;
    const rail = new SolanaWalletRail(adapter, { autoGas: false });
    await expect(rail.swapSolToUsdc(1_000_000n)).rejects.toThrow(/without a web3 adapter/);
  });
});

// ── #887: confirmSend — a thrown send is not proof that nothing moved ──

describe("SolanaWalletRail.confirmSend", () => {
  const base = {
    toAddress: "Worker111",
    microAmount: 250_000n,
    sentAtMs: 1_000,
    failedAtMs: 2_000,
    error: new Error("confirmation timed out"),
  };

  it("a landed matching transfer ⇒ landed with its signature; own payments excluded", async () => {
    const find = vi.fn().mockResolvedValue({ status: "found", signature: "sigX" });
    const rail = new SolanaWalletRail(makeAdapter({ findOutgoingTransfer: find }), {
      now: () => 2_500,
    });
    await expect(rail.confirmSend({ ...base, excludeSignatures: ["old"] })).resolves.toEqual({
      status: "landed",
      signature: "sigX",
    });
    expect(find).toHaveBeenCalledWith({
      toAddress: "Worker111",
      microAmount: 250_000n,
      sinceMs: 1_000,
      excludeSignatures: ["old"],
    });
  });

  it("no match while a broadcast could still land ⇒ pending until the landing horizon", async () => {
    const rail = new SolanaWalletRail(
      makeAdapter({ findOutgoingTransfer: vi.fn().mockResolvedValue({ status: "not_found" }) }),
      { now: () => 2_000 + SOLANA_TX_LANDING_HORIZON_MS - 1 },
    );
    await expect(rail.confirmSend(base)).resolves.toEqual({
      status: "pending",
      recheckAtMs: 2_000 + SOLANA_TX_LANDING_HORIZON_MS,
    });
  });

  it("no match after the landing horizon ⇒ absent (authoritative)", async () => {
    const rail = new SolanaWalletRail(
      makeAdapter({ findOutgoingTransfer: vi.fn().mockResolvedValue({ status: "not_found" }) }),
      { now: () => 2_000 + SOLANA_TX_LANDING_HORIZON_MS },
    );
    await expect(rail.confirmSend(base)).resolves.toEqual({ status: "absent" });
  });

  it.each([
    [{ status: "ambiguous", signatures: ["a", "b"] }, /2 matching transfers/],
    [{ status: "rpc_error", reason: "ECONNRESET" }, /ECONNRESET/],
  ])("an undecidable lookup (%o) ⇒ unknown, never absent", async (lookup, reason) => {
    const rail = new SolanaWalletRail(
      makeAdapter({ findOutgoingTransfer: vi.fn().mockResolvedValue(lookup) }),
      { now: () => Number.MAX_SAFE_INTEGER },
    );
    const v = await rail.confirmSend(base);
    expect(v.status).toBe("unknown");
    expect(v.status === "unknown" ? v.reason : "").toMatch(reason);
  });

  it("an adapter without the lookup ⇒ unknown (fail-closed)", async () => {
    const rail = new SolanaWalletRail(makeAdapter(), { now: () => Number.MAX_SAFE_INTEGER });
    await expect(rail.confirmSend(base)).resolves.toMatchObject({ status: "unknown" });
  });

  it.each([
    ["InsufficientUsdcBalanceError", new InsufficientUsdcBalanceError(0n, 250_000n)],
    ["InvalidSolanaAddressError", new InvalidSolanaAddressError("bad")],
  ])("%s is thrown only before signing ⇒ absent without a lookup", async (_n, error) => {
    const find = vi.fn();
    const rail = new SolanaWalletRail(makeAdapter({ findOutgoingTransfer: find }), {
      now: () => 0,
    });
    await expect(rail.confirmSend({ ...base, error })).resolves.toEqual({ status: "absent" });
    expect(find).not.toHaveBeenCalled();
  });

  it("an error that merely MENTIONS insufficient funds is not treated as pre-broadcast", async () => {
    const rail = new SolanaWalletRail(
      makeAdapter({ findOutgoingTransfer: vi.fn().mockResolvedValue({ status: "not_found" }) }),
      { now: () => 2_000 },
    );
    await expect(
      rail.confirmSend({
        ...base,
        error: new Error("Insufficient USDC balance (after broadcast)"),
      }),
    ).resolves.toMatchObject({ status: "pending" });
  });
});

// ── #885: buildP2pPayment reports each signed tx BEFORE it is sent ──

describe("SolanaWalletRail.buildP2pPayment — beforeBroadcast", () => {
  const request = {
    workerAddress: "Worker111",
    amountMicro: 250_000,
    treasuryAddress: "Treasury111",
    feeAmountMicro: 12_500,
  };

  it("hands the hooks to the adapter's atomic batch", async () => {
    const sendUsdcBatch = vi.fn().mockResolvedValue([
      { ok: true, signature: "s", slot: 1, reason: null },
      { ok: true, signature: "s", slot: 1, reason: null },
    ]);
    const rail = new SolanaWalletRail(makeAdapter({ sendUsdcBatch }));
    const hooks = { beforeBroadcast: vi.fn() };
    await rail.buildP2pPayment(request, hooks);
    expect(sendUsdcBatch.mock.calls[0]?.[1]).toBe(hooks);
  });
});

// ── #885: confirmP2pPayment — bound to THIS payer's own signature ──

describe("SolanaWalletRail.confirmP2pPayment", () => {
  const request = {
    workerAddress: "Worker111",
    amountMicro: 250_000,
    treasuryAddress: "Treasury111",
    feeAmountMicro: 12_500,
  };
  const OWN = "11111111111111111111111111111111";
  const transaction = { signature: "mySig", lastValidBlockHeight: 1_000 };
  const exact = {
    status: "confirmed",
    from: OWN,
    transfers: [
      { to: "Worker111", amountMicro: 250_000n },
      { to: "Treasury111", amountMicro: 12_500n },
    ],
    slot: 9,
    asset: "USDC",
  };

  it("asks about ITS OWN signature only, and a landed exact tx is its proof", async () => {
    const getSignatureOutcome = vi.fn().mockResolvedValue({ status: "landed", slot: 9 });
    const getTransaction = vi.fn().mockResolvedValue(exact);
    const findOutgoingTransfer = vi.fn();
    const rail = new SolanaWalletRail(
      makeAdapter({ getSignatureOutcome, getTransaction, findOutgoingTransfer }),
    );
    await expect(rail.confirmP2pPayment({ request, transaction })).resolves.toEqual({
      status: "landed",
      proof: {
        tx_hash: "mySig",
        chain: "solana",
        network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
        to_address: "Worker111",
        amount_micro: 250_000,
        fee_to_address: "Treasury111",
        fee_amount_micro: 12_500,
      },
    });
    expect(getSignatureOutcome).toHaveBeenCalledWith(transaction);
    expect(getTransaction).toHaveBeenCalledWith("mySig");
    // Never attribution by matching transfers.
    expect(findOutgoingTransfer).not.toHaveBeenCalled();
  });

  it.each([
    ["a different worker amount", [{ to: "Worker111", amountMicro: 1n }, exact.transfers[1]]],
    ["a missing fee leg", [exact.transfers[0]]],
    ["an extra leg", [...exact.transfers, { to: "Elsewhere", amountMicro: 1n }]],
  ])("landed but %s ⇒ unknown, never a proof", async (_n, transfers) => {
    const rail = new SolanaWalletRail(
      makeAdapter({
        getSignatureOutcome: vi.fn().mockResolvedValue({ status: "landed", slot: 9 }),
        getTransaction: vi.fn().mockResolvedValue({ ...exact, transfers }),
      }),
    );
    await expect(rail.confirmP2pPayment({ request, transaction })).resolves.toMatchObject({
      status: "unknown",
    });
  });

  it("landed but from another payer, or unreadable ⇒ unknown", async () => {
    const other = new SolanaWalletRail(
      makeAdapter({
        getSignatureOutcome: vi.fn().mockResolvedValue({ status: "landed", slot: 9 }),
        getTransaction: vi.fn().mockResolvedValue({ ...exact, from: "Someone" }),
      }),
    );
    await expect(other.confirmP2pPayment({ request, transaction })).resolves.toMatchObject({
      status: "unknown",
    });
    const unread = new SolanaWalletRail(
      makeAdapter({
        getSignatureOutcome: vi.fn().mockResolvedValue({ status: "landed", slot: 9 }),
        getTransaction: vi.fn().mockResolvedValue({ status: "rpc_error", reason: "boom" }),
      }),
    );
    await expect(unread.confirmP2pPayment({ request, transaction })).resolves.toMatchObject({
      status: "unknown",
    });
  });

  it.each([["expired"], ["failed"]])("%s ⇒ absent (it can never move money)", async (s) => {
    const rail = new SolanaWalletRail(
      makeAdapter({ getSignatureOutcome: vi.fn().mockResolvedValue({ status: s }) }),
    );
    await expect(rail.confirmP2pPayment({ request, transaction })).resolves.toEqual({
      status: "absent",
    });
  });

  it("pending ⇒ pending with a recheck time; rpc_error ⇒ unknown", async () => {
    const pending = new SolanaWalletRail(
      makeAdapter({ getSignatureOutcome: vi.fn().mockResolvedValue({ status: "pending" }) }),
      { now: () => 1_000 },
    );
    await expect(pending.confirmP2pPayment({ request, transaction })).resolves.toEqual({
      status: "pending",
      recheckAtMs: 6_000,
    });
    const rpc = new SolanaWalletRail(
      makeAdapter({
        getSignatureOutcome: vi.fn().mockResolvedValue({ status: "rpc_error", reason: "429" }),
      }),
    );
    await expect(rpc.confirmP2pPayment({ request, transaction })).resolves.toEqual({
      status: "unknown",
      reason: "429",
    });
  });

  it("an adapter without the status read ⇒ unknown (fail-closed)", async () => {
    const rail = new SolanaWalletRail(makeAdapter());
    await expect(rail.confirmP2pPayment({ request, transaction })).resolves.toMatchObject({
      status: "unknown",
    });
  });
});
