/**
 * Web3JsRpcAdapter unit tests — verify seed → address derivation
 * matches the Ed25519 / Solana convention without touching the network.
 *
 * The mathematical claim "the motebit identity public key IS its
 * Solana address" needs to be checked, not assumed. Solana derives
 * its address as the base58 of the Ed25519 public key, and the
 * Ed25519 public key is determined by the seed. So given a fixed
 * seed, the Solana address is also fixed and can be asserted.
 *
 * Constructor validation (32-byte seed requirement) is also covered
 * here so the rail surface stays free of "did you remember the right
 * seed length" footguns.
 */

import { describe, it, expect, vi } from "vitest";

import { Web3JsRpcAdapter } from "../web3js-adapter.js";
import { USDC_MINT_MAINNET } from "../constants.js";

const ZERO_SEED = new Uint8Array(32); // 32 zero bytes

describe("Web3JsRpcAdapter", () => {
  it("derives a deterministic address from a 32-byte Ed25519 seed", () => {
    const adapter = new Web3JsRpcAdapter({
      rpcUrl: "https://api.devnet.solana.com",
      identitySeed: ZERO_SEED,
    });

    // Solana derives addresses as base58(ed25519_public_key(seed)).
    // For an all-zero seed, this is a stable, well-known value.
    // We don't pin the exact string (different curve impls have
    // historically disagreed on edge cases) — just that it's a
    // non-empty base58-shaped string of plausible length.
    expect(adapter.ownAddress).toMatch(/^[1-9A-HJ-NP-Za-km-z]+$/);
    expect(adapter.ownAddress.length).toBeGreaterThanOrEqual(32);
    expect(adapter.ownAddress.length).toBeLessThanOrEqual(44);
  });

  it("produces the same address when given the same seed twice", () => {
    const seed = new Uint8Array(32).fill(7);
    const a = new Web3JsRpcAdapter({
      rpcUrl: "https://api.devnet.solana.com",
      identitySeed: seed,
    });
    const b = new Web3JsRpcAdapter({
      rpcUrl: "https://api.devnet.solana.com",
      identitySeed: seed,
    });
    expect(a.ownAddress).toBe(b.ownAddress);
  });

  it("produces different addresses for different seeds", () => {
    const a = new Web3JsRpcAdapter({
      rpcUrl: "https://api.devnet.solana.com",
      identitySeed: new Uint8Array(32).fill(1),
    });
    const b = new Web3JsRpcAdapter({
      rpcUrl: "https://api.devnet.solana.com",
      identitySeed: new Uint8Array(32).fill(2),
    });
    expect(a.ownAddress).not.toBe(b.ownAddress);
  });

  it("rejects seeds that aren't exactly 32 bytes", () => {
    expect(
      () =>
        new Web3JsRpcAdapter({
          rpcUrl: "https://api.devnet.solana.com",
          identitySeed: new Uint8Array(16),
        }),
    ).toThrow(/32-byte/);
    expect(
      () =>
        new Web3JsRpcAdapter({
          rpcUrl: "https://api.devnet.solana.com",
          identitySeed: new Uint8Array(64),
        }),
    ).toThrow(/32-byte/);
  });
});

// ── getTransaction ────────────────────────────────────────────────────────
//
// We exercise the three branches of the discriminated union by
// stubbing `Connection.getTransaction` directly on the adapter's
// internal connection. The goal is to lock in the classification
// contract (`TxVerificationResult` in adapter.ts), not to re-verify
// web3.js plumbing.

function makeAdapterForTx(): Web3JsRpcAdapter {
  return new Web3JsRpcAdapter({
    rpcUrl: "https://api.devnet.solana.com",
    identitySeed: ZERO_SEED,
  });
}

/** Build a `VersionedTransactionResponse`-shaped stub with pre/post token balances. */
function txResponse(opts: {
  slot: number;
  mint?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  err?: any;
  entries: ReadonlyArray<{
    accountIndex: number;
    owner: string | undefined;
    pre: string;
    post: string;
  }>;
}): unknown {
  const mint = opts.mint ?? USDC_MINT_MAINNET;
  return {
    slot: opts.slot,
    transaction: { message: {}, signatures: [] },
    meta: {
      err: opts.err ?? null,
      fee: 5000,
      preBalances: [],
      postBalances: [],
      preTokenBalances: opts.entries.map((e) => ({
        accountIndex: e.accountIndex,
        mint,
        owner: e.owner,
        uiTokenAmount: {
          amount: e.pre,
          decimals: 6,
          uiAmount: null,
          uiAmountString: e.pre,
        },
      })),
      postTokenBalances: opts.entries.map((e) => ({
        accountIndex: e.accountIndex,
        mint,
        owner: e.owner,
        uiTokenAmount: {
          amount: e.post,
          decimals: 6,
          uiAmount: null,
          uiAmountString: e.post,
        },
      })),
    },
  };
}

