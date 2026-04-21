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

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Keypair } from "@solana/web3.js";

// Mock just `getAccount` from @solana/spl-token. Everything else
// (TokenAccountNotFoundError, getAssociatedTokenAddress, instruction
// builders) is pure crypto/derivation and stays real — the only
// network-touching call is `getAccount`. `vi.hoisted` is required
// because vi.mock is hoisted above plain const declarations.
const { getAccountMock } = vi.hoisted(() => ({ getAccountMock: vi.fn() }));
vi.mock("@solana/spl-token", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@solana/spl-token")>();
  return {
    ...actual,
    getAccount: getAccountMock,
  };
});

import { TokenAccountNotFoundError } from "@solana/spl-token";

import { Web3JsRpcAdapter } from "../web3js-adapter.js";
import {
  USDC_MINT_MAINNET,
  InsufficientUsdcBalanceError,
  InvalidSolanaAddressError,
} from "../constants.js";

const ZERO_SEED = new Uint8Array(32); // 32 zero bytes

/** Generate a fresh valid base58 Solana address for use as a recipient. */
function validBase58Address(): string {
  return Keypair.generate().publicKey.toBase58();
}

/** A valid base58-encoded 32-byte blockhash — Transaction.serialize
 *  decodes `recentBlockhash` and expects exactly 32 bytes. A keypair's
 *  base58 address is the cheapest way to produce that. */
function validBlockhash(): string {
  return Keypair.generate().publicKey.toBase58();
}

beforeEach(() => {
  getAccountMock.mockReset();
});

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

  it("returns not_found when multiple recipients are present (ambiguous transfer)", async () => {
    const adapter = makeAdapterForTx();
    const conn = adapter.getConnection();
    vi.spyOn(conn, "getTransaction").mockResolvedValue(
      txResponse({
        slot: 78,
        entries: [
          { accountIndex: 0, owner: "payer", pre: "1000000", post: "0" },
          { accountIndex: 1, owner: "recipient-1", pre: "0", post: "500000" },
          { accountIndex: 2, owner: "recipient-2", pre: "0", post: "500000" },
        ],
      }) as never,
    );

    const result = await adapter.getTransaction("sigAmbiguousTo");
    expect(result).toEqual({ status: "not_found" });
  });

  it("skips token-balance entries with no owner (defensive against partial wire data)", async () => {
    const adapter = makeAdapterForTx();
    const conn = adapter.getConnection();
    // The first entry has owner: undefined and should be ignored entirely;
    // we expect to fall through to not_found because no payer / recipient
    // could be resolved.
    vi.spyOn(conn, "getTransaction").mockResolvedValue(
      txResponse({
        slot: 11,
        entries: [{ accountIndex: 0, owner: undefined, pre: "1000000", post: "500000" }],
      }) as never,
    );

    const result = await adapter.getTransaction("sigNoOwner");
    expect(result).toEqual({ status: "not_found" });
  });

  it("skips token-balance entries with non-numeric amount strings", async () => {
    const adapter = makeAdapterForTx();
    const conn = adapter.getConnection();
    // Amount string "not-a-number" should fail BigInt() and be silently
    // skipped — no payer/recipient resolves, fall through to not_found.
    vi.spyOn(conn, "getTransaction").mockResolvedValue(
      txResponse({
        slot: 12,
        entries: [{ accountIndex: 0, owner: "payer", pre: "not-a-number", post: "abc" }],
      }) as never,
    );

    const result = await adapter.getTransaction("sigBadAmount");
    expect(result).toEqual({ status: "not_found" });
  });

  it("uses 'finalized' commitment when adapter is configured for finalized", async () => {
    const adapter = new Web3JsRpcAdapter({
      rpcUrl: "https://api.devnet.solana.com",
      identitySeed: ZERO_SEED,
      commitment: "finalized",
    });
    const spy = vi.spyOn(adapter.getConnection(), "getTransaction").mockResolvedValue(null);

    await adapter.getTransaction("sigFin");
    expect(spy).toHaveBeenCalledWith(
      "sigFin",
      expect.objectContaining({ commitment: "finalized" }),
    );
  });

  it("narrows 'processed' commitment up to 'confirmed' for getTransaction", async () => {
    // getTransaction only accepts Finality ("confirmed" | "finalized");
    // the adapter narrows "processed" → "confirmed" so the RPC accepts the call.
    const adapter = new Web3JsRpcAdapter({
      rpcUrl: "https://api.devnet.solana.com",
      identitySeed: ZERO_SEED,
      commitment: "processed",
    });
    const spy = vi.spyOn(adapter.getConnection(), "getTransaction").mockResolvedValue(null);

    await adapter.getTransaction("sigProc");
    expect(spy).toHaveBeenCalledWith(
      "sigProc",
      expect.objectContaining({ commitment: "confirmed" }),
    );
  });
});

