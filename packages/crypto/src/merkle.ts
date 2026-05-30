/**
 * Merkle inclusion-proof verifier — binary tree with odd-leaf
 * promotion (no duplication). One canonical primitive across every
 * Merkle-anchored artifact in motebit.
 *
 * Permissive floor (Apache-2.0). Zero monorepo deps. Same algorithm
 * as `@motebit/encryption/merkle.ts` — kept here so `@motebit/crypto`
 * stays self-contained for browser-side re-verification.
 *
 * Consumers:
 *   - `credential-anchor.ts` — credential-anchor proof verification
 *     (`spec/credential-anchor-v1.md` §6).
 *   - `witness-omission-dispute.ts` — `inclusion_proof` evidence
 *     against a horizon cert's `federation_graph_anchor.merkle_root`.
 */

import type { MerkleTreeVersion } from "@motebit/protocol";
import { sha256 } from "./signing.js";

/**
 * RFC 6962 §2.1 interior-node domain-separation tag. Prepended to
 * `left ‖ right` before hashing under `merkle-sha256-rfc6962-v2` so an
 * interior node can never be presented as a leaf (second-preimage). v1
 * applies no tag. Module-level so it is allocated once, not per node — the
 * combine loop runs 2N-1 times on the settlement hot path. Mirrors
 * `MERKLE_TREE_VERSION_REGISTRY["merkle-sha256-rfc6962-v2"].nodeTag` in
 * `@motebit/protocol` (kept in sync by `merkle-domain-separation.test.ts`);
 * the algorithm is canonical here, the registry value is documentation.
 */
const NODE_TAG_V2 = new Uint8Array([0x01]);

function fromHex(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

/** Concatenate three Uint8Arrays in one allocation — `tag ‖ left ‖ right` for
 *  the RFC 6962 node hash, avoiding the double-alloc of nested `concat`. */
function concat3(a: Uint8Array, b: Uint8Array, c: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length + c.length);
  out.set(a);
  out.set(b, a.length);
  out.set(c, a.length + b.length);
  return out;
}

/**
 * Verify a Merkle inclusion proof against an expected root.
 *
 * Binary tree with odd-leaf promotion (no duplication). Siblings are
 * ordered leaf-to-root; `layerSizes` lets the verifier detect odd-leaf
 * promotion at each level (when `siblingPos` falls outside the layer,
 * `current` passes through unchanged without consuming a sibling).
 *
 * Returns `false` on any malformed input or hash mismatch — never
 * throws. Same fail-closed contract as `verifyBySuite`.
 *
 * The `leaf` is the already-computed bottom-layer leaf HASH; the leaf-domain
 * `0x00` tag (RFC 6962 §2.1) lives in the leaf builders that produce it, so this
 * primitive applies only the interior-node `0x01` tag (under v2). `absent ⇒ v1`
 * is resolved by the caller (the high-level verifier reads the proof's
 * `tree_hash_version`); the default here keeps the ~dozen existing 5-arg callers
 * byte-identical (v1) until they thread a version.
 *
 * @param leaf - hex-encoded SHA-256 leaf hash
 * @param index - leaf position in the bottom layer (0-based)
 * @param siblings - hex-encoded sibling hashes, leaf-to-root order
 * @param layerSizes - bottom-up layer cardinalities
 * @param expectedRoot - hex-encoded SHA-256 root the proof must reconstruct
 * @param treeHashVersion - tree-hash recipe; default `merkle-sha256-plain-v1`
 */
export async function verifyMerkleInclusion(
  leaf: string,
  index: number,
  siblings: string[],
  layerSizes: number[],
  expectedRoot: string,
  treeHashVersion: MerkleTreeVersion = "merkle-sha256-plain-v1",
): Promise<boolean> {
  // Fail-closed on an unknown/unsupported version (mirrors the `verifyBySuite`
  // contract): a proof declaring a version this verifier does not implement is
  // REJECTED, never silently downgraded to v1 (threat-model rule b).
  if (
    treeHashVersion !== "merkle-sha256-plain-v1" &&
    treeHashVersion !== "merkle-sha256-rfc6962-v2"
  ) {
    return false;
  }
  // Resolve the node-domain tag ONCE (not per hash — the loop runs 2N-1 times).
  const nodeTag = treeHashVersion === "merkle-sha256-rfc6962-v2" ? NODE_TAG_V2 : null;

  let current: Uint8Array;
  try {
    current = fromHex(leaf);
  } catch {
    return false;
  }
  let idx = index;
  let sibIdx = 0;

  for (const layerSize of layerSizes) {
    const siblingPos = idx % 2 === 0 ? idx + 1 : idx - 1;
    const hasSibling = siblingPos >= 0 && siblingPos < layerSize;

    if (hasSibling) {
      if (sibIdx >= siblings.length) return false;
      let siblingBytes: Uint8Array;
      try {
        siblingBytes = fromHex(siblings[sibIdx]!);
      } catch {
        return false;
      }
      const left = idx % 2 === 0 ? current : siblingBytes;
      const right = idx % 2 === 0 ? siblingBytes : current;
      const combined = nodeTag ? concat3(nodeTag, left, right) : concat(left, right);
      current = await sha256(combined);
      sibIdx++;
    }
    // Odd promotion: current passes through unchanged

    idx = Math.floor(idx / 2);
  }

  return toHex(current) === expectedRoot;
}
