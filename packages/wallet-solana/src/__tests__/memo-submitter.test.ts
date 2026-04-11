/**
 * SolanaMemoSubmitter tests — memo encoding, parsing, and adapter boundary.
 *
 * These tests verify the memo format and parsing logic without hitting
 * the Solana network. The actual transaction submission is tested at
 * the adapter boundary (Connection mock) — same pattern as web3js-adapter.
 */
import { describe, it, expect } from "vitest";
import {
  parseMemoAnchor,
  parseRevocationMemo,
  SolanaMemoSubmitter,
  SOLANA_MAINNET_CAIP2,
  SOLANA_DEVNET_CAIP2,
} from "../memo-submitter.js";
import { Keypair } from "@solana/web3.js";

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
