/**
 * RFC 6962 §2.1 Merkle domain-separation known-answer vectors for
 * `verifyMerkleInclusion`. The `0x00` leaf tag / `0x01` node tag bytes are
 * pinned against an INDEPENDENT production RFC 6962 implementation — not a
 * self-rolled vector (which would be a tautology against the code under test):
 *
 *   github.com/transparency-dev/merkle, rfc6962/rfc6962_test.go @ commit
 *   78493b07ef9b552e3379abf9e23d4da26fbe797c
 *     - HashLeaf("L123456")          = 395aa064…4d56   (leaf = SHA-256(0x00 ‖ d))
 *     - HashChildren("N123","N456")  = aa217fe8…66bbb  (node = SHA-256(0x01 ‖ l ‖ r))
 *     - SHA-256()                    = e3b0c4…b855     (empty)
 *     - HashLeaf("")                 = 6e340b9c…afa01d (≠ empty — why §2.1 exists)
 *
 * Also pins the absent ⇒ v1 / unknown ⇒ reject dispatch contract.
 */
import { describe, it, expect } from "vitest";
import { MERKLE_TREE_VERSION_REGISTRY, DEFAULT_MERKLE_TREE_VERSION } from "@motebit/protocol";
import {
  verifyMerkleInclusion,
  hashLeaf,
  canonicalLeaf,
  resolveTreeHashVersion,
} from "../merkle.js";
import { sha256, bytesToHex, canonicalJson } from "../signing.js";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const concatBytes = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

// Verbatim from transparency-dev/merkle rfc6962_test.go @ 78493b07.
const KAT_LEAF_L123456 = "395aa064aa4c29f7010acfe3f25db9485bbd4b91897b6ad7ad547639252b4d56";
const KAT_NODE_N123_N456 = "aa217fe888e47007fa15edab33c2b492a722cb106c64667fc2b044444de66bbb";
const KAT_EMPTY = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const KAT_EMPTY_LEAF = "6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d";

describe("RFC 6962 domain-separation byte layout (named external KAT)", () => {
  it("leaf tag: SHA-256(0x00 ‖ d) matches HashLeaf('L123456')", async () => {
    const leaf = await sha256(concatBytes(new Uint8Array([0x00]), enc("L123456")));
    expect(bytesToHex(leaf)).toBe(KAT_LEAF_L123456);
  });

  it("empty hash ≠ empty-leaf hash — the second-preimage gap §2.1 closes", async () => {
    expect(bytesToHex(await sha256(new Uint8Array([])))).toBe(KAT_EMPTY);
    expect(bytesToHex(await sha256(new Uint8Array([0x00])))).toBe(KAT_EMPTY_LEAF);
    expect(KAT_EMPTY).not.toBe(KAT_EMPTY_LEAF);
  });

  it("registry metadata matches the RFC 6962 tags it documents", () => {
    const v1 = MERKLE_TREE_VERSION_REGISTRY["merkle-sha256-plain-v1"];
    const v2 = MERKLE_TREE_VERSION_REGISTRY["merkle-sha256-rfc6962-v2"];
    expect(v1.leafTag).toBeNull();
    expect(v1.nodeTag).toBeNull();
    expect(v2.leafTag).toBe(0x00);
    expect(v2.nodeTag).toBe(0x01);
  });
});