// ── Balances ──────────────────────────────────────────────────────────────
//
// `getSolBalance` is a one-line BigInt wrap; `getUsdcBalance` exercises
// the TokenAccountNotFoundError branch (returns 0n for an uncreated ATA)
// and the rethrow branch (other errors propagate). Both shapes are part
// of the rail's public contract — wallet UIs depend on 0-not-throw for
// fresh accounts.

describe("Web3JsRpcAdapter balance methods", () => {
  it("getSolBalance reads lamports and wraps into BigInt", async () => {
    const adapter = makeAdapterForTx();
    vi.spyOn(adapter.getConnection(), "getBalance").mockResolvedValue(123_456);
    expect(await adapter.getSolBalance()).toBe(123_456n);
  });

  it("getUsdcBalance returns the ATA amount when the account exists", async () => {
    const adapter = makeAdapterForTx();
    getAccountMock.mockResolvedValue({ amount: 250_000n });
    expect(await adapter.getUsdcBalance()).toBe(250_000n);
  });

  it("getUsdcBalance returns 0n when the ATA has not been created yet", async () => {
    const adapter = makeAdapterForTx();
    getAccountMock.mockRejectedValue(new TokenAccountNotFoundError());
    expect(await adapter.getUsdcBalance()).toBe(0n);
  });

  it("getUsdcBalance rethrows non-TokenAccountNotFoundError failures", async () => {
    const adapter = makeAdapterForTx();
    getAccountMock.mockRejectedValue(new Error("RPC down"));
    await expect(adapter.getUsdcBalance()).rejects.toThrow("RPC down");
  });
});

// ── sendUsdc ──────────────────────────────────────────────────────────────
//
// The sovereign-rail USDC transfer path. We mock the SPL token-account
// lookup (`getAccount`) and the Connection's submission methods; the
// transaction-build + signing stays real so anything that would have
// crashed at serialize-time still does.

describe("Web3JsRpcAdapter.sendUsdc", () => {
  it("rejects garbage recipient addresses with InvalidSolanaAddressError", async () => {
    const adapter = makeAdapterForTx();
    await expect(
      adapter.sendUsdc({ toAddress: "not-base58!!!", microAmount: 100n }),
    ).rejects.toBeInstanceOf(InvalidSolanaAddressError);
  });

  it("throws InsufficientUsdcBalanceError when source balance < microAmount", async () => {
    const adapter = makeAdapterForTx();
    // First getAccount = balance check (returns 10 micro)
    getAccountMock.mockResolvedValueOnce({ amount: 10n });
    await expect(
      adapter.sendUsdc({
        toAddress: validBase58Address(),
        microAmount: 1_000_000n,
      }),
    ).rejects.toBeInstanceOf(InsufficientUsdcBalanceError);
  });

  it("happy path: ATA exists, transfer confirms cleanly", async () => {
    const adapter = makeAdapterForTx();
    const conn = adapter.getConnection();
    // 1st getAccount = own balance, 2nd getAccount = dest exists (succeeds)
    getAccountMock
      .mockResolvedValueOnce({ amount: 10_000_000n })
      .mockResolvedValueOnce({ amount: 0n });
    vi.spyOn(conn, "getLatestBlockhash").mockResolvedValue({
      blockhash: validBlockhash(),
      lastValidBlockHeight: 100,
    });
    vi.spyOn(conn, "sendRawTransaction").mockResolvedValue("sigHappy");
    vi.spyOn(conn, "confirmTransaction").mockResolvedValue({
      context: { slot: 42 },
      value: { err: null },
    });

    const result = await adapter.sendUsdc({
      toAddress: validBase58Address(),
      microAmount: 1_000_000n,
    });
    expect(result).toEqual({ signature: "sigHappy", slot: 42, confirmed: true });
  });

  it("auto-creates destination ATA when missing (TokenAccountNotFoundError)", async () => {
    const adapter = makeAdapterForTx();
    const conn = adapter.getConnection();
    getAccountMock
      .mockResolvedValueOnce({ amount: 10_000_000n }) // own balance
      .mockRejectedValueOnce(new TokenAccountNotFoundError()); // dest missing
    vi.spyOn(conn, "getLatestBlockhash").mockResolvedValue({
      blockhash: validBlockhash(),
      lastValidBlockHeight: 100,
    });
    const sendSpy = vi.spyOn(conn, "sendRawTransaction").mockResolvedValue("sigCreated");
    vi.spyOn(conn, "confirmTransaction").mockResolvedValue({
      context: { slot: 7 },
      value: { err: null },
    });

    const result = await adapter.sendUsdc({
      toAddress: validBase58Address(),
      microAmount: 500_000n,
    });
    expect(result).toEqual({ signature: "sigCreated", slot: 7, confirmed: true });
    expect(sendSpy).toHaveBeenCalledOnce();
  });

  it("rethrows non-TANF errors during the dest ATA existence check", async () => {
    const adapter = makeAdapterForTx();
    getAccountMock
      .mockResolvedValueOnce({ amount: 10_000_000n }) // own balance ok
      .mockRejectedValueOnce(new Error("RPC down")); // dest check transient
    await expect(
      adapter.sendUsdc({ toAddress: validBase58Address(), microAmount: 1n }),
    ).rejects.toThrow("RPC down");
  });

  it("returns confirmed=false when the network reports a transaction error", async () => {
    const adapter = makeAdapterForTx();
    const conn = adapter.getConnection();
    getAccountMock
      .mockResolvedValueOnce({ amount: 10_000_000n })
      .mockResolvedValueOnce({ amount: 0n });
    vi.spyOn(conn, "getLatestBlockhash").mockResolvedValue({
      blockhash: validBlockhash(),
      lastValidBlockHeight: 50,
    });
    vi.spyOn(conn, "sendRawTransaction").mockResolvedValue("sigErr");
    vi.spyOn(conn, "confirmTransaction").mockResolvedValue({
      context: { slot: 99 },
      value: { err: { InstructionError: [0, "Custom"] } },
    });
    const result = await adapter.sendUsdc({
      toAddress: validBase58Address(),
      microAmount: 1n,
    });
    expect(result.confirmed).toBe(false);
    expect(result.signature).toBe("sigErr");
    expect(result.slot).toBe(99);
  });
});