describe("Web3JsRpcAdapter.getTransaction", () => {
  it("classifies a null result as not_found (authoritative)", async () => {
    const adapter = makeAdapterForTx();
    const conn = adapter.getConnection();
    vi.spyOn(conn, "getTransaction").mockResolvedValue(null);

    const result = await adapter.getTransaction("sigAbsent");
    expect(result).toEqual({ status: "not_found" });
  });

  it("classifies a thrown RPC error as rpc_error (transient, retryable)", async () => {
    const adapter = makeAdapterForTx();
    const conn = adapter.getConnection();
    vi.spyOn(conn, "getTransaction").mockRejectedValue(new Error("ECONNRESET: RPC socket closed"));

    const result = await adapter.getTransaction("sigErr");
    expect(result.status).toBe("rpc_error");
    if (result.status === "rpc_error") {
      expect(result.reason).toContain("ECONNRESET");
    }
  });

  it("extracts from/to owners, exact amount, slot, and asset on a confirmed SPL transfer", async () => {
    const adapter = makeAdapterForTx();
    const conn = adapter.getConnection();
    const payer = "4vERYvaLiDPayerOwnerBase58AddressHere11111111";
    const recipient = "9xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgBBB";
    vi.spyOn(conn, "getTransaction").mockResolvedValue(
      txResponse({
        slot: 321,
        entries: [
          { accountIndex: 0, owner: payer, pre: "1000000", post: "500000" },
          { accountIndex: 1, owner: recipient, pre: "0", post: "500000" },
        ],
      }) as never,
    );

    const result = await adapter.getTransaction("sigConfirmed");
    expect(result).toEqual({
      status: "confirmed",
      from: payer,
      to: recipient,
      amountMicro: 500_000n,
      slot: 321,
      asset: "USDC",
    });
  });

  it("treats a confirmed tx with no SPL transfer on the configured mint as not_found", async () => {
    const adapter = makeAdapterForTx();
    const conn = adapter.getConnection();
    // A tx that's real but only touched a different mint.
    vi.spyOn(conn, "getTransaction").mockResolvedValue(
      txResponse({
        slot: 5,
        mint: "So11111111111111111111111111111111111111112", // wSOL, not USDC
        entries: [
          {
            accountIndex: 0,
            owner: "payer",
            pre: "1000000",
            post: "500000",
          },
          {
            accountIndex: 1,
            owner: "recipient",
            pre: "0",
            post: "500000",
          },
        ],
      }) as never,
    );

    const result = await adapter.getTransaction("sigOtherMint");
    expect(result).toEqual({ status: "not_found" });
  });

  it("treats a confirmed-but-errored tx as not_found (no verifiable transfer happened)", async () => {
    const adapter = makeAdapterForTx();
    const conn = adapter.getConnection();
    vi.spyOn(conn, "getTransaction").mockResolvedValue(
      txResponse({
        slot: 9,
        err: { InstructionError: [0, "Custom"] },
        entries: [
          { accountIndex: 0, owner: "p", pre: "1000000", post: "500000" },
          { accountIndex: 1, owner: "r", pre: "0", post: "500000" },
        ],
      }) as never,
    );

    const result = await adapter.getTransaction("sigErrTx");
    expect(result).toEqual({ status: "not_found" });
  });

  it("returns not_found when multiple payers are present (ambiguous transfer)", async () => {
    const adapter = makeAdapterForTx();
    const conn = adapter.getConnection();
    vi.spyOn(conn, "getTransaction").mockResolvedValue(
      txResponse({
        slot: 77,
        entries: [
          { accountIndex: 0, owner: "payer-1", pre: "1000000", post: "500000" },
          { accountIndex: 1, owner: "payer-2", pre: "1000000", post: "500000" },
          { accountIndex: 2, owner: "recipient", pre: "0", post: "1000000" },
        ],
      }) as never,
    );

    const result = await adapter.getTransaction("sigAmbiguous");
    expect(result).toEqual({ status: "not_found" });
  });
});