describe("verifyMerkleInclusion — v2 node tag pinned to HashChildren KAT", () => {
  // A 2-leaf tree [N123, N456] (raw, hex-encoded as bottom-layer hashes). Under
  // v2 the root is SHA-256(0x01 ‖ N123 ‖ N456) = HashChildren("N123","N456").
  const N123 = bytesToHex(enc("N123"));
  const N456 = bytesToHex(enc("N456"));

  it("v2: leaf 0 + sibling reconstructs the external node-hash root", async () => {
    const ok = await verifyMerkleInclusion(
      N123,
      0,
      [N456],
      [2],
      KAT_NODE_N123_N456,
      "merkle-sha256-rfc6962-v2",
    );
    expect(ok).toBe(true);
  });

  it("v1 default does NOT reconstruct the v2 root (domain separation changes it)", async () => {
    // Same proof, v1 hashing → SHA-256(N123 ‖ N456) ≠ the 0x01-tagged root.
    expect(await verifyMerkleInclusion(N123, 0, [N456], [2], KAT_NODE_N123_N456)).toBe(false);
    expect(
      await verifyMerkleInclusion(
        N123,
        0,
        [N456],
        [2],
        KAT_NODE_N123_N456,
        "merkle-sha256-plain-v1",
      ),
    ).toBe(false);
  });

  it("a v2-rooted proof verified under v1 is REJECTED (downgrade not silently accepted)", async () => {
    // The verifier reconstructs a *different* (untagged) root and fails the
    // equality — never silently accepts the v2 root under v1 semantics.
    expect(await verifyMerkleInclusion(N123, 0, [N456], [2], KAT_NODE_N123_N456)).toBe(false);
  });

  it("unknown / unsupported version fails closed (returns false, never throws)", async () => {
    const ok = await verifyMerkleInclusion(
      N123,
      0,
      [N456],
      [2],
      KAT_NODE_N123_N456,
      "merkle-sha256-v3-unknown" as never,
    );
    expect(ok).toBe(false);
  });

  it("default param is the absent ⇒ v1 downgrade-safety version", () => {
    // The 5-arg call signature defaults to v1 — keeps existing callers
    // byte-identical and matches protocol's DEFAULT_MERKLE_TREE_VERSION.
    expect(DEFAULT_MERKLE_TREE_VERSION).toBe("merkle-sha256-plain-v1");
  });
});

describe("hashLeaf — the leaf-tag dispatch primitive, pinned to the external KAT", () => {
  it("v2: hashLeaf(enc('L123456')) == HashLeaf('L123456') (0x00 leaf tag through the primitive)", async () => {
    // Not a hand-rolled repro — the PRIMITIVE every leaf builder routes through
    // must itself reproduce the external RFC 6962 leaf-hash vector.
    expect(await hashLeaf(enc("L123456"), "merkle-sha256-rfc6962-v2")).toBe(KAT_LEAF_L123456);
  });

  it("v1 (and default) applies NO leaf tag — SHA-256(entry), ≠ the tagged KAT", async () => {
    const untagged = bytesToHex(await sha256(enc("L123456")));
    expect(await hashLeaf(enc("L123456"), "merkle-sha256-plain-v1")).toBe(untagged);
    expect(await hashLeaf(enc("L123456"))).toBe(untagged); // default ⇒ v1
    expect(untagged).not.toBe(KAT_LEAF_L123456);
  });

  it("throws (producer-loud) on an unimplemented version", async () => {
    await expect(hashLeaf(enc("x"), "merkle-sha256-v3-unknown" as never)).rejects.toThrow(
      /Unsupported MerkleTreeVersion/,
    );
  });
});

describe("canonicalLeaf — JCS-canonicalize then leaf-hash", () => {
  it("v1 is byte-identical to bytesToHex(sha256(encode(canonicalJson(x))))", async () => {
    const obj = { b: 2, a: 1, nested: { z: [3, 2, 1] } };
    const expected = bytesToHex(await sha256(enc(canonicalJson(obj))));
    expect(await canonicalLeaf(obj, "merkle-sha256-plain-v1")).toBe(expected);
    expect(await canonicalLeaf(obj)).toBe(expected); // default ⇒ v1
  });

  it("v2 prepends the 0x00 leaf tag to the canonical bytes", async () => {
    const obj = { a: 1 };
    const v2 = bytesToHex(
      await sha256(concatBytes(new Uint8Array([0x00]), enc(canonicalJson(obj)))),
    );
    expect(await canonicalLeaf(obj, "merkle-sha256-rfc6962-v2")).toBe(v2);
    expect(await canonicalLeaf(obj, "merkle-sha256-rfc6962-v2")).not.toBe(
      await canonicalLeaf(obj, "merkle-sha256-plain-v1"),
    );
  });
});

describe("resolveTreeHashVersion — verifier-boundary dispatch", () => {
  it("absent ⇒ v1 (never silently upgraded)", () => {
    expect(resolveTreeHashVersion(undefined)).toBe("merkle-sha256-plain-v1");
  });
  it("known values pass through", () => {
    expect(resolveTreeHashVersion("merkle-sha256-plain-v1")).toBe("merkle-sha256-plain-v1");
    expect(resolveTreeHashVersion("merkle-sha256-rfc6962-v2")).toBe("merkle-sha256-rfc6962-v2");
  });
  it("unknown ⇒ null so the caller rejects fail-closed (never downgrades)", () => {
    expect(resolveTreeHashVersion("merkle-sha256-v3")).toBeNull();
    expect(resolveTreeHashVersion("")).toBeNull();
  });
});
