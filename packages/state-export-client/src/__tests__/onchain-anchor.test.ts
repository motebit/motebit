/**
 * Onchain-anchor cross-check tests. Mock the Solana JSON-RPC at the
 * fetch boundary; assert the lookup correctly identifies matched +
 * mismatched + missing anchors, with typed reasons for each.
 */

import { describe, it, expect } from "vitest";

import { lookupTransparencyAnchor, verifyDeclarationOnchainAnchor } from "../onchain-anchor.js";
import type { SignedTransparencyDeclaration } from "../transparency-anchor.js";

const ANCHOR_ADDR = "TestRelayAnchorAddress11111111111111111111";
const EXPECTED_HASH = "a".repeat(64);
const OTHER_HASH = "b".repeat(64);

interface SignatureFixture {
  signature: string;
  err: unknown;
  memo: string | null;
}

function mockRpc(signatures: SignatureFixture[]): typeof globalThis.fetch {
  return (async () =>
    new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: signatures.map((s, i) => ({
          signature: s.signature,
          slot: 1000 + i,
          err: s.err,
          memo: s.memo,
          blockTime: 1700000000 + i,
        })),
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    )) as unknown as typeof globalThis.fetch;
}

describe("lookupTransparencyAnchor — match", () => {
  it("returns ok when the latest memo matches the expected hash", async () => {
    const fetchImpl = mockRpc([
      {
        signature: "tx-newest",
        err: null,
        memo: `[7 (len 88)] motebit:transparency:v1:${EXPECTED_HASH}`,
      },
    ]);
    const result = await lookupTransparencyAnchor(ANCHOR_ADDR, EXPECTED_HASH, { fetch: fetchImpl });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.txHash).toBe("tx-newest");
      expect(result.anchoredHashHex).toBe(EXPECTED_HASH);
      expect(result.anchorAddress).toBe(ANCHOR_ADDR);
    }
  });

  it("ignores unrelated memos and picks the canonical transparency anchor", async () => {
    const fetchImpl = mockRpc([
      { signature: "tx-other", err: null, memo: "motebit:revocation:v1:somekey:1234" },
      { signature: "tx-transparency", err: null, memo: `motebit:transparency:v1:${EXPECTED_HASH}` },
    ]);
    const result = await lookupTransparencyAnchor(ANCHOR_ADDR, EXPECTED_HASH, { fetch: fetchImpl });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.txHash).toBe("tx-transparency");
    }
  });

  it("skips failed transactions even when their memo matches", async () => {
    const fetchImpl = mockRpc([
      // A failed tx with a matching memo should be skipped — failed txs
      // don't actually anchor anything on chain.
      {
        signature: "tx-failed",
        err: { InsufficientFundsForRent: {} },
        memo: `motebit:transparency:v1:${EXPECTED_HASH}`,
      },
      { signature: "tx-ok", err: null, memo: `motebit:transparency:v1:${EXPECTED_HASH}` },
    ]);
    const result = await lookupTransparencyAnchor(ANCHOR_ADDR, EXPECTED_HASH, { fetch: fetchImpl });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.txHash).toBe("tx-ok");
  });

  it("accepts case-insensitive hex comparison", async () => {
    const upperHash = EXPECTED_HASH.toUpperCase();
    const fetchImpl = mockRpc([
      { signature: "tx-mixed-case", err: null, memo: `motebit:transparency:v1:${upperHash}` },
    ]);
    const result = await lookupTransparencyAnchor(ANCHOR_ADDR, EXPECTED_HASH, { fetch: fetchImpl });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.anchoredHashHex).toBe(EXPECTED_HASH);
  });
});

describe("lookupTransparencyAnchor — mismatch / missing", () => {
  it("returns anchor_hash_mismatch when memo carries a different hash", async () => {
    const fetchImpl = mockRpc([
      { signature: "tx-other-hash", err: null, memo: `motebit:transparency:v1:${OTHER_HASH}` },
    ]);
    const result = await lookupTransparencyAnchor(ANCHOR_ADDR, EXPECTED_HASH, { fetch: fetchImpl });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("anchor_hash_mismatch");
      expect(result.detail).toContain("expected");
      expect(result.detail).toContain("got");
    }
  });

  it("returns no_anchor_found when no transparency memo is in scan range", async () => {
    const fetchImpl = mockRpc([
      { signature: "tx-other1", err: null, memo: "motebit:revocation:v1:somekey:1" },
      { signature: "tx-other2", err: null, memo: "motebit:anchor:v1:somemerkleroot:5" },
    ]);
    const result = await lookupTransparencyAnchor(ANCHOR_ADDR, EXPECTED_HASH, { fetch: fetchImpl });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("no_anchor_found");
  });

  it("returns no_anchor_found when scan list is empty", async () => {
    const fetchImpl = mockRpc([]);
    const result = await lookupTransparencyAnchor(ANCHOR_ADDR, EXPECTED_HASH, { fetch: fetchImpl });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("no_anchor_found");
  });

  it("returns malformed_memo when prefix matches but hash slot is not 64 hex chars", async () => {
    const fetchImpl = mockRpc([
      { signature: "tx-malformed", err: null, memo: "motebit:transparency:v1:notenoughhexchars" },
    ]);
    const result = await lookupTransparencyAnchor(ANCHOR_ADDR, EXPECTED_HASH, { fetch: fetchImpl });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("malformed_memo");
  });
});

describe("lookupTransparencyAnchor — RPC failures", () => {
  it("returns rpc_failed on HTTP error", async () => {
    const fetchImpl: typeof globalThis.fetch = async () =>
      new Response("server error", { status: 503, statusText: "Service Unavailable" });
    const result = await lookupTransparencyAnchor(ANCHOR_ADDR, EXPECTED_HASH, { fetch: fetchImpl });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("rpc_failed");
      expect(result.detail).toContain("503");
    }
  });

  it("returns rpc_failed on network error", async () => {
    const fetchImpl: typeof globalThis.fetch = async () => {
      throw new Error("ECONNREFUSED");
    };
    const result = await lookupTransparencyAnchor(ANCHOR_ADDR, EXPECTED_HASH, { fetch: fetchImpl });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("rpc_failed");
      expect(result.detail).toContain("ECONNREFUSED");
    }
  });

  it("returns rpc_failed when RPC returns a JSON-RPC error envelope", async () => {
    const fetchImpl: typeof globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          error: { code: -32602, message: "invalid params" },
        }),
        { status: 200 },
      );
    const result = await lookupTransparencyAnchor(ANCHOR_ADDR, EXPECTED_HASH, { fetch: fetchImpl });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("rpc_failed");
      expect(result.detail).toContain("invalid params");
    }
  });
});

describe("verifyDeclarationOnchainAnchor — convenience", () => {
  it("extracts hash from declaration and cross-checks against anchor", async () => {
    const declaration: SignedTransparencyDeclaration = {
      spec: "motebit-transparency/draft-2026-04-14",
      declared_at: 1,
      relay_id: "r1",
      relay_public_key: "0".repeat(64),
      content: {},
      hash: EXPECTED_HASH,
      suite: "motebit-jcs-ed25519-hex-v1",
      signature: "0".repeat(128),
    };
    const fetchImpl = mockRpc([
      { signature: "tx-anchor", err: null, memo: `motebit:transparency:v1:${EXPECTED_HASH}` },
    ]);
    const result = await verifyDeclarationOnchainAnchor(declaration, ANCHOR_ADDR, {
      fetch: fetchImpl,
    });
    expect(result.ok).toBe(true);
  });
});
