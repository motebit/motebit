/**
 * Spendable-mint allowlist — a wallet built with `spendableMints` refuses,
 * before the gas check and before anything is signed, to transfer in a mint
 * that is not on the list. Offline: fake adapters that count every call, and
 * a real `Web3JsRpcAdapter` with fetch and every signing door spied.
 *
 *   - Rail: `send` / `sendBatch` / `buildP2pPayment` throw
 *     `RailSpendRefusedError` before `getSolBalance` and before the adapter.
 *   - Adapter: `sendUsdc` / `sendUsdcBatch` / `sendUsdcDurable` repeat the
 *     refusal as their first statement.
 *   - An allowlist over an adapter that reports no mint refuses.
 *   - No allowlist ⇒ nothing changes.
 *   - `confirmSend` reads the refusal as `absent` (nothing was sent).
 *
 * Tamper: scripts/tampers/molecule-spend-containment.ts
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { Transaction, VersionedTransaction } from "@solana/web3.js";

import {
  SolanaWalletRail,
  Web3JsRpcAdapter,
  createSolanaWalletRail,
  RailSpendRefusedError,
  InsufficientUsdcBalanceError,
  isSpendRefused,
  USDC_MINT_DEVNET,
  USDC_MINT_MAINNET,
  type SolanaRpcAdapter,
} from "../index.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const SEED = new Uint8Array(32).fill(33);
const TO = "W11111111111111111111111111111111111111111";
const P2P_REQUEST = {
  workerAddress: TO,
  amountMicro: 500_000,
  treasuryAddress: "T11111111111111111111111111111111111111111",
  feeAmountMicro: 26_316,
};
const DEVNET_ONLY = [USDC_MINT_DEVNET];

/** A fake adapter that counts every read and every send. */
function countingAdapter(usdcMint: string | undefined) {
  const calls = { getSolBalance: 0, sendUsdc: 0, sendUsdcBatch: 0, findOutgoingTransfer: 0 };
  const adapter = {
    ownAddress: "FaKeSo1anaAddr1111111111111111111111111111",
    ...(usdcMint !== undefined ? { usdcMint } : {}),
    getUsdcBalance: async () => 100_000_000n,
    getUsdcBalanceOf: async () => 0n,
    getSolBalance: async () => {
      calls.getSolBalance++;
      return 10_000_000n;
    },
    sendUsdc: async () => {
      calls.sendUsdc++;
      return { signature: "sig-send", slot: 1, confirmed: true };
    },
    sendUsdcBatch: async (items: readonly unknown[]) => {
      calls.sendUsdcBatch++;
      return items.map(() => ({ ok: true, signature: "sig-batch", slot: 1, reason: null }));
    },
    getTransaction: async () => ({ status: "not_found" as const }),
    findOutgoingTransfer: async () => {
      calls.findOutgoingTransfer++;
      return { status: "not_found" as const };
    },
    isReachable: async () => true,
  } satisfies SolanaRpcAdapter;
  return { adapter, calls };
}

function expectNoAdapterCalls(calls: ReturnType<typeof countingAdapter>["calls"]): void {
  expect(calls.getSolBalance).toBe(0);
  expect(calls.sendUsdc).toBe(0);
  expect(calls.sendUsdcBatch).toBe(0);
}

async function refusal(run: () => Promise<unknown>): Promise<RailSpendRefusedError> {
  const err = await run().then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(RailSpendRefusedError);
  return err as RailSpendRefusedError;
}

