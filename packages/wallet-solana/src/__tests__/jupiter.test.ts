/**
 * Jupiter swap adapter tests — pin the error-surface contract at the
 * boundary between the wallet and Jupiter's HTTP API.
 *
 * The happy path requires signing a real VersionedTransaction returned
 * by Jupiter, which we don't exercise here. The error branches are
 * what callers will actually pattern-match on, so those are what we
 * lock in: quote failure and swap failure each throw a labeled Error
 * with the upstream HTTP status, so higher layers can distinguish
 * "Jupiter is down" from "the signed tx was rejected."
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { Keypair, Connection, VersionedTransaction } from "@solana/web3.js";

import { swapUsdcToSol, swapSolToUsdc } from "../jupiter.js";

const ZERO_SEED = new Uint8Array(32);

function makeKeypairAndConnection(): { keypair: Keypair; connection: Connection } {
  return {
    keypair: Keypair.fromSeed(ZERO_SEED),
    connection: new Connection("https://api.devnet.solana.com"),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("swapUsdcToSol", () => {
  it("throws a labeled error when the Jupiter quote endpoint returns a non-OK HTTP status", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 503 });
    vi.stubGlobal("fetch", fetchMock);

    // Pass explicit commitment and usdcMint (devnet USDC) so the non-default
    // arms of those parameters are exercised — the swap code is already
    // used from devnet in integration harnesses, and the default-mainnet
    // path shouldn't be the only one under test.
    const { keypair, connection } = makeKeypairAndConnection();
    const DEVNET_USDC = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
    await expect(
      swapUsdcToSol(20_000n, keypair, connection, "finalized", DEVNET_USDC),
    ).rejects.toThrow(/Jupiter quote failed: HTTP 503/);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Confirm the explicit mint made it into the quote URL.
    const quoteCall = fetchMock.mock.calls[0];
    expect(quoteCall).toBeDefined();
    const quoteUrl = quoteCall![0] as string;
    expect(quoteUrl).toContain(`inputMint=${DEVNET_USDC}`);
  });

  it("throws a labeled error when the Jupiter swap endpoint returns a non-OK HTTP status", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ outAmount: "100000" }),
      })
      .mockResolvedValueOnce({ ok: false, status: 429 });
    vi.stubGlobal("fetch", fetchMock);

    const { keypair, connection } = makeKeypairAndConnection();
    await expect(swapUsdcToSol(20_000n, keypair, connection)).rejects.toThrow(
      /Jupiter swap failed: HTTP 429/,
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("submits the signed swap and returns signature + outAmount on the happy path", async () => {
    // Fake VersionedTransaction so we don't have to construct a real
    // serialized swap tx. The function-under-test only calls .sign() and
    // .serialize() on the result of `VersionedTransaction.deserialize`.
    const fakeTx = {
      sign: vi.fn(),
      serialize: vi.fn(() => new Uint8Array([1, 2, 3])),
    } as unknown as VersionedTransaction;
    vi.spyOn(VersionedTransaction, "deserialize").mockReturnValue(fakeTx);

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ outAmount: "12345" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        // Real base64; deserialize is mocked, so the bytes don't matter.
        json: async () => ({ swapTransaction: "AAAA" }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const { keypair, connection } = makeKeypairAndConnection();
    const blockhash = Keypair.generate().publicKey.toBase58(); // 32-byte base58
    vi.spyOn(connection, "sendRawTransaction").mockResolvedValue("sigJupiter");
    vi.spyOn(connection, "getLatestBlockhash").mockResolvedValue({
      blockhash,
      lastValidBlockHeight: 100,
    });
    vi.spyOn(connection, "getBlockHeight").mockResolvedValue(0);
    vi.spyOn(connection, "getSignatureStatuses").mockResolvedValue({
      context: { slot: 1 },
      value: [{ slot: 1, confirmations: 0, err: null, confirmationStatus: "confirmed" }],
    } as never);

    const result = await swapUsdcToSol(20_000n, keypair, connection);

    expect(result).toEqual({
      signature: "sigJupiter",
      inputAmount: 20_000n,
      outputAmount: 12_345n,
    });
    expect(fakeTx.sign).toHaveBeenCalledWith([keypair]);
    expect(fakeTx.serialize).toHaveBeenCalledOnce();
  });

  it("falls back to outputAmount=0n when Jupiter quote response omits outAmount", async () => {
    // Defensive: protect against an empty/changed Jupiter response shape.
    const fakeTx = {
      sign: vi.fn(),
      serialize: vi.fn(() => new Uint8Array([1])),
    } as unknown as VersionedTransaction;
    vi.spyOn(VersionedTransaction, "deserialize").mockReturnValue(fakeTx);

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) }) // no outAmount
      .mockResolvedValueOnce({ ok: true, json: async () => ({ swapTransaction: "AAAA" }) });
    vi.stubGlobal("fetch", fetchMock);

    const { keypair, connection } = makeKeypairAndConnection();
    vi.spyOn(connection, "sendRawTransaction").mockResolvedValue("sigEmpty");
    vi.spyOn(connection, "getLatestBlockhash").mockResolvedValue({
      blockhash: Keypair.generate().publicKey.toBase58(),
      lastValidBlockHeight: 1,
    });
    vi.spyOn(connection, "getBlockHeight").mockResolvedValue(0);
    vi.spyOn(connection, "getSignatureStatuses").mockResolvedValue({
      context: { slot: 1 },
      value: [{ slot: 1, confirmations: 0, err: null, confirmationStatus: "confirmed" }],
    } as never);

    const result = await swapUsdcToSol(1n, keypair, connection);
    expect(result.outputAmount).toBe(0n);
  });

  it("propagates a deserialization error when Jupiter returns a malformed swap transaction", async () => {
    // Happy-path HTTP-wise: both endpoints return 200. But the payload
    // Jupiter hands back is not a valid VersionedTransaction, so the
    // wallet-side deserialize must throw rather than sign-and-submit
    // garbage. This pins the "fail loudly past the HTTP boundary"
    // contract without mocking @solana/web3.js internals.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ outAmount: "100000" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ swapTransaction: "AAAA" }), // not a valid serialized tx
      });
    vi.stubGlobal("fetch", fetchMock);

    const { keypair, connection } = makeKeypairAndConnection();
    await expect(swapUsdcToSol(20_000n, keypair, connection)).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("swapSolToUsdc — the funding-side mirror", () => {
  it("REFUSES a swap that would breach the gas floor — the wallet never metabolizes its last fuel", async () => {
    const { keypair, connection } = makeKeypairAndConnection();
    // Wallet holds 0.006 SOL; swapping 0.002 would leave 0.004 < floor.
    vi.spyOn(connection, "getBalance").mockResolvedValue(6_000_000);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(swapSolToUsdc(2_000_000n, keypair, connection)).rejects.toThrow(/gas floor/);
    expect(fetchMock).not.toHaveBeenCalled(); // refused BEFORE any quote — no side effects
  });

  it("names the max swappable amount in the refusal (a refusal that teaches)", async () => {
    const { keypair, connection } = makeKeypairAndConnection();
    vi.spyOn(connection, "getBalance").mockResolvedValue(6_000_000);
    vi.stubGlobal("fetch", vi.fn());

    await expect(swapSolToUsdc(2_000_000n, keypair, connection)).rejects.toThrow(
      /max swappable 1000000 lamports/,
    );
  });

  it("quotes SOL→USDC with the 1% slippage bound and surfaces quote failures", async () => {
    const { keypair, connection } = makeKeypairAndConnection();
    vi.spyOn(connection, "getBalance").mockResolvedValue(100_000_000); // 0.1 SOL — plenty
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 503 });
    vi.stubGlobal("fetch", fetchMock);

    await expect(swapSolToUsdc(10_000_000n, keypair, connection)).rejects.toThrow(
      /Jupiter quote failed: HTTP 503/,
    );
    const quoteUrl = new URL(fetchMock.mock.calls[0]![0] as string);
    expect(quoteUrl.searchParams.get("inputMint")).toBe(
      "So11111111111111111111111111111111111111112",
    );
    expect(quoteUrl.searchParams.get("outputMint")).toBe(
      "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    );
    expect(quoteUrl.searchParams.get("amount")).toBe("10000000");
    expect(quoteUrl.searchParams.get("slippageBps")).toBe("100");
  });

  it("signs and submits the Jupiter transaction, returning amounts both ways", async () => {
    const { keypair, connection } = makeKeypairAndConnection();
    vi.spyOn(connection, "getBalance").mockResolvedValue(100_000_000);
    const fakeTx = { sign: vi.fn(), serialize: vi.fn().mockReturnValue(new Uint8Array([1])) };
    vi.spyOn(VersionedTransaction, "deserialize").mockReturnValue(fakeTx as never);
    vi.spyOn(connection, "sendRawTransaction").mockResolvedValue("sig-mirror");
    vi.spyOn(connection, "getLatestBlockhash").mockResolvedValue({
      blockhash: "h",
      lastValidBlockHeight: 1,
    } as never);
    vi.spyOn(connection, "getBlockHeight").mockResolvedValue(0);
    vi.spyOn(connection, "getSignatureStatuses").mockResolvedValue({
      context: { slot: 1 },
      value: [{ slot: 1, confirmations: 0, err: null, confirmationStatus: "confirmed" }],
    } as never);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ outAmount: "1500000" }), // $1.50 out
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ swapTransaction: Buffer.from([1, 2, 3]).toString("base64") }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const result = await swapSolToUsdc(10_000_000n, keypair, connection);
    expect(fakeTx.sign).toHaveBeenCalledWith([keypair]);
    expect(result).toEqual({
      signature: "sig-mirror",
      inputAmount: 10_000_000n,
      outputAmount: 1_500_000n,
    });
  });
});

describe("Jupiter swap confirmation — anything but confirmed throws", () => {
  function arrangeSubmittedSwap(): { keypair: Keypair; connection: Connection } {
    const { keypair, connection } = makeKeypairAndConnection();
    const fakeTx = { sign: vi.fn(), serialize: vi.fn().mockReturnValue(new Uint8Array([1])) };
    vi.spyOn(VersionedTransaction, "deserialize").mockReturnValue(fakeTx as never);
    vi.spyOn(connection, "sendRawTransaction").mockResolvedValue("sig-unconfirmed");
    vi.spyOn(connection, "getLatestBlockhash").mockResolvedValue({
      blockhash: "h",
      lastValidBlockHeight: 50,
    } as never);
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce({ ok: true, json: async () => ({ outAmount: "1" }) })
        .mockResolvedValueOnce({ ok: true, json: async () => ({ swapTransaction: "AAAA" }) }),
    );
    return { keypair, connection };
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it("throws 'failed onchain' with the error when the swap landed with an error", async () => {
    const { keypair, connection } = arrangeSubmittedSwap();
    vi.spyOn(connection, "getBlockHeight").mockResolvedValue(0);
    vi.spyOn(connection, "getSignatureStatuses").mockResolvedValue({
      context: { slot: 1 },
      value: [
        {
          slot: 1,
          confirmations: 0,
          err: { InstructionError: [2, "Custom"] },
          confirmationStatus: "confirmed",
        },
      ],
    } as never);

    await expect(swapUsdcToSol(20_000n, keypair, connection)).rejects.toThrow(
      'Jupiter swap sig-unconfirmed failed onchain: {"InstructionError":[2,"Custom"]}',
    );
  });

  it("throws 'has expired' when the status is absent past the blockhash expiry", async () => {
    const { keypair, connection } = arrangeSubmittedSwap();
    vi.spyOn(connection, "getBlockHeight").mockResolvedValue(51);
    vi.spyOn(connection, "getSignatureStatuses").mockResolvedValue({
      context: { slot: 1 },
      value: [null],
    } as never);

    await expect(swapUsdcToSol(20_000n, keypair, connection)).rejects.toThrow(
      "Signature sig-unconfirmed has expired: block height exceeded.",
    );
  });

  it("throws 'may still land' when the bounded wait ends still pending — never reports success", async () => {
    vi.useFakeTimers();
    const { keypair, connection } = arrangeSubmittedSwap();
    vi.spyOn(connection, "getBlockHeight").mockResolvedValue(0);
    vi.spyOn(connection, "getSignatureStatuses").mockResolvedValue({
      context: { slot: 1 },
      value: [null],
    } as never);

    const settled = swapUsdcToSol(20_000n, keypair, connection).then(
      () => {
        throw new Error("expected the unconfirmed swap to throw");
      },
      (err: unknown) => err,
    );
    await vi.advanceTimersByTimeAsync(91_000);
    const err = await settled;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe(
      "Jupiter swap sig-unconfirmed was not confirmed in the bounded wait; it may still land",
    );
  });
});

describe("swapSolToUsdc — swap endpoint failure", () => {
  it("throws a labeled error when the Jupiter swap endpoint returns a non-OK HTTP status", async () => {
    const { keypair, connection } = makeKeypairAndConnection();
    vi.spyOn(connection, "getBalance").mockResolvedValue(100_000_000);
    const send = vi.spyOn(connection, "sendRawTransaction");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ outAmount: "1500000" }) })
      .mockResolvedValueOnce({ ok: false, status: 502 });
    vi.stubGlobal("fetch", fetchMock);

    await expect(swapSolToUsdc(10_000_000n, keypair, connection)).rejects.toThrow(
      "Jupiter swap failed: HTTP 502",
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(send).not.toHaveBeenCalled();
  });
});

describe("swapSolToUsdc — wallet already at or below its gas floor", () => {
  it("names a max swappable of 0, never a negative amount", async () => {
    const { keypair, connection } = makeKeypairAndConnection();
    vi.spyOn(connection, "getBalance").mockResolvedValue(4_000_000); // 0.004 SOL < floor
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(swapSolToUsdc(1n, keypair, connection)).rejects.toThrow(
      /Balance 4000000 lamports; max swappable 0 lamports/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
