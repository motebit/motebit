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

import { swapUsdcToSol } from "../jupiter.js";

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
    vi.spyOn(connection, "confirmTransaction").mockResolvedValue({
      context: { slot: 1 },
      value: { err: null },
    });

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
    vi.spyOn(connection, "confirmTransaction").mockResolvedValue({
      context: { slot: 1 },
      value: { err: null },
    });

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