describe("spendable-mint allowlist: the rail refuses before the gas check", () => {
  it("send is refused before getSolBalance is called", async () => {
    const { adapter, calls } = countingAdapter(USDC_MINT_MAINNET);
    const rail = new SolanaWalletRail(adapter, { spendableMints: DEVNET_ONLY });
    const err = await refusal(() => rail.send(TO, 1_000n));
    expect(err.code).toBe("rail_spend_refused");
    expect(err.name).toBe("RailSpendRefusedError");
    expect(err.mint).toBe(USDC_MINT_MAINNET);
    expect(err.spendableMints).toEqual(DEVNET_ONLY);
    expectNoAdapterCalls(calls);
  });

  it("sendBatch is refused before getSolBalance is called", async () => {
    const { adapter, calls } = countingAdapter(USDC_MINT_MAINNET);
    const rail = new SolanaWalletRail(adapter, { spendableMints: DEVNET_ONLY });
    await refusal(() => rail.sendBatch([{ toAddress: TO, microAmount: 1_000n }]));
    expectNoAdapterCalls(calls);
  });

  it("buildP2pPayment is refused before getSolBalance is called, and reports no signature", async () => {
    const { adapter, calls } = countingAdapter(USDC_MINT_MAINNET);
    const rail = new SolanaWalletRail(adapter, { spendableMints: DEVNET_ONLY });
    const beforeBroadcast = vi.fn();
    await refusal(() => rail.buildP2pPayment(P2P_REQUEST, { beforeBroadcast }));
    expect(beforeBroadcast).toHaveBeenCalledTimes(0);
    expectNoAdapterCalls(calls);
  });

  it("an allowlist over an adapter that reports no mint refuses every transfer", async () => {
    const { adapter, calls } = countingAdapter(undefined);
    const rail = new SolanaWalletRail(adapter, { spendableMints: DEVNET_ONLY });
    expect(rail.usdcMint).toBeUndefined();
    expect(rail.spendRefused).toBe(true);
    const err = await refusal(() => rail.send(TO, 1_000n));
    expect(err.mint).toBeNull();
    expect(err.message).toContain("not reported by the adapter");
    await refusal(() => rail.sendBatch([{ toAddress: TO, microAmount: 1_000n }]));
    await refusal(() => rail.buildP2pPayment(P2P_REQUEST));
    expectNoAdapterCalls(calls);
  });

  it("an empty allowlist refuses every mint", async () => {
    const { adapter, calls } = countingAdapter(USDC_MINT_DEVNET);
    const rail = new SolanaWalletRail(adapter, { spendableMints: [] });
    expect(rail.spendRefused).toBe(true);
    await refusal(() => rail.send(TO, 1_000n));
    expectNoAdapterCalls(calls);
  });

  it("a listed mint is not refused: the transfer reaches the adapter", async () => {
    const { adapter, calls } = countingAdapter(USDC_MINT_DEVNET);
    const rail = new SolanaWalletRail(adapter, { spendableMints: DEVNET_ONLY });
    expect(rail.spendRefused).toBe(false);
    expect(rail.usdcMint).toBe(USDC_MINT_DEVNET);
    await expect(rail.send(TO, 1_000n)).resolves.toMatchObject({ signature: "sig-send" });
    await rail.sendBatch([{ toAddress: TO, microAmount: 1_000n }]);
    await rail.buildP2pPayment(P2P_REQUEST);
    expect(calls.sendUsdc).toBe(1);
    expect(calls.sendUsdcBatch).toBe(2);
  });

  it("no allowlist is unrestricted: a mainnet-mint transfer reaches the adapter", async () => {
    const { adapter, calls } = countingAdapter(USDC_MINT_MAINNET);
    const rail = new SolanaWalletRail(adapter);
    expect(rail.spendableMints).toBeUndefined();
    expect(rail.spendRefused).toBe(false);
    await rail.send(TO, 1_000n);
    expect(calls.sendUsdc).toBe(1);
    // ...and so does a rail over an adapter that reports no mint at all.
    const bare = countingAdapter(undefined);
    const bareRail = new SolanaWalletRail(bare.adapter);
    expect(bareRail.spendRefused).toBe(false);
    await bareRail.send(TO, 1_000n);
    expect(bare.calls.sendUsdc).toBe(1);
  });

  it("the allowlist is a frozen copy taken at construction", async () => {
    const { adapter, calls } = countingAdapter(USDC_MINT_MAINNET);
    const source = [USDC_MINT_DEVNET];
    const rail = new SolanaWalletRail(adapter, { spendableMints: source });
    source.push(USDC_MINT_MAINNET); // widening the caller's array changes nothing
    expect(rail.spendableMints).toEqual(DEVNET_ONLY);
    expect(Object.isFrozen(rail.spendableMints)).toBe(true);
    expect(() => (rail.spendableMints as string[]).push(USDC_MINT_MAINNET)).toThrow(TypeError);
    await refusal(() => rail.send(TO, 1_000n));
    expectNoAdapterCalls(calls);
  });

  it("confirmSend reads a spend refusal as absent, without a lookup", async () => {
    const { adapter, calls } = countingAdapter(USDC_MINT_MAINNET);
    const rail = new SolanaWalletRail(adapter, { spendableMints: DEVNET_ONLY });
    const error = await refusal(() => rail.send(TO, 1_000n));
    const verdict = await rail.confirmSend({
      toAddress: TO,
      microAmount: 1_000n,
      sentAtMs: 1_000,
      failedAtMs: 1_001,
      error,
    });
    expect(verdict).toEqual({ status: "absent" });
    expect(calls.findOutgoingTransfer).toBe(0);
  });

  it("confirmSend reads a refusal from ANOTHER copy of the module (name + code, not instanceof) as absent", async () => {
    const { adapter, calls } = countingAdapter(USDC_MINT_MAINNET);
    const rail = new SolanaWalletRail(adapter, { spendableMints: DEVNET_ONLY });
    // What a second loaded copy of this package would throw: same name and
    // code, a different class object.
    const foreign = Object.assign(new Error("Spend refused before signing"), {
      name: "RailSpendRefusedError",
      code: "rail_spend_refused",
    });
    expect(foreign).not.toBeInstanceOf(RailSpendRefusedError);
    const query = { toAddress: TO, microAmount: 1_000n, sentAtMs: 1_000, failedAtMs: 1_001 };
    expect(await rail.confirmSend({ ...query, error: foreign })).toEqual({ status: "absent" });
    expect(calls.findOutgoingTransfer).toBe(0);
  });

  it("confirmSend does NOT read a name alone or a code alone as a refusal: it looks the transfer up", async () => {
    const { adapter, calls } = countingAdapter(USDC_MINT_MAINNET);
    const rail = new SolanaWalletRail(adapter, { spendableMints: DEVNET_ONLY, now: () => 1_002 });
    const query = { toAddress: TO, microAmount: 1_000n, sentAtMs: 1_000, failedAtMs: 1_001 };
    const nameOnly = Object.assign(new Error("x"), { name: "RailSpendRefusedError" });
    const codeOnly = Object.assign(new Error("x"), { code: "rail_spend_refused" });
    expect((await rail.confirmSend({ ...query, error: nameOnly })).status).toBe("pending");
    expect((await rail.confirmSend({ ...query, error: codeOnly })).status).toBe("pending");
    expect((await rail.confirmSend({ ...query, error: "rail_spend_refused" })).status).toBe(
      "pending",
    );
    expect((await rail.confirmSend({ ...query, error: null })).status).toBe("pending");
    expect(calls.findOutgoingTransfer).toBe(4);
  });
});

