/**
 * SolanaMemoSubmitter tests — memo encoding, parsing, and adapter boundary.
 *
 * Two sections:
 *
 *   1. Pure parsing (`parseMemoAnchor` / `parseRevocationMemo`) + construction
 *      validation. No network dependency.
 *   2. Submission + availability under a mocked `@solana/web3.js` Connection
 *      — verifies memo bytes, signer pubkey, and tx lifecycle without
 *      hitting Solana. The mock preserves Keypair / PublicKey / Transaction
 *      so address derivation stays real.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Keypair } from "@solana/web3.js";

// ── Mock the Connection class with deterministic in-memory behavior ──
// We need `Connection(...)` to return a stub, but keep every other
// `@solana/web3.js` export real (Keypair / PublicKey / Transaction /
// TransactionInstruction — these are all pure data/crypto classes used
// by the submitter's sign + serialize path).
const latestBlockhashMock = vi.fn();
const sendRawTransactionMock = vi.fn();
const confirmTransactionMock = vi.fn();
const getBalanceMock = vi.fn();

vi.mock("@solana/web3.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@solana/web3.js")>();
  class MockConnection {
    constructor(_rpcUrl: string, _commitment?: unknown) {
      // record the args for assertions if ever needed
    }
    getLatestBlockhash = latestBlockhashMock;
    sendRawTransaction = sendRawTransactionMock;
    confirmTransaction = confirmTransactionMock;
    getBalance = getBalanceMock;
  }
  return {
    ...actual,
    Connection: MockConnection,
  };
});

import {
  parseMemoAnchor,
  parseRevocationMemo,
  SolanaMemoSubmitter,
  SOLANA_MAINNET_CAIP2,
  SOLANA_DEVNET_CAIP2,
} from "../memo-submitter.js";

/** A valid base58-encoded 32-byte blockhash — the serializer decodes
 *  `recentBlockhash` and expects exactly 32 bytes. Generating a fresh
 *  keypair and taking its base58 address gives us that cheaply. */
function validBlockhash(): string {
  return Keypair.generate().publicKey.toBase58();
}

// === parseMemoAnchor ===

describe("parseMemoAnchor", () => {
  it("parses a valid memo string", () => {
    const result = parseMemoAnchor(
      "motebit:anchor:v1:abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234:42",
    );
    expect(result).toEqual({
      version: "v1",
      merkleRoot: "abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234",
      leafCount: 42,
    });
  });

  it("returns null for empty string", () => {
    expect(parseMemoAnchor("")).toBeNull();
  });

  it("returns null for wrong prefix", () => {
    expect(parseMemoAnchor("other:anchor:v1:root:10")).toBeNull();
  });

  it("returns null for wrong second segment", () => {
    expect(parseMemoAnchor("motebit:something-else:v1:root:10")).toBeNull();
  });

  it("returns null for non-numeric leaf count", () => {
    expect(parseMemoAnchor("motebit:anchor:v1:root:abc")).toBeNull();
  });

  it("returns null for too few parts", () => {
    expect(parseMemoAnchor("motebit:anchor:v1:root")).toBeNull();
  });

  it("returns null for too many parts", () => {
    expect(parseMemoAnchor("motebit:anchor:v1:root:10:extra")).toBeNull();
  });

  it("handles leaf count of 0", () => {
    const result = parseMemoAnchor("motebit:anchor:v1:root:0");
    expect(result).toEqual({ version: "v1", merkleRoot: "root", leafCount: 0 });
  });
});

// === SolanaMemoSubmitter construction ===

