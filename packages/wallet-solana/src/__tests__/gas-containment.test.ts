/**
 * Gas containment — the automatic USDC → SOL top-up can no longer sign a
 * Jupiter-built transaction, and a transfer the wallet cannot pay the fee for
 * fails closed BEFORE anything is signed. Offline: the REAL jupiter module
 * (no module mock), a real `Web3JsRpcAdapter` with its RPC reads stubbed, and
 * spies on every signing and broadcast door.
 *
 *   - `ensureGas` below the floor returns false, with no Jupiter call and no
 *     signature — through the factory (autoGas off) AND through the legacy
 *     `autoGas: true` constructor path (which reaches only the refusal).
 *   - `send` / `sendBatch` / `buildP2pPayment` below the floor throw
 *     `InsufficientSolForGasError`; nothing is signed or broadcast and the
 *     mock ledger is unchanged.
 *   - The same three with sufficient SOL behave as before.
 *   - The factory default is autoGas off; `disableAutoGas: false` cannot turn
 *     it on.
 *
 * Tamper: packages/wallet-solana/src/__tests__/jupiter-containment.tampers.mjs
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { Transaction, VersionedTransaction } from "@solana/web3.js";

import {
  SolanaWalletRail,
  Web3JsRpcAdapter,
  createSolanaWalletRail,
  InsufficientSolForGasError,
  JupiterSwapDisabledError,
  GAS_FLOOR_LAMPORTS,
  type SolanaRpcAdapter,
  type SendUsdcArgs,
} from "../index.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const SEED = new Uint8Array(32).fill(21);
const P2P_REQUEST = {
  workerAddress: "W11111111111111111111111111111111111111111",
  amountMicro: 500_000,
  treasuryAddress: "T11111111111111111111111111111111111111111",
  feeAmountMicro: 26_316,
};

/** Spies on every door a swap or a transfer would sign or broadcast through. */
function spyDoors() {
  const fetchSpy = vi.fn(async () => {
    throw new Error("network is not allowed in this test");
  });
  vi.stubGlobal("fetch", fetchSpy);
  return {
    fetchSpy,
    versionedSign: vi.spyOn(VersionedTransaction.prototype, "sign"),
    legacySign: vi.spyOn(Transaction.prototype, "sign"),
    legacyPartialSign: vi.spyOn(Transaction.prototype, "partialSign"),
  };
}

function expectNothingSigned(d: ReturnType<typeof spyDoors>): void {
  expect(d.fetchSpy).toHaveBeenCalledTimes(0);
  expect(d.versionedSign).toHaveBeenCalledTimes(0);
  expect(d.legacySign).toHaveBeenCalledTimes(0);
  expect(d.legacyPartialSign).toHaveBeenCalledTimes(0);
}

/** A real Web3JsRpcAdapter whose RPC reads and writes are stubbed. */
function web3Adapter(solLamports: bigint) {
  const adapter = new Web3JsRpcAdapter({ rpcUrl: "http://127.0.0.1:1", identitySeed: SEED });
  vi.spyOn(adapter, "getSolBalance").mockResolvedValue(solLamports);
  const connection = adapter.getConnection();
  const sendRaw = vi.spyOn(connection, "sendRawTransaction").mockRejectedValue(new Error("no"));
  const sendTx = vi.spyOn(connection, "sendTransaction").mockRejectedValue(new Error("no"));
  return { adapter, sendRaw, sendTx };
}

/** A fake adapter over a tiny in-memory ledger, so "balances unchanged" is checkable. */
function ledgerAdapter(solLamports: bigint) {
  const ledger = { usdc: 10_000_000n, sol: solLamports, broadcasts: 0 };
  const debit = (micro: bigint): void => {
    ledger.usdc -= micro;
    ledger.sol -= 5_000n;
    ledger.broadcasts += 1;
  };
  const adapter: SolanaRpcAdapter = {
    ownAddress: "11111111111111111111111111111111",
    getUsdcBalance: vi.fn(async () => ledger.usdc),
    getUsdcBalanceOf: vi.fn(async () => 0n),
    getSolBalance: vi.fn(async () => ledger.sol),
    sendUsdc: vi.fn(async (args: SendUsdcArgs) => {
      debit(args.microAmount);
      return { signature: "sig-send", slot: 1, confirmed: true };
    }),
    sendUsdcBatch: vi.fn(async (items: ReadonlyArray<{ microAmount: bigint }>) => {
      for (const i of items) debit(i.microAmount);
      return items.map(() => ({ ok: true, signature: "sig-batch", slot: 1, reason: null }));
    }),
    getTransaction: vi.fn(async () => ({ status: "not_found" as const })),
    isReachable: vi.fn(async () => true),
  } as unknown as SolanaRpcAdapter;
  return { adapter, ledger };
}