describe("spendable-mint allowlist: the web3 adapter repeats the refusal", () => {
  /** A real adapter with fetch and every signing door spied. */
  function realAdapter(config: { usdcMint?: string; spendableMints?: readonly string[] }) {
    const fetchSpy = vi.fn(async () => {
      throw new Error("network is not allowed in this test");
    });
    vi.stubGlobal("fetch", fetchSpy);
    const signs = [
      vi.spyOn(VersionedTransaction.prototype, "sign"),
      vi.spyOn(Transaction.prototype, "sign"),
      vi.spyOn(Transaction.prototype, "partialSign"),
    ];
    const adapter = new Web3JsRpcAdapter({
      rpcUrl: "http://127.0.0.1:1",
      identitySeed: SEED,
      ...config,
    });
    const balance = vi.spyOn(adapter, "getUsdcBalance").mockResolvedValue(0n);
    const expectUntouched = (): void => {
      expect(fetchSpy).toHaveBeenCalledTimes(0);
      expect(balance).toHaveBeenCalledTimes(0);
      for (const s of signs) expect(s).toHaveBeenCalledTimes(0);
    };
    return { adapter, balance, expectUntouched };
  }

  it("reports the PARSED mint: the mainnet default, or the configured one", () => {
    expect(realAdapter({}).adapter.usdcMint).toBe(USDC_MINT_MAINNET);
    expect(realAdapter({ usdcMint: USDC_MINT_DEVNET }).adapter.usdcMint).toBe(USDC_MINT_DEVNET);
  });

  it("sendUsdc is refused before any read or signature", async () => {
    const { adapter, expectUntouched } = realAdapter({ spendableMints: DEVNET_ONLY });
    const err = await refusal(() => adapter.sendUsdc({ toAddress: TO, microAmount: 1_000n }));
    expect(err.mint).toBe(USDC_MINT_MAINNET);
    expectUntouched();
  });

  it("sendUsdcBatch is refused before any read or signature", async () => {
    const { adapter, expectUntouched } = realAdapter({ spendableMints: DEVNET_ONLY });
    await refusal(() =>
      adapter.sendUsdcBatch([
        { toAddress: TO, microAmount: 1_000n },
        { toAddress: TO, microAmount: 2_000n },
      ]),
    );
    // Refused even with nothing to send: the check is the first statement.
    await refusal(() => adapter.sendUsdcBatch([]));
    expectUntouched();
  });

  it("sendUsdcDurable is refused before any read or signature", async () => {
    const { adapter, expectUntouched } = realAdapter({ spendableMints: DEVNET_ONLY });
    const beforeBroadcast = vi.fn();
    await refusal(() =>
      adapter.sendUsdcDurable(
        { toAddress: TO, microAmount: 1_000n },
        { account: TO, nonceValue: TO },
        { beforeBroadcast },
      ),
    );
    expect(beforeBroadcast).toHaveBeenCalledTimes(0);
    expectUntouched();
  });

  it("a listed mint passes the adapter check (the next refusal is the balance)", async () => {
    const { adapter, balance } = realAdapter({
      usdcMint: USDC_MINT_DEVNET,
      spendableMints: DEVNET_ONLY,
    });
    await expect(
      adapter.sendUsdc({ toAddress: adapter.ownAddress, microAmount: 1_000n }),
    ).rejects.toBeInstanceOf(InsufficientUsdcBalanceError);
    expect(balance).toHaveBeenCalledTimes(1);
  });

  it("the adapter's allowlist is a copy: widening the caller's array changes nothing", async () => {
    const source = [USDC_MINT_DEVNET];
    const { adapter, expectUntouched } = realAdapter({ spendableMints: source });
    source.push(USDC_MINT_MAINNET);
    await refusal(() => adapter.sendUsdc({ toAddress: TO, microAmount: 1_000n }));
    expectUntouched();
  });

  it("createSolanaWalletRail binds the allowlist to the rail AND to its adapter", async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error("network is not allowed in this test");
    });
    vi.stubGlobal("fetch", fetchSpy);
    const rail = createSolanaWalletRail({
      rpcUrl: "http://127.0.0.1:1",
      identitySeed: SEED,
      spendableMints: DEVNET_ONLY,
    });
    expect(rail.spendableMints).toEqual(DEVNET_ONLY);
    expect(rail.usdcMint).toBe(USDC_MINT_MAINNET);
    expect(rail.spendRefused).toBe(true);
    await refusal(() => rail.send(TO, 1_000n));
    // The adapter the factory built refuses on its own, reached directly.
    const inner = (rail as unknown as { adapter: SolanaRpcAdapter }).adapter;
    await refusal(() => inner.sendUsdc({ toAddress: TO, microAmount: 1_000n }));
    expect(fetchSpy).toHaveBeenCalledTimes(0);

    // The same factory with the devnet mint is not refused; without an
    // allowlist it is unrestricted, as before.
    const devnet = createSolanaWalletRail({
      rpcUrl: "http://127.0.0.1:1",
      identitySeed: SEED,
      usdcMint: USDC_MINT_DEVNET,
      spendableMints: DEVNET_ONLY,
    });
    expect(devnet.spendRefused).toBe(false);
    const open = createSolanaWalletRail({ rpcUrl: "http://127.0.0.1:1", identitySeed: SEED });
    expect(open.spendableMints).toBeUndefined();
    expect(open.spendRefused).toBe(false);
  });
});

describe("isSpendRefused", () => {
  it("no allowlist never refuses; an allowlist refuses an unlisted or unreported mint", () => {
    expect(isSpendRefused(undefined, USDC_MINT_MAINNET)).toBe(false);
    expect(isSpendRefused(undefined, undefined)).toBe(false);
    expect(isSpendRefused(DEVNET_ONLY, USDC_MINT_DEVNET)).toBe(false);
    expect(isSpendRefused(DEVNET_ONLY, USDC_MINT_MAINNET)).toBe(true);
    expect(isSpendRefused(DEVNET_ONLY, undefined)).toBe(true);
    expect(isSpendRefused([], USDC_MINT_DEVNET)).toBe(true);
  });
});