// ── sendUsdcBatch ─────────────────────────────────────────────────────────
//
// Multi-recipient USDC transfer. Lock the chunk boundary and the
// fail-fast contract: once a chunk fails, subsequent chunks are NOT
// submitted; their items return ok=false with reason "prior chunk failed".

describe("Web3JsRpcAdapter.sendUsdcBatch", () => {
  it("returns [] for an empty batch", async () => {
    const adapter = makeAdapterForTx();
    expect(await adapter.sendUsdcBatch([])).toEqual([]);
  });

  it("delegates to sendUsdc for a single-item batch", async () => {
    const adapter = makeAdapterForTx();
    const conn = adapter.getConnection();
    getAccountMock
      .mockResolvedValueOnce({ amount: 10_000_000n }) // own balance
      .mockResolvedValueOnce({ amount: 0n }); // dest exists
    vi.spyOn(conn, "getLatestBlockhash").mockResolvedValue({
      blockhash: validBlockhash(),
      lastValidBlockHeight: 1,
    });
    vi.spyOn(conn, "sendRawTransaction").mockResolvedValue("sigSingle");
    vi.spyOn(conn, "confirmTransaction").mockResolvedValue({
      context: { slot: 1 },
      value: { err: null },
    });

    const results = await adapter.sendUsdcBatch([
      { toAddress: validBase58Address(), microAmount: 1n },
    ]);
    expect(results).toEqual([{ ok: true, signature: "sigSingle", slot: 1, reason: null }]);
  });

  it("throws InsufficientUsdcBalanceError when the total exceeds available balance", async () => {
    const adapter = makeAdapterForTx();
    getAccountMock.mockResolvedValueOnce({ amount: 100n }); // balance 100 < total 120
    await expect(
      adapter.sendUsdcBatch([
        { toAddress: validBase58Address(), microAmount: 60n },
        { toAddress: validBase58Address(), microAmount: 60n },
      ]),
    ).rejects.toBeInstanceOf(InsufficientUsdcBalanceError);
  });

  it("submits a multi-item chunk and reports per-item ok=true on success", async () => {
    const adapter = makeAdapterForTx();
    const conn = adapter.getConnection();
    // 1 balance check + 2 dest checks
    getAccountMock.mockImplementation(async () => ({ amount: 10_000_000n }));
    vi.spyOn(conn, "getLatestBlockhash").mockResolvedValue({
      blockhash: validBlockhash(),
      lastValidBlockHeight: 200,
    });
    vi.spyOn(conn, "sendRawTransaction").mockResolvedValue("sigMulti");
    vi.spyOn(conn, "confirmTransaction").mockResolvedValue({
      context: { slot: 200 },
      value: { err: null },
    });

    const results = await adapter.sendUsdcBatch([
      { toAddress: validBase58Address(), microAmount: 1n },
      { toAddress: validBase58Address(), microAmount: 2n },
    ]);
    expect(results).toEqual([
      { ok: true, signature: "sigMulti", slot: 200, reason: null },
      { ok: true, signature: "sigMulti", slot: 200, reason: null },
    ]);
  });

  it("marks subsequent chunks as 'prior chunk failed' when the first chunk's tx errors", async () => {
    const adapter = makeAdapterForTx();
    const conn = adapter.getConnection();
    getAccountMock.mockImplementation(async () => ({ amount: 100_000_000n }));
    vi.spyOn(conn, "getLatestBlockhash").mockResolvedValue({
      blockhash: validBlockhash(),
      lastValidBlockHeight: 1,
    });
    vi.spyOn(conn, "sendRawTransaction").mockResolvedValue("sigFailingFirst");
    vi.spyOn(conn, "confirmTransaction").mockResolvedValue({
      context: { slot: 5 },
      value: { err: { CustomError: 1 } },
    });

    // 9 items spans 2 chunks at MAX_TRANSFERS_PER_TX=8 (8 + 1).
    const items = Array.from({ length: 9 }, () => ({
      toAddress: validBase58Address(),
      microAmount: 1n,
    }));
    const results = await adapter.sendUsdcBatch(items);

    expect(results).toHaveLength(9);
    // First chunk tx failed
    for (let i = 0; i < 8; i++) {
      expect(results[i]!.ok).toBe(false);
      expect(results[i]!.reason).toBe("tx failed");
    }
    // Second chunk skipped
    expect(results[8]!.ok).toBe(false);
    expect(results[8]!.reason).toBe("prior chunk failed");
    expect(results[8]!.signature).toBeNull();
  });

  it("aborts the batch when an invalid mid-batch address is encountered", async () => {
    const adapter = makeAdapterForTx();
    getAccountMock.mockImplementation(async () => ({ amount: 100_000_000n }));
    const results = await adapter.sendUsdcBatch([
      { toAddress: validBase58Address(), microAmount: 1n },
      { toAddress: "totally-not-base58!!!", microAmount: 1n },
    ]);

    expect(results).toHaveLength(2);
    // Both items in the failing chunk get the catch-block reason.
    for (const r of results) {
      expect(r.ok).toBe(false);
      expect(r.reason).toContain("Invalid Solana address");
    }
  });
});