describe("ensureGas below the floor never reaches a Jupiter signature", () => {
  it("legacy autoGas: true — ensureGas returns false; no fetch, no signature, no broadcast", async () => {
    const doors = spyDoors();
    const { adapter, sendRaw, sendTx } = web3Adapter(0n);
    const rail = new SolanaWalletRail(adapter, { autoGas: true });
    expect(await rail.ensureGas()).toBe(false);
    expectNothingSigned(doors);
    expect(sendRaw).toHaveBeenCalledTimes(0);
    expect(sendTx).toHaveBeenCalledTimes(0);
  });

  it("legacy autoGas: true — the refusal precedes any keypair read", async () => {
    const doors = spyDoors();
    const { adapter } = web3Adapter(0n);
    const keypairReads = vi.spyOn(adapter, "getKeypair");
    const rail = new SolanaWalletRail(adapter, { autoGas: true });
    expect(await rail.ensureGas()).toBe(false);
    expect(keypairReads).toHaveBeenCalledTimes(0);
    expectNothingSigned(doors);
  });

  it("rail.swapSolToUsdc refuses before any keypair read; no fetch, no signature", async () => {
    const doors = spyDoors();
    const { adapter, sendRaw } = web3Adapter(10_000_000_000n);
    const keypairReads = vi.spyOn(adapter, "getKeypair");
    const rail = new SolanaWalletRail(adapter);
    const err = await rail.swapSolToUsdc(1_000_000n).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(JupiterSwapDisabledError);
    expect((err as JupiterSwapDisabledError).code).toBe("jupiter_swap_disabled");
    expect(keypairReads).toHaveBeenCalledTimes(0);
    expect(sendRaw).toHaveBeenCalledTimes(0);
    expectNothingSigned(doors);
  });

  it("factory rail — ensureGas returns false; no fetch, no signature, no broadcast", async () => {
    const doors = spyDoors();
    const rail = createSolanaWalletRail({ rpcUrl: "http://127.0.0.1:1", identitySeed: SEED });
    const adapter = (rail as unknown as { adapter: Web3JsRpcAdapter }).adapter;
    vi.spyOn(adapter, "getSolBalance").mockResolvedValue(GAS_FLOOR_LAMPORTS - 1n);
    expect(await rail.ensureGas()).toBe(false);
    expectNothingSigned(doors);
  });
});

