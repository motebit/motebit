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
import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { base58Encode } from "@motebit/protocol";

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

import { ASSOCIATED_TOKEN_PROGRAM_ID, TokenAccountNotFoundError } from "@solana/spl-token";

import {
  Web3JsRpcAdapter,
  deriveSolanaAddress,
  isDerivedSettlementBinding,
} from "../web3js-adapter.js";
import { FRESH_WINDOW_END, FRESH_WINDOW_START } from "../adapter.js";
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
  // A virtual clock for the post-expiry poll: `sleep` advances `now`, so a
  // 30s cap costs no real time.
  let t = 0;
  return new Web3JsRpcAdapter({
    rpcUrl: "https://api.devnet.solana.com",
    identitySeed: ZERO_SEED,
    expiryConfirm: {
      now: () => t,
      sleep: (ms) => {
        t += ms;
        return Promise.resolve();
      },
    },
  });
}

/**
 * The chain as web3.js actually meets it (#885 round 4): the expiry is
 * raised at lastValid+1, and each later read sees the chain further along
 * (`step` blocks, one slot per block). `landedSigs` are confirmed.
 */
function advancingChain(
  conn: ReturnType<Web3JsRpcAdapter["getConnection"]>,
  c: { lastValid: number; step: number; landed?: ReadonlySet<string> },
): { reads: () => number } {
  let reads = 0;
  let height = c.lastValid + 1;
  let slot = 10_000;
  vi.spyOn(conn, "getEpochInfo").mockImplementation(async () => {
    reads++;
    const r = { blockHeight: height, absoluteSlot: slot };
    height += c.step;
    slot += c.step;
    return r as never;
  });
  vi.spyOn(conn, "getSignatureStatuses").mockImplementation(
    async (sigs) =>
      ({
        context: { slot },
        value: [
          c.landed?.has(sigs[0]!) === true
            ? { confirmationStatus: "confirmed", err: null, slot: 42, confirmations: 1 }
            : null,
        ],
      }) as never,
  );
  return { reads: () => reads };
}

/**
 * What the chain answers to `getSignatureOutcome` (#885): the height+slot
 * read (`getEpochInfo`) and the status read (`getSignatureStatuses`, whose
 * `context.slot` is the answering node's view).
 */