// ── isReachable ───────────────────────────────────────────────────────────

describe("Web3JsRpcAdapter.isReachable", () => {
  it("returns true when getLatestBlockhash succeeds", async () => {
    const adapter = makeAdapterForTx();
    vi.spyOn(adapter.getConnection(), "getLatestBlockhash").mockResolvedValue({
      blockhash: validBlockhash(),
      lastValidBlockHeight: 1,
    });
    expect(await adapter.isReachable()).toBe(true);
  });

  it("returns false when getLatestBlockhash throws", async () => {
    const adapter = makeAdapterForTx();
    vi.spyOn(adapter.getConnection(), "getLatestBlockhash").mockRejectedValue(new Error("nope"));
    expect(await adapter.isReachable()).toBe(false);
  });
});

// ── Exposed getters ──────────────────────────────────────────────────────
//
// The keypair / connection / commitment / mint accessors are how the
// rail's auto-gas path (and Jupiter swaps) reach into the adapter. They
// must round-trip the constructor inputs.

describe("Web3JsRpcAdapter exposed getters", () => {
  it("exposes keypair, connection, commitment, and usdc mint matching constructor input", () => {
    const adapter = new Web3JsRpcAdapter({
      rpcUrl: "https://api.devnet.solana.com",
      identitySeed: ZERO_SEED,
      commitment: "finalized",
      usdcMint: USDC_MINT_MAINNET,
    });
    expect(adapter.getKeypair().publicKey.toBase58()).toBe(adapter.ownAddress);
    expect(adapter.getConnection()).toBeDefined();
    expect(adapter.getCommitment()).toBe("finalized");
    expect(adapter.getUsdcMint()).toBe(USDC_MINT_MAINNET);
  });

  it("defaults commitment to 'confirmed' and mint to mainnet USDC when omitted", () => {
    const adapter = new Web3JsRpcAdapter({
      rpcUrl: "https://api.devnet.solana.com",
      identitySeed: ZERO_SEED,
    });
    expect(adapter.getCommitment()).toBe("confirmed");
    expect(adapter.getUsdcMint()).toBe(USDC_MINT_MAINNET);
  });
});