describe("transfers below the gas floor fail closed before signing", () => {
  it("send throws InsufficientSolForGasError; nothing broadcast; balances unchanged", async () => {
    const doors = spyDoors();
    const { adapter, ledger } = ledgerAdapter(GAS_FLOOR_LAMPORTS - 1n);
    const rail = new SolanaWalletRail(adapter, { autoGas: true });
    const err = await rail.send("Dest1111111111111111111111111111111111111111", 100n).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(InsufficientSolForGasError);
    expect((err as InsufficientSolForGasError).code).toBe("insufficient_sol_for_gas");
    expect((err as Error).message).toMatch(/Fund this wallet's address with SOL directly/);
    expect(adapter.sendUsdc).not.toHaveBeenCalled();
    expect(ledger).toEqual({ usdc: 10_000_000n, sol: GAS_FLOOR_LAMPORTS - 1n, broadcasts: 0 });
    expectNothingSigned(doors);
  });

  it("sendBatch throws InsufficientSolForGasError; nothing broadcast; balances unchanged", async () => {
    const doors = spyDoors();
    const { adapter, ledger } = ledgerAdapter(0n);
    const rail = new SolanaWalletRail(adapter);
    await expect(
      rail.sendBatch([
        { toAddress: "D1111111111111111111111111111111111111111111", microAmount: 1n },
      ]),
    ).rejects.toBeInstanceOf(InsufficientSolForGasError);
    expect(adapter.sendUsdcBatch).not.toHaveBeenCalled();
    expect(ledger).toEqual({ usdc: 10_000_000n, sol: 0n, broadcasts: 0 });
    expectNothingSigned(doors);
  });

  it("buildP2pPayment throws InsufficientSolForGasError; nothing broadcast; balances unchanged", async () => {
    const doors = spyDoors();
    const { adapter, ledger } = ledgerAdapter(0n);
    const beforeBroadcast = vi.fn();
    const rail = new SolanaWalletRail(adapter, { autoGas: true });
    await expect(rail.buildP2pPayment(P2P_REQUEST, { beforeBroadcast })).rejects.toBeInstanceOf(
      InsufficientSolForGasError,
    );
    expect(adapter.sendUsdcBatch).not.toHaveBeenCalled();
    expect(beforeBroadcast).not.toHaveBeenCalled();
    expect(ledger).toEqual({ usdc: 10_000_000n, sol: 0n, broadcasts: 0 });
    expectNothingSigned(doors);
  });

  it("over the real adapter: send below the floor signs and broadcasts nothing", async () => {
    const doors = spyDoors();
    const { adapter, sendRaw, sendTx } = web3Adapter(0n);
    const sendUsdc = vi.spyOn(adapter, "sendUsdc");
    const rail = createSolanaWalletRail({ rpcUrl: "http://127.0.0.1:1", identitySeed: SEED });
    (rail as unknown as { adapter: Web3JsRpcAdapter }).adapter = adapter;
    await expect(
      rail.send("Dest1111111111111111111111111111111111111111", 100n),
    ).rejects.toBeInstanceOf(InsufficientSolForGasError);
    expect(sendUsdc).not.toHaveBeenCalled();
    expect(sendRaw).toHaveBeenCalledTimes(0);
    expect(sendTx).toHaveBeenCalledTimes(0);
    expectNothingSigned(doors);
  });

  it("a send refused for gas is authoritatively not paid (confirmSend ⇒ absent)", async () => {
    const { adapter } = ledgerAdapter(0n);
    const rail = new SolanaWalletRail(adapter);
    const error = await rail.send("Dest1111111111111111111111111111111111111111", 1n).then(
      () => null,
      (e: unknown) => e,
    );
    const verdict = await rail.confirmSend({
      toAddress: "Dest1111111111111111111111111111111111111111",
      microAmount: 1n,
      sentAtMs: 0,
      failedAtMs: 0,
      error,
    });
    expect(verdict).toEqual({ status: "absent" });
  });
});

describe("transfers with sufficient SOL behave as before", () => {
  it("send at the floor broadcasts exactly once", async () => {
    const { adapter, ledger } = ledgerAdapter(GAS_FLOOR_LAMPORTS);
    const rail = new SolanaWalletRail(adapter);
    const res = await rail.send("Dest1111111111111111111111111111111111111111", 100n);
    expect(res.signature).toBe("sig-send");
    expect(ledger.broadcasts).toBe(1);
    expect(ledger.usdc).toBe(10_000_000n - 100n);
  });

  it("sendBatch with sufficient SOL broadcasts the batch", async () => {
    const { adapter, ledger } = ledgerAdapter(10_000_000n);
    const rail = new SolanaWalletRail(adapter);
    const res = await rail.sendBatch([
      { toAddress: "D1111111111111111111111111111111111111111111", microAmount: 2n },
      { toAddress: "E1111111111111111111111111111111111111111111", microAmount: 3n },
    ]);
    expect(res).toHaveLength(2);
    expect(ledger.broadcasts).toBe(2);
    expect(ledger.usdc).toBe(10_000_000n - 5n);
  });

  it("buildP2pPayment with sufficient SOL returns the proof", async () => {
    const { adapter, ledger } = ledgerAdapter(10_000_000n);
    const rail = new SolanaWalletRail(adapter);
    const proof = await rail.buildP2pPayment(P2P_REQUEST);
    expect(proof.tx_hash).toBe("sig-batch");
    expect(proof.amount_micro).toBe(500_000);
    expect(proof.fee_amount_micro).toBe(26_316);
    expect(ledger.usdc).toBe(10_000_000n - 500_000n - 26_316n);
  });
});

describe("the factory cannot turn automatic gas back on", () => {
  for (const disableAutoGas of [undefined, false, true]) {
    it(`disableAutoGas: ${String(disableAutoGas)} ⇒ autoGas off, ensureGas false below the floor, nothing signed`, async () => {
      const doors = spyDoors();
      const rail = createSolanaWalletRail({
        rpcUrl: "http://127.0.0.1:1",
        identitySeed: SEED,
        ...(disableAutoGas === undefined ? {} : { disableAutoGas }),
      });
      expect((rail as unknown as { autoGas: boolean }).autoGas).toBe(false);
      const adapter = (rail as unknown as { adapter: Web3JsRpcAdapter }).adapter;
      vi.spyOn(adapter, "getSolBalance").mockResolvedValue(0n);
      expect(await rail.ensureGas()).toBe(false);
      expectNothingSigned(doors);
    });
  }
});