describe("SolanaMemoSubmitter", () => {
  const seed = Keypair.generate().secretKey.slice(0, 32);

  it("rejects non-32-byte seeds", () => {
    expect(
      () =>
        new SolanaMemoSubmitter({
          rpcUrl: "https://api.mainnet-beta.solana.com",
          identitySeed: new Uint8Array(16),
        }),
    ).toThrow("32-byte");
  });

  it("sets chain to solana", () => {
    const submitter = new SolanaMemoSubmitter({
      rpcUrl: "https://api.mainnet-beta.solana.com",
      identitySeed: seed,
    });
    expect(submitter.chain).toBe("solana");
  });

  it("defaults to mainnet CAIP-2 network", () => {
    const submitter = new SolanaMemoSubmitter({
      rpcUrl: "https://api.mainnet-beta.solana.com",
      identitySeed: seed,
    });
    expect(submitter.network).toBe(SOLANA_MAINNET_CAIP2);
  });

  it("accepts custom network", () => {
    const submitter = new SolanaMemoSubmitter({
      rpcUrl: "https://api.devnet.solana.com",
      identitySeed: seed,
      network: SOLANA_DEVNET_CAIP2,
    });
    expect(submitter.network).toBe(SOLANA_DEVNET_CAIP2);
  });

  it("derives address from seed", () => {
    const submitter = new SolanaMemoSubmitter({
      rpcUrl: "https://api.mainnet-beta.solana.com",
      identitySeed: seed,
    });
    // The address should be a valid base58 string
    expect(submitter.address).toMatch(/^[1-9A-HJ-NP-Za-km-z]+$/);

    // Same seed → same address
    const submitter2 = new SolanaMemoSubmitter({
      rpcUrl: "https://api.mainnet-beta.solana.com",
      identitySeed: seed,
    });
    expect(submitter.address).toBe(submitter2.address);
  });

  it("implements ChainAnchorSubmitter interface", () => {
    const submitter = new SolanaMemoSubmitter({
      rpcUrl: "https://api.mainnet-beta.solana.com",
      identitySeed: seed,
    });
    // Verify the interface shape
    expect(typeof submitter.chain).toBe("string");
    expect(typeof submitter.network).toBe("string");
    expect(typeof submitter.submitMerkleRoot).toBe("function");
    expect(typeof submitter.isAvailable).toBe("function");
  });

  it("exposes submitRevocation method", () => {
    const submitter = new SolanaMemoSubmitter({
      rpcUrl: "https://api.mainnet-beta.solana.com",
      identitySeed: seed,
    });
    expect(typeof submitter.submitRevocation).toBe("function");
  });
});

// === parseRevocationMemo ===

describe("parseRevocationMemo", () => {
  it("parses a valid revocation memo string", () => {
    const pubkey = "abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234";
    const result = parseRevocationMemo(`motebit:revocation:v1:${pubkey}:1712345678000`);
    expect(result).toEqual({
      version: "v1",
      publicKeyHex: pubkey,
      timestamp: 1712345678000,
    });
  });

  it("returns null for empty string", () => {
    expect(parseRevocationMemo("")).toBeNull();
  });

  it("returns null for wrong prefix", () => {
    expect(parseRevocationMemo("other:revocation:v1:key:123")).toBeNull();
  });

  it("returns null for wrong second segment", () => {
    expect(parseRevocationMemo("motebit:anchor:v1:key:123")).toBeNull();
  });

  it("returns null for non-numeric timestamp", () => {
    expect(parseRevocationMemo("motebit:revocation:v1:key:abc")).toBeNull();
  });

  it("returns null for too few parts", () => {
    expect(parseRevocationMemo("motebit:revocation:v1:key")).toBeNull();
  });

  it("returns null for too many parts", () => {
    expect(parseRevocationMemo("motebit:revocation:v1:key:123:extra")).toBeNull();
  });
});

// === Memo format round-trip ===

describe("memo format round-trip", () => {
  it("anchor memo string produced by submitter is parseable", () => {
    const root = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";
    const leafCount = 50;
    const memo = `motebit:anchor:v1:${root}:${leafCount}`;

    const parsed = parseMemoAnchor(memo);
    expect(parsed).not.toBeNull();
    expect(parsed!.merkleRoot).toBe(root);
    expect(parsed!.leafCount).toBe(leafCount);
    expect(parsed!.version).toBe("v1");
  });

  it("revocation memo string is parseable", () => {
    const pubkey = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";
    const timestamp = 1712345678000;
    const memo = `motebit:revocation:v1:${pubkey}:${timestamp}`;

    const parsed = parseRevocationMemo(memo);
    expect(parsed).not.toBeNull();
    expect(parsed!.publicKeyHex).toBe(pubkey);
    expect(parsed!.timestamp).toBe(timestamp);
    expect(parsed!.version).toBe("v1");
  });

  it("anchor and revocation memos do not cross-parse", () => {
    const anchorMemo = "motebit:anchor:v1:root:50";
    const revocationMemo = "motebit:revocation:v1:key:123";

    expect(parseMemoAnchor(revocationMemo)).toBeNull();
    expect(parseRevocationMemo(anchorMemo)).toBeNull();
  });
});

// === submitMerkleRoot (mocked RPC) ===

