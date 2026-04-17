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
import { Keypair, Connection } from "@solana/web3.js";

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