function chainSays(
  conn: ReturnType<Web3JsRpcAdapter["getConnection"]>,
  c: {
    height: number;
    slot: number;
    statusSlot: number;
    status: null | { confirmationStatus: string; err: unknown; slot: number };
  },
): void {
  vi.spyOn(conn, "getEpochInfo").mockResolvedValue({
    blockHeight: c.height,
    absoluteSlot: c.slot,
  } as never);
  vi.spyOn(conn, "getSignatureStatuses").mockResolvedValue({
    context: { slot: c.statusSlot },
    value: [c.status],
  } as never);
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
      transfers: [{ to: recipient, amountMicro: 500_000n }],
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

  it("surfaces multiple recipients as transfers[] entries (Arc 2 fee-leg composition)", async () => {
    // After Arc 2 of the off-ramp arc, multi-recipient transactions
    // are first-class: the delegator's single atomic Solana tx pays
    // the worker AND the relay treasury as two SPL Transfer
    // instructions. The verifier walks transfers[] to find both legs.
    const adapter = makeAdapterForTx();
    const conn = adapter.getConnection();
    vi.spyOn(conn, "getTransaction").mockResolvedValue(
      txResponse({
        slot: 78,
        entries: [
          { accountIndex: 0, owner: "delegator", pre: "1000000", post: "0" },
          { accountIndex: 1, owner: "worker", pre: "0", post: "950000" },
          { accountIndex: 2, owner: "relay-treasury", pre: "0", post: "50000" },
        ],
      }) as never,
    );

    const result = await adapter.getTransaction("sigMultiRecipient");
    expect(result.status).toBe("confirmed");
    if (result.status === "confirmed") {
      expect(result.from).toBe("delegator");
      expect(result.transfers).toHaveLength(2);
      expect(result.transfers).toContainEqual({ to: "worker", amountMicro: 950_000n });
      expect(result.transfers).toContainEqual({ to: "relay-treasury", amountMicro: 50_000n });
    }
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

// ── #887: findOutgoingTransfer — the read-only "did my send land?" lookup ──

describe("Web3JsRpcAdapter.findOutgoingTransfer", () => {
  const SINCE_MS = 1_700_000_000_000;
  const T = Math.floor(SINCE_MS / 1000) + 5; // a block time just after the send began
  const worker = "9xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgBBB";

  type Sig = { signature: string; blockTime: number | null; err: unknown };
  type Tx =
    | { status: "confirmed"; from: string; to: string; amount: bigint }
    | { status: "not_found" }
    | { status: "rpc_error" };

  function setup(sigs: Sig[], txs: Record<string, Tx>) {
    const adapter = makeAdapterForTx();
    const own = adapter.ownAddress;
    const conn = adapter.getConnection();
    const getSigs = vi.spyOn(conn, "getSignaturesForAddress").mockResolvedValue(sigs as never);
    vi.spyOn(adapter, "getTransaction").mockImplementation((sig: string) => {
      const t = txs[sig] ?? { status: "not_found" };
      if (t.status === "confirmed") {
        return Promise.resolve({
          status: "confirmed",
          from: t.from === "OWN" ? own : t.from,
          transfers: [{ to: t.to, amountMicro: t.amount }],
          slot: 1,
          asset: "USDC",
        });
      }
      if (t.status === "rpc_error") return Promise.resolve({ status: "rpc_error", reason: "boom" });
      return Promise.resolve({ status: "not_found" });
    });
    return { adapter, getSigs };
  }

  const q = { toAddress: worker, microAmount: 250_000n, sinceMs: SINCE_MS };

  it("exactly one landed transfer from this wallet with the exact amount ⇒ found", async () => {
    const { adapter } = setup([{ signature: "s1", blockTime: T, err: null }], {
      s1: { status: "confirmed", from: "OWN", to: worker, amount: 250_000n },
    });
    await expect(adapter.findOutgoingTransfer(q)).resolves.toEqual({
      status: "found",
      signature: "s1",
    });
  });

  it("another payer, another amount, another recipient, an errored tx, or an older tx ⇒ not_found", async () => {
    const { adapter } = setup(
      [
        { signature: "other-payer", blockTime: T, err: null },
        { signature: "wrong-amount", blockTime: T, err: null },
        { signature: "wrong-to", blockTime: T, err: null },
        { signature: "errored", blockTime: T, err: { InstructionError: [0, "x"] } },
        { signature: "too-old", blockTime: T - 3_600, err: null },
      ],
      {
        "other-payer": { status: "confirmed", from: "Someone", to: worker, amount: 250_000n },
        "wrong-amount": { status: "confirmed", from: "OWN", to: worker, amount: 250_001n },
        "wrong-to": { status: "confirmed", from: "OWN", to: "Elsewhere", amount: 250_000n },
        errored: { status: "confirmed", from: "OWN", to: worker, amount: 250_000n },
        "too-old": { status: "confirmed", from: "OWN", to: worker, amount: 250_000n },
      },
    );
    await expect(adapter.findOutgoingTransfer(q)).resolves.toEqual({ status: "not_found" });
  });

  it("a signature the caller already accounts for is skipped", async () => {
    const { adapter } = setup([{ signature: "mine-before", blockTime: T, err: null }], {
      "mine-before": { status: "confirmed", from: "OWN", to: worker, amount: 250_000n },
    });
    await expect(
      adapter.findOutgoingTransfer({ ...q, excludeSignatures: ["mine-before"] }),
    ).resolves.toEqual({ status: "not_found" });
  });

  it("two matches ⇒ ambiguous (never guess which one is ours)", async () => {
    const { adapter } = setup(
      [
        { signature: "a", blockTime: T, err: null },
        { signature: "b", blockTime: T + 1, err: null },
      ],
      {
        a: { status: "confirmed", from: "OWN", to: worker, amount: 250_000n },
        b: { status: "confirmed", from: "OWN", to: worker, amount: 250_000n },
      },
    );
    await expect(adapter.findOutgoingTransfer(q)).resolves.toEqual({
      status: "ambiguous",
      signatures: ["a", "b"],
    });
  });

  it("an RPC error on any candidate ⇒ rpc_error, never absence", async () => {
    const { adapter } = setup([{ signature: "s1", blockTime: T, err: null }], {
      s1: { status: "rpc_error" },
    });
    await expect(adapter.findOutgoingTransfer(q)).resolves.toMatchObject({ status: "rpc_error" });
  });

  it("the signature listing throwing ⇒ rpc_error", async () => {
    const { adapter, getSigs } = setup([], {});
    getSigs.mockRejectedValue(new Error("429 Too Many Requests"));
    await expect(adapter.findOutgoingTransfer(q)).resolves.toEqual({
      status: "rpc_error",
      reason: "429 Too Many Requests",
    });
  });

  it("a full page that does not reach back to the send ⇒ rpc_error (window not covered)", async () => {
    const page = Array.from({ length: 50 }, (_, i) => ({
      signature: `n${i}`,
      blockTime: T + 100 - i,
      err: null,
    }));
    const { adapter } = setup(page, {});
    await expect(adapter.findOutgoingTransfer(q)).resolves.toMatchObject({
      status: "rpc_error",
      reason: expect.stringMatching(/window not covered/),
    });
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

  // `getUsdcBalanceOf` is the arbitrary-address read the commitment-bond
  // verifier uses. Same TokenAccountNotFoundError→0n / rethrow contract as
  // `getUsdcBalance`, plus an address-validation guard (the own-ATA path
  // can't take a bad address; this one can).
  const VALID_OWNER = "11111111111111111111111111111111"; // System Program — valid 32-byte base58

  it("getUsdcBalanceOf returns the owner ATA amount when the account exists", async () => {
    const adapter = makeAdapterForTx();
    getAccountMock.mockResolvedValue({ amount: 750_000n });
    expect(await adapter.getUsdcBalanceOf(VALID_OWNER)).toBe(750_000n);
  });

  it("getUsdcBalanceOf returns 0n when the owner has no token account", async () => {
    const adapter = makeAdapterForTx();
    getAccountMock.mockRejectedValue(new TokenAccountNotFoundError());
    expect(await adapter.getUsdcBalanceOf(VALID_OWNER)).toBe(0n);
  });

  it("getUsdcBalanceOf rethrows non-TokenAccountNotFoundError failures", async () => {
    const adapter = makeAdapterForTx();
    getAccountMock.mockRejectedValue(new Error("RPC down"));
    await expect(adapter.getUsdcBalanceOf(VALID_OWNER)).rejects.toThrow("RPC down");
  });

  it("getUsdcBalanceOf rejects a malformed owner address with InvalidSolanaAddressError", async () => {
    const adapter = makeAdapterForTx();
    await expect(adapter.getUsdcBalanceOf("not-a-valid-address!!!")).rejects.toBeInstanceOf(
      InvalidSolanaAddressError,
    );
  });
});

// ── sendUsdc ──────────────────────────────────────────────────────────────
//
// The sovereign-rail USDC transfer path. We mock the SPL token-account
// lookup (`getAccount`) and the Connection's submission methods; the
// transaction-build + signing stays real so anything that would have
// crashed at serialize-time still does.

/** The Associated Token Account program instructions in a raw sent transaction. */
function ataInstructionData(raw: unknown): number[][] {
  return Transaction.from(raw as Buffer)
    .instructions.filter((ix) => ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID))
    .map((ix) => [...ix.data]);
}

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
    expect(result).toEqual({
      signature: "sigHappy",
      slot: 42,
      confirmed: true,
      earlierBroadcastsDead: true,
    });
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
    expect(result).toEqual({
      signature: "sigCreated",
      slot: 7,
      confirmed: true,
      earlierBroadcastsDead: true,
    });
    expect(sendSpy).toHaveBeenCalledOnce();
  });

  // ── #885/#920: the ATA creation is IDEMPOTENT ──
  // A non-idempotent create fails if the account exists, so a re-signed
  // attempt after an earlier one created it would land-and-fail every time.
  it("creates a missing destination ATA with the IDEMPOTENT instruction (data [1]), on every attempt", async () => {
    const adapter = makeAdapterForTx();
    const conn = adapter.getConnection();
    getAccountMock
      .mockResolvedValueOnce({ amount: 10_000_000n })
      .mockRejectedValueOnce(new TokenAccountNotFoundError());
    vi.spyOn(conn, "getLatestBlockhash").mockResolvedValue({
      blockhash: validBlockhash(),
      lastValidBlockHeight: 100,
    });
    chainSays(conn, { height: 150, slot: 1_000, statusSlot: 1_000, status: null });
    const sendSpy = vi
      .spyOn(conn, "sendRawTransaction")
      .mockResolvedValueOnce("sigA")
      .mockResolvedValue("sigB");
    vi.spyOn(conn, "confirmTransaction")
      .mockRejectedValueOnce(new Error("Signature sigA has expired: block height exceeded."))
      .mockResolvedValue({ context: { slot: 5 }, value: { err: null } });

    await adapter.sendUsdc({ toAddress: validBase58Address(), microAmount: 1n });
    expect(sendSpy).toHaveBeenCalledTimes(2);
    for (const call of sendSpy.mock.calls) {
      expect(ataInstructionData(call[0])).toEqual([[1]]);
    }
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

  // ── Blockhash-expiry retry (#885 round 3): ASK the chain before re-signing ──
  //
  // web3.js reports "block height exceeded" when it stopped HEARING about the
  // tx, not when the tx failed to land. The adapter re-signs only on a
  // definitive `expired`; a landed first tx IS the payment.

  it("expiry + the chain confirms the first tx is dead ⇒ re-signs with a FRESH blockhash", async () => {
    const adapter = makeAdapterForTx();
    const conn = adapter.getConnection();
    getAccountMock
      .mockResolvedValueOnce({ amount: 10_000_000n }) // balance
      .mockResolvedValueOnce({ amount: 0n }); // dest exists
    const blockhashSpy = vi.spyOn(conn, "getLatestBlockhash").mockResolvedValue({
      blockhash: validBlockhash(),
      lastValidBlockHeight: 100,
    });
    chainSays(conn, { height: 150, slot: 1_000, statusSlot: 1_000, status: null });
    const sendSpy = vi
      .spyOn(conn, "sendRawTransaction")
      .mockResolvedValueOnce("sigExpired")
      .mockResolvedValue("sigFresh");
    vi.spyOn(conn, "confirmTransaction")
      .mockRejectedValueOnce(new Error("Signature sigExpired has expired: block height exceeded."))
      .mockResolvedValue({ context: { slot: 51 }, value: { err: null } });

    const result = await adapter.sendUsdc({
      toAddress: validBase58Address(),
      microAmount: 1_000_000n,
    });
    expect(result).toEqual({
      signature: "sigFresh",
      slot: 51,
      confirmed: true,
      earlierBroadcastsDead: true,
    });
    expect(blockhashSpy).toHaveBeenCalledTimes(2);
    expect(sendSpy).toHaveBeenCalledTimes(2);
  });

  it("REVIEWER PROBE: expiry, but the first tx LANDED ⇒ returns it; one broadcast, no second payment", async () => {
    const adapter = makeAdapterForTx();
    const conn = adapter.getConnection();
    getAccountMock
      .mockResolvedValueOnce({ amount: 10_000_000n })
      .mockResolvedValueOnce({ amount: 0n });
    const blockhashSpy = vi.spyOn(conn, "getLatestBlockhash").mockResolvedValue({
      blockhash: validBlockhash(),
      lastValidBlockHeight: 100,
    });
    chainSays(conn, {
      height: 150,
      slot: 1_000,
      statusSlot: 1_000,
      status: { confirmationStatus: "confirmed", err: null, slot: 77 },
    });
    const sendSpy = vi.spyOn(conn, "sendRawTransaction");
    sendSpy.mockImplementation(async (raw) =>
      base58Encode(new Uint8Array(Transaction.from(raw as Buffer).signature!)),
    );
    vi.spyOn(conn, "confirmTransaction").mockRejectedValue(
      new Error("Signature x has expired: block height exceeded."),
    );

    const result = await adapter.sendUsdc({ toAddress: validBase58Address(), microAmount: 1n });
    expect(result.confirmed).toBe(true);
    expect(result.slot).toBe(77);
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(blockhashSpy).toHaveBeenCalledTimes(1);
    expect(result.signature).toBe(await sendSpy.mock.results[0]!.value);
  });

  it.each([
    [
      "pending (the status node lags the height read)",
      { height: 150, slot: 1_000, statusSlot: 900, status: null },
    ],
    ["an RPC error", "rpc_error" as const],
  ])("expiry and the chain answer is %s ⇒ throws, never re-signs", async (_n, chain) => {
    const adapter = makeAdapterForTx();
    const conn = adapter.getConnection();
    getAccountMock
      .mockResolvedValueOnce({ amount: 10_000_000n })
      .mockResolvedValueOnce({ amount: 0n });
    vi.spyOn(conn, "getLatestBlockhash").mockResolvedValue({
      blockhash: validBlockhash(),
      lastValidBlockHeight: 100,
    });
    if (chain === "rpc_error") {
      vi.spyOn(conn, "getEpochInfo").mockRejectedValue(new Error("429"));
    } else {
      chainSays(conn, chain);
    }
    const sendSpy = vi.spyOn(conn, "sendRawTransaction").mockResolvedValue("sig");
    vi.spyOn(conn, "confirmTransaction").mockRejectedValue(
      new Error("Signature sig has expired: block height exceeded."),
    );
    await expect(
      adapter.sendUsdc({ toAddress: validBase58Address(), microAmount: 1n }),
    ).rejects.toThrow("block height exceeded");
    expect(sendSpy).toHaveBeenCalledTimes(1);
  });

  it("expiry and the first tx FAILED onchain ⇒ confirmed:false, never re-signed (a failed tx moved nothing; its failure is definitive)", async () => {
    const adapter = makeAdapterForTx();
    const conn = adapter.getConnection();
    getAccountMock
      .mockResolvedValueOnce({ amount: 10_000_000n })
      .mockResolvedValueOnce({ amount: 0n });
    vi.spyOn(conn, "getLatestBlockhash").mockResolvedValue({
      blockhash: validBlockhash(),
      lastValidBlockHeight: 100,
    });
    chainSays(conn, {
      height: 150,
      slot: 1_000,
      statusSlot: 1_000,
      status: { confirmationStatus: "finalized", err: { InstructionError: [0, "x"] }, slot: 7 },
    });
    const sendSpy = vi.spyOn(conn, "sendRawTransaction").mockResolvedValue("sig");
    vi.spyOn(conn, "confirmTransaction").mockRejectedValue(
      new Error("Signature sig has expired: block height exceeded."),
    );
    const r = await adapter.sendUsdc({ toAddress: validBase58Address(), microAmount: 1n });
    expect(r.confirmed).toBe(false);
    expect(sendSpy).toHaveBeenCalledTimes(1);
    // One broadcast: nothing earlier can land, so a refund on this failure is safe.
    expect(r.earlierBroadcastsDead).toBe(true);
  });

  // ── Realistic heights (#885 round 4): web3.js raises the expiry at
  //    lastValid+1 — inside the absence margin — so the adapter must keep
  //    asking until the chain is decisive.

  it("REALISTIC: expiry at lastValid+1, first tx dead, chain advancing ⇒ re-signs once past the margin; 2 sends", async () => {
    const adapter = makeAdapterForTx();
    const conn = adapter.getConnection();
    getAccountMock
      .mockResolvedValueOnce({ amount: 10_000_000n })
      .mockResolvedValueOnce({ amount: 0n });
    vi.spyOn(conn, "getLatestBlockhash").mockResolvedValue({
      blockhash: validBlockhash(),
      lastValidBlockHeight: 100,
    });
    const chain = advancingChain(conn, { lastValid: 100, step: 3 });
    const sendSpy = vi
      .spyOn(conn, "sendRawTransaction")
      .mockResolvedValueOnce("sigA")
      .mockResolvedValue("sigB");
    vi.spyOn(conn, "confirmTransaction")
      .mockRejectedValueOnce(new Error("Signature sigA has expired: block height exceeded."))
      .mockResolvedValue({ context: { slot: 99 }, value: { err: null } });

    const r = await adapter.sendUsdc({ toAddress: validBase58Address(), microAmount: 1n });
    expect(r).toEqual({
      signature: "sigB",
      slot: 99,
      confirmed: true,
      earlierBroadcastsDead: true,
    });
    expect(sendSpy).toHaveBeenCalledTimes(2);
    expect(chain.reads()).toBeGreaterThan(1); // it waited out the margin
  });

  it("REALISTIC: expiry at lastValid+1 and the first tx LANDED ⇒ returns it; 1 send", async () => {
    const adapter = makeAdapterForTx();
    const conn = adapter.getConnection();
    getAccountMock
      .mockResolvedValueOnce({ amount: 10_000_000n })
      .mockResolvedValueOnce({ amount: 0n });
    vi.spyOn(conn, "getLatestBlockhash").mockResolvedValue({
      blockhash: validBlockhash(),
      lastValidBlockHeight: 100,
    });
    const sendSpy = vi.spyOn(conn, "sendRawTransaction");
    let first = "";
    sendSpy.mockImplementation(async (raw) => {
      first = base58Encode(new Uint8Array(Transaction.from(raw as Buffer).signature!));
      return first;
    });
    const landed = new Set<string>();
    vi.spyOn(conn, "confirmTransaction").mockImplementation(async () => {
      landed.add(first);
      throw new Error("Signature x has expired: block height exceeded.");
    });
    advancingChain(conn, { lastValid: 100, step: 1, landed });

    const r = await adapter.sendUsdc({ toAddress: validBase58Address(), microAmount: 1n });
    expect(r.confirmed).toBe(true);
    expect(r.signature).toBe(first);
    expect(sendSpy).toHaveBeenCalledTimes(1);
  });

  it("REVIEWER PROBE S1 (sticky pending): seen in a block, then 'absent' from a caught-up node ⇒ never re-signed; 1 send", async () => {
    const adapter = makeAdapterForTx();
    const conn = adapter.getConnection();
    getAccountMock
      .mockResolvedValueOnce({ amount: 10_000_000n })
      .mockResolvedValueOnce({ amount: 0n });
    vi.spyOn(conn, "getLatestBlockhash").mockResolvedValue({
      blockhash: validBlockhash(),
      lastValidBlockHeight: 100,
    });
    // Status read 1: the tx is in a block (processed). Every later read: a
    // node on a minority fork, caught up by slot NUMBER, answers null — and
    // the finalized height sits inside the fresh window (lastValid+12).
    let statusReads = 0;
    vi.spyOn(conn, "getEpochInfo").mockResolvedValue({
      blockHeight: 112,
      absoluteSlot: 5_011,
    } as never);
    vi.spyOn(conn, "getSignatureStatuses").mockImplementation(async () => {
      statusReads++;
      return (
        statusReads === 1
          ? {
              context: { slot: 5_000 },
              value: [
                { confirmationStatus: "processed", err: null, slot: 4_999, confirmations: 0 },
              ],
            }
          : { context: { slot: 5_011 }, value: [null] }
      ) as never;
    });
    const sendSpy = vi.spyOn(conn, "sendRawTransaction").mockResolvedValue("sigA");
    vi.spyOn(conn, "confirmTransaction").mockRejectedValue(
      new Error("Signature sigA has expired: block height exceeded."),
    );
    await expect(
      adapter.sendUsdc({ toAddress: validBase58Address(), microAmount: 1n }),
    ).rejects.toThrow("block height exceeded");
    expect(sendSpy).toHaveBeenCalledTimes(1);
  });

  it("a 'processed' adapter never DECIDES at processed: confirmation and the height read run at confirmed", async () => {
    let t = 0;
    const adapter = new Web3JsRpcAdapter({
      rpcUrl: "https://api.devnet.solana.com",
      identitySeed: ZERO_SEED,
      commitment: "processed",
      expiryConfirm: { now: () => t, sleep: (ms) => ((t += ms), Promise.resolve()) },
    });
    const conn = adapter.getConnection();
    getAccountMock
      .mockResolvedValueOnce({ amount: 10_000_000n })
      .mockResolvedValueOnce({ amount: 0n });
    vi.spyOn(conn, "getLatestBlockhash").mockResolvedValue({
      blockhash: validBlockhash(),
      lastValidBlockHeight: 100,
    });
    vi.spyOn(conn, "sendRawTransaction").mockResolvedValue("sigA");
    const confirm = vi
      .spyOn(conn, "confirmTransaction")
      .mockRejectedValue(new Error("Signature sigA has expired: block height exceeded."));
    const epoch = vi
      .spyOn(conn, "getEpochInfo")
      .mockResolvedValue({ blockHeight: 500, absoluteSlot: 9_000 } as never);
    vi.spyOn(conn, "getSignatureStatuses").mockResolvedValue({
      context: { slot: 9_000 },
      value: [{ confirmationStatus: "confirmed", err: null, slot: 42, confirmations: 1 }],
    } as never);
    await adapter.sendUsdc({ toAddress: validBase58Address(), microAmount: 1n });
    expect(confirm.mock.calls[0]?.[1]).toBe("confirmed");
    // Any height read is the fresh verdict's, at finalized (#949 round 5).
    for (const call of epoch.mock.calls) expect(call[0]).toMatchObject({ commitment: "finalized" });
  });

  it("REALISTIC: still inside the margin when the poll cap ends ⇒ throws; 1 send, never a re-sign on a maybe", async () => {
    const adapter = makeAdapterForTx();
    const conn = adapter.getConnection();
    getAccountMock
      .mockResolvedValueOnce({ amount: 10_000_000n })
      .mockResolvedValueOnce({ amount: 0n });
    vi.spyOn(conn, "getLatestBlockhash").mockResolvedValue({
      blockhash: validBlockhash(),
      lastValidBlockHeight: 100,
    });
    const chain = advancingChain(conn, { lastValid: 100, step: 0 }); // a stalled chain
    const sendSpy = vi.spyOn(conn, "sendRawTransaction").mockResolvedValue("sigA");
    vi.spyOn(conn, "confirmTransaction").mockRejectedValue(
      new Error("Signature sigA has expired: block height exceeded."),
    );
    await expect(
      adapter.sendUsdc({ toAddress: validBase58Address(), microAmount: 1n }),
    ).rejects.toThrow("block height exceeded");
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(chain.reads()).toBeGreaterThan(5); // it did poll, then gave up at the cap
  });

  it("the default poll waits on the REAL clock (no injected sleep/now): a stalled chain still ends at the cap, 1 send", async () => {
    const adapter = new Web3JsRpcAdapter({
      rpcUrl: "https://api.devnet.solana.com",
      identitySeed: ZERO_SEED,
      expiryConfirm: { pollMs: 5, maxWaitMs: 40 }, // default sleep + Date.now
    });
    const conn = adapter.getConnection();
    getAccountMock
      .mockResolvedValueOnce({ amount: 10_000_000n })
      .mockResolvedValueOnce({ amount: 0n });
    vi.spyOn(conn, "getLatestBlockhash").mockResolvedValue({
      blockhash: validBlockhash(),
      lastValidBlockHeight: 100,
    });
    const chain = advancingChain(conn, { lastValid: 100, step: 0 });
    const sendSpy = vi.spyOn(conn, "sendRawTransaction").mockResolvedValue("sigA");
    vi.spyOn(conn, "confirmTransaction").mockRejectedValue(
      new Error("Signature sigA has expired: block height exceeded."),
    );
    const started = Date.now();
    await expect(
      adapter.sendUsdc({ toAddress: validBase58Address(), microAmount: 1n }),
    ).rejects.toThrow("block height exceeded");
    expect(Date.now() - started).toBeGreaterThanOrEqual(35); // it really waited
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(chain.reads()).toBeGreaterThan(1);
  });

  it("gives up after BROADCAST_MAX_ATTEMPTS when every attempt is confirmed dead", async () => {
    const adapter = makeAdapterForTx();
    const conn = adapter.getConnection();
    getAccountMock
      .mockResolvedValueOnce({ amount: 10_000_000n })
      .mockResolvedValueOnce({ amount: 0n });
    const blockhashSpy = vi.spyOn(conn, "getLatestBlockhash").mockResolvedValue({
      blockhash: validBlockhash(),
      lastValidBlockHeight: 100,
    });
    chainSays(conn, { height: 150, slot: 1_000, statusSlot: 1_000, status: null });
    vi.spyOn(conn, "sendRawTransaction").mockResolvedValue("sig");
    const confirmSpy = vi
      .spyOn(conn, "confirmTransaction")
      .mockRejectedValue(new Error("Signature sig has expired: block height exceeded."));

    await expect(
      adapter.sendUsdc({ toAddress: validBase58Address(), microAmount: 1n }),
    ).rejects.toThrow("block height exceeded");
    expect(blockhashSpy).toHaveBeenCalledTimes(3);
    expect(confirmSpy).toHaveBeenCalledTimes(3);
  });

  it("does NOT retry a non-expiry error — a confirmation timeout may still land (no double-spend)", async () => {
    const adapter = makeAdapterForTx();
    const conn = adapter.getConnection();
    getAccountMock
      .mockResolvedValueOnce({ amount: 10_000_000n })
      .mockResolvedValueOnce({ amount: 0n });
    const blockhashSpy = vi.spyOn(conn, "getLatestBlockhash").mockResolvedValue({
      blockhash: validBlockhash(),
      lastValidBlockHeight: 100,
    });
    vi.spyOn(conn, "sendRawTransaction").mockResolvedValue("sig");
    vi.spyOn(conn, "confirmTransaction").mockRejectedValue(
      new Error("Transaction was not confirmed in 30.00 seconds"),
    );

    await expect(
      adapter.sendUsdc({ toAddress: validBase58Address(), microAmount: 1n }),
    ).rejects.toThrow("not confirmed");
    expect(blockhashSpy).toHaveBeenCalledTimes(1);
  });
});

// ── sendUsdcBatch ─────────────────────────────────────────────────────────
//
// Multi-recipient USDC transfer. Lock the chunk boundary and the
// fail-fast contract: once a chunk fails, subsequent chunks are NOT
// submitted; their items return ok=false with reason "prior chunk failed".

// ── #885: sign, report the signature, THEN send ──────────────────────────

describe("Web3JsRpcAdapter — beforeBroadcast sees the signed tx before it is sent", () => {
  function primed() {
    const adapter = makeAdapterForTx();
    const conn = adapter.getConnection();
    getAccountMock
      .mockResolvedValueOnce({ amount: 10_000_000n })
      .mockResolvedValueOnce({ amount: 0n });
    vi.spyOn(conn, "getLatestBlockhash").mockResolvedValue({
      blockhash: validBlockhash(),
      lastValidBlockHeight: 321,
    });
    const send = vi.spyOn(conn, "sendRawTransaction");
    vi.spyOn(conn, "confirmTransaction").mockResolvedValue({
      context: { slot: 1 },
      value: { err: null },
    });
    return { adapter, send };
  }

  it("reports the exact signature that is then sent, before sending", async () => {
    const { adapter, send } = primed();
    const seen: Array<{ signature: string; lastValidBlockHeight: number }> = [];
    const hook = vi.fn((tx: { signature: string; lastValidBlockHeight: number }) => {
      seen.push(tx);
    });
    send.mockImplementation(async (raw) => {
      const tx = Transaction.from(raw as Buffer);
      return base58Encode(new Uint8Array(tx.signature!));
    });
    const r = await adapter.sendUsdc(
      { toAddress: validBase58Address(), microAmount: 1n },
      { beforeBroadcast: hook },
    );
    expect(seen).toEqual([{ signature: r.signature, lastValidBlockHeight: 321 }]);
    expect(hook.mock.invocationCallOrder[0]!).toBeLessThan(send.mock.invocationCallOrder[0]!);
  });

  it("declares honorsBroadcastHooks — the flag the rail's confirmer depends on", () => {
    expect(makeAdapterForTx().honorsBroadcastHooks).toBe(true);
  });

  it("a hook that throws ⇒ nothing is sent", async () => {
    const { adapter, send } = primed();
    await expect(
      adapter.sendUsdc(
        { toAddress: validBase58Address(), microAmount: 1n },
        {
          beforeBroadcast: () => {
            throw new Error("SQLITE_BUSY");
          },
        },
      ),
    ).rejects.toThrow("SQLITE_BUSY");
    expect(send).not.toHaveBeenCalled();
  });
});

describe("Web3JsRpcAdapter.getSignatureOutcome — about ONE transaction (#949 round 5)", () => {
  function withChain(opts: {
    height: number;
    slot?: number;
    statusSlot?: number;
    status: null | { confirmationStatus: string; err: unknown; slot: number };
    historyStatus?: null | { confirmationStatus: string; err: unknown; slot: number };
  }) {
    const adapter = makeAdapterForTx();
    const conn = adapter.getConnection();
    const order: string[] = [];
    vi.spyOn(conn, "getEpochInfo").mockImplementation(async () => {
      order.push("epoch");
      return { blockHeight: opts.height, absoluteSlot: opts.slot ?? 1_000 } as never;
    });
    const statuses = vi.spyOn(conn, "getSignatureStatuses").mockImplementation(async (_s, cfg) => {
      const history = (cfg as { searchTransactionHistory?: boolean } | undefined)
        ?.searchTransactionHistory;
      order.push(history === true ? "history" : "fresh");
      return {
        context: { slot: opts.statusSlot ?? opts.slot ?? 1_000 },
        value: [
          history === true && opts.historyStatus !== undefined ? opts.historyStatus : opts.status,
        ],
      } as never;
    });
    return { adapter, order, statuses };
  }
  const ref = { signature: "sigX", lastValidBlockHeight: 100 };

  it("confirmed and succeeded ⇒ landed; confirmed with an error ⇒ failed", async () => {
    const ok = withChain({
      height: 50,
      status: { confirmationStatus: "confirmed", err: null, slot: 7 },
    });
    await expect(ok.adapter.getSignatureOutcome(ref)).resolves.toEqual({
      status: "landed",
      slot: 7,
    });
    const bad = withChain({
      height: 50,
      status: { confirmationStatus: "finalized", err: { InstructionError: [0, "x"] }, slot: 7 },
    });
    await expect(bad.adapter.getSignatureOutcome(ref)).resolves.toEqual({ status: "failed" });
  });

  it("absent, inside the fresh window (finalized status cache, caught-up node) ⇒ expired", async () => {
    const gone = withChain({ height: 150, slot: 5_000, statusSlot: 5_000, status: null });
    await expect(gone.adapter.getSignatureOutcome(ref)).resolves.toEqual({ status: "expired" });
  });

  it("round 5: absent in HISTORY past the fresh window (snapshot gap, pruned, BigTable error) ⇒ pending, never expired", async () => {
    const late = withChain({ height: 100_000, slot: 5_000, statusSlot: 5_000, status: null });
    await expect(late.adapter.getSignatureOutcome(ref)).resolves.toEqual({ status: "pending" });
  });

  it("a tx that landed LONG ago still reads landed — history is read for POSITIVE facts", async () => {
    const old = withChain({
      height: 900_000,
      status: null,
      historyStatus: { confirmationStatus: "finalized", err: null, slot: 77 },
    });
    await expect(old.adapter.getSignatureOutcome(ref)).resolves.toEqual({
      status: "landed",
      slot: 77,
    });
  });

  it("REVIEWER PROBE: absent from a node behind minContextSlot ⇒ never expired", async () => {
    const lag = withChain({ height: 150, slot: 5_000, statusSlot: 4_990, status: null });
    const out = await lag.adapter.getSignatureOutcome(ref);
    expect(out.status).not.toBe("expired");
  });

  it("absent, and not yet FRESH_WINDOW_START past lastValid (finalized) ⇒ pending", async () => {
    const edge = withChain({ height: 110, status: null });
    await expect(edge.adapter.getSignatureOutcome(ref)).resolves.toEqual({ status: "pending" });
    const live = withChain({ height: 100, status: null });
    await expect(live.adapter.getSignatureOutcome(ref)).resolves.toEqual({ status: "pending" });
  });

  it("reads history first; only on absence, the fresh verdict: height, cache-only status, height", async () => {
    const { adapter, order } = withChain({ height: 150, status: null });
    await adapter.getSignatureOutcome(ref);
    expect(order).toEqual(["history", "epoch", "fresh", "epoch"]);
  });

  it("a history read that throws ⇒ rpc_error, never absence (no fresh read on a failed read)", async () => {
    const adapter = makeAdapterForTx();
    const conn = adapter.getConnection();
    vi.spyOn(conn, "getSignatureStatuses").mockRejectedValue(new Error("history 503"));
    const epoch = vi.spyOn(conn, "getEpochInfo");
    await expect(adapter.getSignatureOutcome(ref)).resolves.toEqual({
      status: "rpc_error",
      reason: "history 503",
    });
    expect(epoch).not.toHaveBeenCalled();
  });

  it("absent from history but found by the fresh (status-cache) read ⇒ its found status decides", async () => {
    const landed = withChain({
      height: 150,
      status: { confirmationStatus: "finalized", err: null, slot: 11 },
      historyStatus: null,
    });
    await expect(landed.adapter.getSignatureOutcome(ref)).resolves.toEqual({
      status: "landed",
      slot: 11,
    });
    const failed = withChain({
      height: 150,
      status: { confirmationStatus: "finalized", err: { x: 1 }, slot: 11 },
      historyStatus: null,
    });
    await expect(failed.adapter.getSignatureOutcome(ref)).resolves.toEqual({ status: "failed" });
  });

  it("processed but not yet confirmed ⇒ pending (seen); an RPC failure ⇒ rpc_error", async () => {
    const proc = withChain({
      height: 500,
      status: { confirmationStatus: "processed", err: null, slot: 3 },
    });
    await expect(proc.adapter.getSignatureOutcome(ref)).resolves.toEqual({
      status: "pending",
      seen: true, // in a block: a later "absent" for it is never believed
    });
    const adapter = makeAdapterForTx();
    vi.spyOn(adapter.getConnection(), "getSignatureStatuses").mockResolvedValue({
      context: { slot: 1 },
      value: [null],
    } as never);
    vi.spyOn(adapter.getConnection(), "getEpochInfo").mockRejectedValue(new Error("429"));
    await expect(adapter.getSignatureOutcome(ref)).resolves.toEqual({
      status: "rpc_error",
      reason: "429",
    });
  });
});

describe("Web3JsRpcAdapter.getFreshSignatureVerdict (#949 round 5)", () => {
  // lastValid = 100: the window is finalized heights 111..230.
  const ref = { signature: "sigF", lastValidBlockHeight: 100 };
  function fresh(opts: {
    heights: number[];
    status?: null | { err: unknown; slot: number };
    contextSlot?: number;
    slot?: number;
  }) {
    const adapter = makeAdapterForTx();
    const conn = adapter.getConnection();
    let i = 0;
    const epoch = vi.spyOn(conn, "getEpochInfo").mockImplementation(async () => {
      const h = opts.heights[Math.min(i, opts.heights.length - 1)]!;
      i++;
      return { blockHeight: h, absoluteSlot: opts.slot ?? 5_000 } as never;
    });
    const statuses = vi.spyOn(conn, "getSignatureStatuses").mockResolvedValue({
      context: { slot: opts.contextSlot ?? opts.slot ?? 5_000 },
      value: [
        opts.status == null
          ? null
          : { ...opts.status, confirmationStatus: "finalized", confirmations: null },
      ],
    } as never);
    return { adapter, epoch, statuses };
  }

  it("the window bounds, exactly: +10 too early, +11 and +130 dead, +131 passed", async () => {
    expect(FRESH_WINDOW_START).toBe(11);
    expect(FRESH_WINDOW_END).toBe(130);
    await expect(fresh({ heights: [110] }).adapter.getFreshSignatureVerdict(ref)).resolves.toEqual({
      status: "too_early",
    });
    await expect(
      fresh({ heights: [111, 111] }).adapter.getFreshSignatureVerdict(ref),
    ).resolves.toEqual({ status: "dead_fresh", contextSlot: 5_000 });
    await expect(
      fresh({ heights: [230, 230] }).adapter.getFreshSignatureVerdict(ref),
    ).resolves.toEqual({ status: "dead_fresh", contextSlot: 5_000 });
    await expect(fresh({ heights: [231] }).adapter.getFreshSignatureVerdict(ref)).resolves.toEqual({
      status: "window_passed",
    });
  });

  it("the answering bank must still be in the window: a second height read past it ⇒ window_passed", async () => {
    await expect(
      fresh({ heights: [200, 231] }).adapter.getFreshSignatureVerdict(ref),
    ).resolves.toEqual({ status: "window_passed" });
  });

  it("reads the status cache only — no history search — at finalized, bound by minContextSlot; then the height with minContextSlot = the answer's slot", async () => {
    const { adapter, epoch, statuses } = fresh({
      heights: [150, 150],
      slot: 7_000,
      contextSlot: 7_100,
    });
    await adapter.getFreshSignatureVerdict(ref);
    expect(statuses.mock.calls[0]?.[1]).toEqual({
      searchTransactionHistory: false,
      commitment: "finalized",
      minContextSlot: 7_000,
    });
    expect(epoch.mock.calls[0]?.[0]).toEqual({ commitment: "finalized" });
    expect(epoch.mock.calls[1]?.[0]).toEqual({ commitment: "finalized", minContextSlot: 7_100 });
  });

  it("a found status is positive evidence whatever the window: landed, or failed", async () => {
    await expect(
      fresh({ heights: [900], status: { err: null, slot: 42 } }).adapter.getFreshSignatureVerdict(
        ref,
      ),
    ).resolves.toEqual({ status: "landed", slot: 42, contextSlot: 5_000 });
    await expect(
      fresh({
        heights: [900],
        status: { err: { x: 1 }, slot: 42 },
      }).adapter.getFreshSignatureVerdict(ref),
    ).resolves.toEqual({ status: "failed", contextSlot: 5_000 });
  });

  it("a node that answers from behind minContextSlot, or any read failure ⇒ rpc_error, never dead", async () => {
    const lag = await fresh({
      heights: [150, 150],
      slot: 5_000,
      contextSlot: 4_999,
    }).adapter.getFreshSignatureVerdict(ref);
    expect(lag.status).toBe("rpc_error");
    const adapter = makeAdapterForTx();
    vi.spyOn(adapter.getConnection(), "getEpochInfo").mockRejectedValue(new Error("down"));
    expect((await adapter.getFreshSignatureVerdict(ref)).status).toBe("rpc_error");
  });
});

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
    expect(results).toEqual([
      { ok: true, signature: "sigSingle", slot: 1, reason: null, earlierBroadcastsDead: true },
    ]);
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
      { ok: true, signature: "sigMulti", slot: 200, reason: null, earlierBroadcastsDead: true },
      { ok: true, signature: "sigMulti", slot: 200, reason: null, earlierBroadcastsDead: true },
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

  it("the atomic multi-output P2P tx retries with a fresh blockhash on expiry (the conformance flake)", async () => {
    // This is exactly the failure that reset the promotion clock: the 2-leg
    // (worker + treasury) atomic P2P payment expired before confirmation. It must
    // rebuild with a fresh blockhash and settle both legs in ONE new tx.
    const adapter = makeAdapterForTx();
    const conn = adapter.getConnection();
    getAccountMock.mockImplementation(async () => ({ amount: 10_000_000n }));
    const blockhashSpy = vi.spyOn(conn, "getLatestBlockhash").mockResolvedValue({
      blockhash: validBlockhash(),
      lastValidBlockHeight: 200,
    });
    // The chain confirms the first tx is dead before the adapter re-signs.
    chainSays(conn, { height: 250, slot: 2_000, statusSlot: 2_000, status: null });
    vi.spyOn(conn, "sendRawTransaction")
      .mockResolvedValueOnce("sigExpired")
      .mockResolvedValue("sigFresh");
    vi.spyOn(conn, "confirmTransaction")
      .mockRejectedValueOnce(new Error("Signature sigExpired has expired: block height exceeded."))
      .mockResolvedValue({ context: { slot: 210 }, value: { err: null } });

    const results = await adapter.sendUsdcBatch([
      { toAddress: validBase58Address(), microAmount: 3000n }, // worker leg
      { toAddress: validBase58Address(), microAmount: 158n }, // treasury fee leg
    ]);
    // Both legs settled atomically on the fresh signature.
    expect(results).toEqual([
      { ok: true, signature: "sigFresh", slot: 210, reason: null, earlierBroadcastsDead: true },
      { ok: true, signature: "sigFresh", slot: 210, reason: null, earlierBroadcastsDead: true },
    ]);
    expect(blockhashSpy).toHaveBeenCalledTimes(2);
  });

  it("batch: a missing recipient ATA is created with the IDEMPOTENT instruction", async () => {
    const adapter = makeAdapterForTx();
    const conn = adapter.getConnection();
    getAccountMock
      .mockResolvedValueOnce({ amount: 10_000_000n })
      .mockResolvedValueOnce({ amount: 0n })
      .mockRejectedValueOnce(new TokenAccountNotFoundError());
    vi.spyOn(conn, "getLatestBlockhash").mockResolvedValue({
      blockhash: validBlockhash(),
      lastValidBlockHeight: 1,
    });
    const sendSpy = vi.spyOn(conn, "sendRawTransaction").mockResolvedValue("sigIdem");
    vi.spyOn(conn, "confirmTransaction").mockResolvedValue({
      context: { slot: 7 },
      value: { err: null },
    });
    await adapter.sendUsdcBatch([
      { toAddress: validBase58Address(), microAmount: 1n },
      { toAddress: validBase58Address(), microAmount: 2n },
    ]);
    expect(ataInstructionData(sendSpy.mock.calls[0]![0])).toEqual([[1]]);
  });

  it("batch: a chunk whose send ended undecided carries NO earlierBroadcastsDead (unknown, never assumed)", async () => {
    const adapter = makeAdapterForTx();
    const conn = adapter.getConnection();
    getAccountMock.mockImplementation(async () => ({ amount: 100_000_000n }));
    vi.spyOn(conn, "getLatestBlockhash").mockResolvedValue({
      blockhash: validBlockhash(),
      lastValidBlockHeight: 100,
    });
    // The chain cannot say (status node lags) ⇒ the chunk throws.
    chainSays(conn, { height: 150, slot: 1_000, statusSlot: 900, status: null });
    const sendSpy = vi.spyOn(conn, "sendRawTransaction").mockResolvedValue("sigMaybe");
    vi.spyOn(conn, "confirmTransaction").mockRejectedValue(
      new Error("Signature sigMaybe has expired: block height exceeded."),
    );
    const results = await adapter.sendUsdcBatch([
      { toAddress: validBase58Address(), microAmount: 1n },
      { toAddress: validBase58Address(), microAmount: 2n },
    ]);
    expect(sendSpy).toHaveBeenCalledTimes(1);
    for (const r of results) {
      expect(r.ok).toBe(false);
      expect(r).not.toHaveProperty("earlierBroadcastsDead");
    }
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

  // Batch recipient has no ATA yet — the batch path must add a
  // createAssociatedTokenAccountInstruction before the transfer.
  // Covers web3js-adapter.ts lines 270-279 (the if-!destExists branch
  // inside the batch loop, distinct from the single-item sendUsdc path).
  // Uses 2 items so sendUsdcBatch doesn't shortcut to sendUsdc.
  it("adds a create-ATA instruction when a batch recipient has no ATA yet", async () => {
    const adapter = makeAdapterForTx();
    const conn = adapter.getConnection();
    // 1st getAccount = own balance; 2nd = dest A (exists); 3rd = dest B (missing).
    getAccountMock
      .mockResolvedValueOnce({ amount: 10_000_000n })
      .mockResolvedValueOnce({ amount: 0n })
      .mockImplementationOnce(() => {
        throw new TokenAccountNotFoundError();
      });
    vi.spyOn(conn, "getLatestBlockhash").mockResolvedValue({
      blockhash: validBlockhash(),
      lastValidBlockHeight: 1,
    });
    vi.spyOn(conn, "sendRawTransaction").mockResolvedValue("sigCreateAta");
    vi.spyOn(conn, "confirmTransaction").mockResolvedValue({
      context: { slot: 7 },
      value: { err: null },
    });

    const results = await adapter.sendUsdcBatch([
      { toAddress: validBase58Address(), microAmount: 1n },
      { toAddress: validBase58Address(), microAmount: 2n },
    ]);
    expect(results).toHaveLength(2);
    expect(results[0]!.ok).toBe(true);
    expect(results[1]!.ok).toBe(true);
    // Both items share the chunk signature — the tx that was built
    // includes the create-ATA instruction for the second recipient.
    expect(results[0]!.signature).toBe("sigCreateAta");
    expect(results[1]!.signature).toBe("sigCreateAta");
  });

  // A non-TokenAccountNotFoundError from getAccount during the batch
  // path (e.g. a legitimate RPC error) must rethrow rather than assume
  // the ATA is missing. Covers web3js-adapter.ts lines 268-269 inside
  // the batch loop. Uses 2 items so sendUsdcBatch doesn't shortcut to
  // sendUsdc (whose analogous code path lives at lines 168-170).
  it("rethrows non-TokenAccountNotFoundError from getAccount during batch ATA check", async () => {
    const adapter = makeAdapterForTx();
    // 1st getAccount = own balance; 2nd = first recipient ATA (fine);
    // 3rd = second recipient ATA — an unrelated RPC failure that the
    // batch's outer chunk catch turns into a failure for the whole chunk.
    getAccountMock
      .mockResolvedValueOnce({ amount: 10_000_000n })
      .mockResolvedValueOnce({ amount: 0n })
      .mockImplementationOnce(() => {
        throw new Error("RPC down");
      });
    vi.spyOn(adapter.getConnection(), "getLatestBlockhash").mockResolvedValue({
      blockhash: validBlockhash(),
      lastValidBlockHeight: 1,
    });

    const results = await adapter.sendUsdcBatch([
      { toAddress: validBase58Address(), microAmount: 1n },
      { toAddress: validBase58Address(), microAmount: 2n },
    ]);
    expect(results).toHaveLength(2);
    for (const r of results) {
      expect(r.ok).toBe(false);
      expect(r.reason).toContain("RPC down");
    }
  });
});

// ── deriveSolanaAddress ──────────────────────────────────────────────────

describe("deriveSolanaAddress", () => {
  it("returns a base58 address for a valid 32-byte Ed25519 public key", () => {
    const kp = Keypair.generate();
    const address = deriveSolanaAddress(kp.publicKey.toBytes());
    expect(address).toBe(kp.publicKey.toBase58());
  });

  it("is deterministic for a given public key", () => {
    const kp = Keypair.generate();
    const a = deriveSolanaAddress(kp.publicKey.toBytes());
    const b = deriveSolanaAddress(kp.publicKey.toBytes());
    expect(a).toBe(b);
  });

  it("throws a labeled error when the public key is not 32 bytes", () => {
    expect(() => deriveSolanaAddress(new Uint8Array(16))).toThrow(
      /expects a 32-byte Ed25519 public key, got 16 bytes/,
    );
    expect(() => deriveSolanaAddress(new Uint8Array(64))).toThrow(
      /expects a 32-byte Ed25519 public key, got 64 bytes/,
    );
    expect(() => deriveSolanaAddress(new Uint8Array(0))).toThrow(
      /expects a 32-byte Ed25519 public key, got 0 bytes/,
    );
  });

  // Byte-compat regression guard for the base58 relocation (#110): deriveSolanaAddress
  // now delegates to `@motebit/protocol`'s base58Encode instead of PublicKey.toBase58().
  // This must remain byte-identical to web3.js across ALL pubkeys, including
  // leading-zero keys (which exercise the base58 leading-'1' path) — a mismatch
  // would silently change sovereign addresses.
  it("is byte-identical to PublicKey.toBase58() across many random keys", () => {
    for (let i = 0; i < 256; i++) {
      const pk = Keypair.generate().publicKey;
      expect(deriveSolanaAddress(pk.toBytes())).toBe(pk.toBase58());
    }
  });

  it("matches web3.js for leading-zero public keys (the base58 '1'-prefix path)", () => {
    for (const leadingZeros of [1, 2, 5, 31]) {
      const bytes = new Uint8Array(32);
      for (let i = leadingZeros; i < 32; i++) bytes[i] = (i * 73 + 19) & 0xff || 1;
      expect(deriveSolanaAddress(bytes)).toBe(new PublicKey(bytes).toBase58());
    }
    // All-zero key → the Solana System Program id.
    expect(deriveSolanaAddress(new Uint8Array(32))).toBe(
      new PublicKey(new Uint8Array(32)).toBase58(),
    );
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

describe("isDerivedSettlementBinding — the derived settlement-authority rung", () => {
  const key = new Uint8Array(32).fill(7);
  const keyHex = Array.from(key)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const derivedAddress = deriveSolanaAddress(key);

  it("true when the address IS the key's own Solana address (tautological binding)", () => {
    expect(isDerivedSettlementBinding(derivedAddress, keyHex)).toBe(true);
  });

  it("false for a DIFFERENT address (a distinct payout wallet — the signed-bound case)", () => {
    const other = deriveSolanaAddress(new Uint8Array(32).fill(9));
    expect(isDerivedSettlementBinding(other, keyHex)).toBe(false);
  });

  it("fail-closed on a malformed public key (never throws, returns false)", () => {
    expect(isDerivedSettlementBinding(derivedAddress, "not-hex")).toBe(false);
    expect(isDerivedSettlementBinding(derivedAddress, "aa")).toBe(false); // too short
    expect(isDerivedSettlementBinding(derivedAddress, keyHex.toUpperCase())).toBe(true); // hex case-insensitive
  });
});