describe("SolanaMemoSubmitter — submitMerkleRoot", () => {
  const seed = Keypair.generate().secretKey.slice(0, 32);
  const ROOT = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";
  const LEAF_COUNT = 8;

  beforeEach(() => {
    latestBlockhashMock.mockReset();
    sendRawTransactionMock.mockReset();
    confirmTransactionMock.mockReset();
    getBalanceMock.mockReset();

    latestBlockhashMock.mockResolvedValue({
      blockhash: validBlockhash(),
      lastValidBlockHeight: 1_000_000,
    });
    sendRawTransactionMock.mockResolvedValue("FakeTxSignature11111111111111111111111111111111");
    confirmTransactionMock.mockResolvedValue({ value: { err: null } });
  });

  it("returns the tx signature from sendRawTransaction", async () => {
    const submitter = new SolanaMemoSubmitter({
      rpcUrl: "https://api.mainnet-beta.solana.com",
      identitySeed: seed,
    });
    const result = await submitter.submitMerkleRoot(ROOT, "relay-x", LEAF_COUNT);
    expect(result.txHash).toBe("FakeTxSignature11111111111111111111111111111111");
  });

  it("submits a transaction whose memo decodes to the expected motebit anchor string", async () => {
    const submitter = new SolanaMemoSubmitter({
      rpcUrl: "https://api.mainnet-beta.solana.com",
      identitySeed: seed,
    });
    await submitter.submitMerkleRoot(ROOT, "relay-x", LEAF_COUNT);

    expect(sendRawTransactionMock).toHaveBeenCalledTimes(1);
    const rawBuf = sendRawTransactionMock.mock.calls[0]![0] as Buffer | Uint8Array;
    // The memo program data appears verbatim inside the serialized tx.
    const text = Buffer.from(rawBuf).toString("utf-8");
    const expectedMemo = `motebit:anchor:v1:${ROOT}:${LEAF_COUNT}`;
    expect(text).toContain(expectedMemo);
  });

  it("awaits blockhash + sendRaw + confirm in order (full tx lifecycle)", async () => {
    const order: string[] = [];
    latestBlockhashMock.mockImplementation(async () => {
      order.push("blockhash");
      return {
        blockhash: validBlockhash(),
        lastValidBlockHeight: 1_000_000,
      };
    });
    sendRawTransactionMock.mockImplementation(async () => {
      order.push("send");
      return "S3333333333333333333333333333333333333333333";
    });
    confirmTransactionMock.mockImplementation(async () => {
      order.push("confirm");
      return { value: { err: null } };
    });
    const submitter = new SolanaMemoSubmitter({
      rpcUrl: "https://api.mainnet-beta.solana.com",
      identitySeed: seed,
    });
    await submitter.submitMerkleRoot(ROOT, "r", LEAF_COUNT);
    expect(order).toEqual(["blockhash", "send", "confirm"]);
  });

  it("propagates network errors from sendRawTransaction (no silent swallow)", async () => {
    sendRawTransactionMock.mockRejectedValue(new Error("RPC down"));
    const submitter = new SolanaMemoSubmitter({
      rpcUrl: "https://api.mainnet-beta.solana.com",
      identitySeed: seed,
    });
    await expect(submitter.submitMerkleRoot(ROOT, "r", LEAF_COUNT)).rejects.toThrow("RPC down");
  });

  it("propagates confirmation errors (transaction rejected on confirm)", async () => {
    confirmTransactionMock.mockRejectedValue(new Error("transaction expired"));
    const submitter = new SolanaMemoSubmitter({
      rpcUrl: "https://api.mainnet-beta.solana.com",
      identitySeed: seed,
    });
    await expect(submitter.submitMerkleRoot(ROOT, "r", LEAF_COUNT)).rejects.toThrow(
      "transaction expired",
    );
  });

  it("honors injected commitment level through to confirmTransaction", async () => {
    const submitter = new SolanaMemoSubmitter({
      rpcUrl: "https://api.mainnet-beta.solana.com",
      identitySeed: seed,
      commitment: "finalized",
    });
    await submitter.submitMerkleRoot(ROOT, "r", LEAF_COUNT);
    expect(latestBlockhashMock).toHaveBeenCalledWith("finalized");
    const [, commitment] = confirmTransactionMock.mock.calls[0]!;
    expect(commitment).toBe("finalized");
  });
});

// === submitRevocation (mocked RPC) ===

