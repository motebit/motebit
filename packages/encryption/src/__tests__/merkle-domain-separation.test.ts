/**
 * RFC 6962 §2.1 domain separation for the producer primitive (`buildMerkleTree`
 * / `verifyMerkleProof`), and cross-primitive sync with the offline verifier
 * (`@motebit/crypto`'s `verifyMerkleInclusion`) — both must produce/accept the
 * same v2 root or proofs minted by one fail in the other.
 *
 * Node-tag byte layout pinned to the SAME named external vector as the crypto
 * side: github.com/transparency-dev/merkle, rfc6962/rfc6962_test.go @
 * 78493b07ef9b552e3379abf9e23d4da26fbe797c —
 *   HashChildren("N123","N456") = aa217fe8…66bbb  (node = SHA-256(0x01 ‖ l ‖ r)).
 */
import { describe, it, expect } from "vitest";
import { bytesToHex, sha256, verifyMerkleInclusion } from "@motebit/crypto";
import { buildMerkleTree, getMerkleProof, verifyMerkleProof } from "../merkle.js";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const KAT_NODE_N123_N456 = "aa217fe888e47007fa15edab33c2b492a722cb106c64667fc2b044444de66bbb";

describe("buildMerkleTree — v2 node tag pinned to the external HashChildren KAT", () => {
  it("v2 root of [N123, N456] equals SHA-256(0x01 ‖ N123 ‖ N456)", async () => {
    const tree = await buildMerkleTree(
      [bytesToHex(enc("N123")), bytesToHex(enc("N456"))],
      "merkle-sha256-rfc6962-v2",
    );
    expect(tree.root).toBe(KAT_NODE_N123_N456);
  });

  it("v1 default root of [N123, N456] differs (no node tag)", async () => {
    const v1 = await buildMerkleTree([bytesToHex(enc("N123")), bytesToHex(enc("N456"))]);
    expect(v1.root).not.toBe(KAT_NODE_N123_N456);
  });

  it("producer throws (loud) on an unknown version", async () => {
    await expect(buildMerkleTree([bytesToHex(enc("x"))], "bogus-version" as never)).rejects.toThrow(
      /Unsupported MerkleTreeVersion/,
    );
  });
});

describe("v2 — 3-leaf asymmetric tree (odd promotion, two node levels)", () => {
  // 3 leaves → left subtree H(a,b) is taller than right (c promoted). This is
  // the asymmetric multi-level shape a single- or two-leaf tree never exercises.
  async function leaf(s: string): Promise<string> {
    return bytesToHex(await sha256(enc(s)));
  }

  it("build → proof → verify round-trips for every leaf, in BOTH primitives", async () => {
    const leaves = [await leaf("alpha"), await leaf("bravo"), await leaf("charlie")];
    const tree = await buildMerkleTree(leaves, "merkle-sha256-rfc6962-v2");

    for (let i = 0; i < leaves.length; i++) {
      const proof = getMerkleProof(tree, i);
      // Producer-side verifier:
      expect(await verifyMerkleProof(proof, tree.root, "merkle-sha256-rfc6962-v2")).toBe(true);
      // Offline (crypto) verifier — must agree byte-for-byte:
      expect(
        await verifyMerkleInclusion(
          proof.leaf,
          proof.index,
          proof.siblings,
          proof.layerSizes,
          tree.root,
          "merkle-sha256-rfc6962-v2",
        ),
      ).toBe(true);
    }
  });

  it("the v2 root differs from the v1 root (node tag propagates through levels)", async () => {
    const leaves = [await leaf("alpha"), await leaf("bravo"), await leaf("charlie")];
    const v2 = await buildMerkleTree(leaves, "merkle-sha256-rfc6962-v2");
    const v1 = await buildMerkleTree(leaves);
    expect(v2.root).not.toBe(v1.root);
  });

  it("a v2 proof verified under v1 is REJECTED (no silent downgrade)", async () => {
    const leaves = [await leaf("alpha"), await leaf("bravo"), await leaf("charlie")];
    const tree = await buildMerkleTree(leaves, "merkle-sha256-rfc6962-v2");
    const proof = getMerkleProof(tree, 0);
    expect(await verifyMerkleProof(proof, tree.root)).toBe(false); // v1 default
    expect(
      await verifyMerkleInclusion(
        proof.leaf,
        proof.index,
        proof.siblings,
        proof.layerSizes,
        tree.root,
      ),
    ).toBe(false);
  });
});