describe("SolanaMemoSubmitter — submitRevocation", () => {
  const seed = Keypair.generate().secretKey.slice(0, 32);
  const OLD_KEY_HEX = "deadbeef".repeat(8);
  const TIMESTAMP = 1_700_000_000_000;

  beforeEach(() => {
    latestBlockhashMock.mockReset();
    sendRawTransactionMock.mockReset();
    confirmTransactionMock.mockReset();
    latestBlockhashMock.mockResolvedValue({
      blockhash: validBlockhash(),
      lastValidBlockHeight: 2_000_000,
    });
    sendRawTransactionMock.mockResolvedValue("RevTxSignature1111111111111111111111111111111");
    confirmTransactionMock.mockResolvedValue({ value: { err: null } });
  });

  it("returns the revocation tx signature", async () => {
    const submitter = new SolanaMemoSubmitter({
      rpcUrl: "https://api.mainnet-beta.solana.com",
      identitySeed: seed,
    });
    const result = await submitter.submitRevocation(OLD_KEY_HEX, TIMESTAMP);
    expect(result.txHash).toBe("RevTxSignature1111111111111111111111111111111");
  });

  it("submits the expected revocation memo string", async () => {
    const submitter = new SolanaMemoSubmitter({
      rpcUrl: "https://api.mainnet-beta.solana.com",
      identitySeed: seed,
    });
    await submitter.submitRevocation(OLD_KEY_HEX, TIMESTAMP);
    const rawBuf = sendRawTransactionMock.mock.calls[0]![0] as Buffer | Uint8Array;
    const text = Buffer.from(rawBuf).toString("utf-8");
    const expectedMemo = `motebit:revocation:v1:${OLD_KEY_HEX}:${TIMESTAMP}`;
    expect(text).toContain(expectedMemo);
  });

  it("propagates errors from the RPC layer", async () => {
    sendRawTransactionMock.mockRejectedValue(new Error("submit failed"));
    const submitter = new SolanaMemoSubmitter({
      rpcUrl: "https://api.mainnet-beta.solana.com",
      identitySeed: seed,
    });
    await expect(submitter.submitRevocation(OLD_KEY_HEX, TIMESTAMP)).rejects.toThrow(
      "submit failed",
    );
  });
});

// === isAvailable (mocked RPC) ===

describe("SolanaMemoSubmitter — isAvailable", () => {
  const seed = Keypair.generate().secretKey.slice(0, 32);

  beforeEach(() => {
    latestBlockhashMock.mockReset();
    getBalanceMock.mockReset();
  });

  it("returns true when RPC is reachable AND balance covers the minimum fee", async () => {
    latestBlockhashMock.mockResolvedValue({
      blockhash: validBlockhash(),
      lastValidBlockHeight: 1_000_000,
    });
    getBalanceMock.mockResolvedValue(1_000_000); // 1M lamports, well above the ~5k/10k floor
    const submitter = new SolanaMemoSubmitter({
      rpcUrl: "https://api.mainnet-beta.solana.com",
      identitySeed: seed,
    });
    expect(await submitter.isAvailable()).toBe(true);
  });

  it("returns false when RPC throws (unreachable or DNS failure)", async () => {
    latestBlockhashMock.mockRejectedValue(new Error("getaddrinfo ENOTFOUND"));
    const submitter = new SolanaMemoSubmitter({
      rpcUrl: "https://api.mainnet-beta.solana.com",
      identitySeed: seed,
    });
    expect(await submitter.isAvailable()).toBe(false);
  });

  it("returns false when balance is below the fee floor (under-funded account)", async () => {
    latestBlockhashMock.mockResolvedValue({
      blockhash: validBlockhash(),
      lastValidBlockHeight: 1_000_000,
    });
    getBalanceMock.mockResolvedValue(100); // 100 lamports, below 10_000 floor
    const submitter = new SolanaMemoSubmitter({
      rpcUrl: "https://api.mainnet-beta.solana.com",
      identitySeed: seed,
    });
    expect(await submitter.isAvailable()).toBe(false);
  });

  it("returns false when getBalance throws even if blockhash worked", async () => {
    latestBlockhashMock.mockResolvedValue({
      blockhash: validBlockhash(),
      lastValidBlockHeight: 1_000_000,
    });
    getBalanceMock.mockRejectedValue(new Error("rpc partial failure"));
    const submitter = new SolanaMemoSubmitter({
      rpcUrl: "https://api.mainnet-beta.solana.com",
      identitySeed: seed,
    });
    expect(await submitter.isAvailable()).toBe(false);
  });
});

// === createSolanaMemoSubmitter factory ===

describe("createSolanaMemoSubmitter", () => {
  it("returns a SolanaMemoSubmitter instance", async () => {
    const { createSolanaMemoSubmitter } = await import("../memo-submitter.js");
    const seed = Keypair.generate().secretKey.slice(0, 32);
    const submitter = createSolanaMemoSubmitter({
      rpcUrl: "https://api.devnet.solana.com",
      identitySeed: seed,
    });
    expect(submitter).toBeInstanceOf(SolanaMemoSubmitter);
    expect(submitter.chain).toBe("solana");
  });
});
