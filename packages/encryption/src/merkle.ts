/**
 * Merkle tree for settlement batch anchoring.
 *
 * Binary tree with odd-leaf promotion (no duplication).
 * Leaves are SHA-256 hashes; internal nodes are SHA-256(left || right).
 * Used by federation settlement anchoring (relay-federation-v1.md §7.6).
 */

import type { MerkleTreeVersion } from "@motebit/protocol";

/**
 * RFC 6962 §2.1 interior-node domain-separation tag (`node = SHA-256(0x01 ‖ l ‖
 * r)` under `merkle-sha256-rfc6962-v2`; v1 applies no tag). Module-level so it is
 * allocated once, not per node. Must stay byte-identical to the offline
 * verifier's `NODE_TAG_V2` in `@motebit/crypto/merkle.ts` — the two primitives
 * are kept in deliberate sync (see `@motebit/crypto/CLAUDE.md` rule 6); the
 * known-answer-vector test pins both produce the same root.
 */
const NODE_TAG_V2 = new Uint8Array([0x01]);

// === Helpers ===

/** SHA-256 of raw bytes, returned as Uint8Array (32 bytes). */
async function sha256(data: Uint8Array): Promise<Uint8Array> {
  const buf = await crypto.subtle.digest("SHA-256", data as BufferSource);
  return new Uint8Array(buf);
}

/** Hex-encode a Uint8Array. */
function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Decode hex string to Uint8Array. */
function fromHex(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

/** Concatenate two Uint8Arrays. */
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

/** Resolve the node-domain tag for a tree-hash version once, before the combine
 *  loop. Throws on an unknown version (producer side fails LOUD, unlike the
 *  verifier which returns false) — a builder asked for a version it can't
 *  implement is a programming error, not untrusted input. */
function nodeTagFor(version: MerkleTreeVersion): Uint8Array | null {
  if (version === "merkle-sha256-plain-v1") return null;
  if (version === "merkle-sha256-rfc6962-v2") return NODE_TAG_V2;
  throw new Error(`Unsupported MerkleTreeVersion: ${String(version)}`);
}

// === Merkle Tree ===

export interface MerkleTree {
  /** Hex-encoded root hash. */
  root: string;
  /** Hex-encoded leaf hashes in sorted order. */
  leaves: string[];
  /** Internal node layers (bottom-up). layers[0] = leaves, layers[last] = [root]. */
  layers: string[][];
}

export interface MerkleProof {
  /** Hex-encoded leaf hash. */
  leaf: string;
  /** Index of the leaf in the sorted array. */
  index: number;
  /** Sibling hashes from leaf to root, hex-encoded. */
  siblings: string[];
  /** Size of each layer — lets the verifier detect odd-leaf promotions. */
  layerSizes: number[];
}

/**
 * Build a Merkle tree from hex-encoded leaf hashes.
 * Leaves must already be sorted (caller responsibility — §7.6.2 specifies sort order).
 * Odd leaves are promoted, not duplicated.
 */
export async function buildMerkleTree(
  leaves: string[],
  treeHashVersion: MerkleTreeVersion = "merkle-sha256-plain-v1",
): Promise<MerkleTree> {
  if (leaves.length === 0) {
    throw new Error("Cannot build Merkle tree from empty leaf set");
  }

  // Resolve the node-domain tag once (RFC 6962 §2.1: node = SHA-256(0x01 ‖ l ‖ r)
  // under v2; v1 = no tag). Producer-side throws on an unknown version.
  const nodeTag = nodeTagFor(treeHashVersion);

  const layers: string[][] = [leaves];

  let current = leaves;
  while (current.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < current.length; i += 2) {
      if (i + 1 < current.length) {
        // Pair: hash(left ‖ right), with the v2 node tag prepended.
        const left = fromHex(current[i]!);
        const right = fromHex(current[i + 1]!);
        const combined = nodeTag ? concat3(nodeTag, left, right) : concat(left, right);
        const h = await sha256(combined);
        next.push(toHex(h));
      } else {
        // Odd leaf: promote (no duplication)
        next.push(current[i]!);
      }
    }
    layers.push(next);
    current = next;
  }

  return {
    root: current[0]!,
    leaves,
    layers,
  };
}

/**
 * Generate a Merkle inclusion proof for a leaf at the given index.
 */
export function getMerkleProof(tree: MerkleTree, leafIndex: number): MerkleProof {
  if (leafIndex < 0 || leafIndex >= tree.leaves.length) {
    throw new Error(`Leaf index ${leafIndex} out of range [0, ${tree.leaves.length})`);
  }

  const siblings: string[] = [];
  const layerSizes: number[] = [];
  let idx = leafIndex;

  // Walk up layers (skip the last layer — it's the root)
  for (let layer = 0; layer < tree.layers.length - 1; layer++) {
    const level = tree.layers[layer]!;
    layerSizes.push(level.length);
    const siblingIdx = idx % 2 === 0 ? idx + 1 : idx - 1;

    if (siblingIdx >= 0 && siblingIdx < level.length) {
      siblings.push(level[siblingIdx]!);
    }
    // else: odd promotion — no sibling at this level

    idx = Math.floor(idx / 2);
  }

  return {
    leaf: tree.leaves[leafIndex]!,
    index: leafIndex,
    siblings,
    layerSizes,
  };
}

/**
 * Verify a Merkle inclusion proof against an expected root.
 */
export async function verifyMerkleProof(
  proof: MerkleProof,
  expectedRoot: string,
  treeHashVersion: MerkleTreeVersion = "merkle-sha256-plain-v1",
): Promise<boolean> {
  // Fail-closed on unknown/unsupported version (verifier returns false, never
  // throws and never downgrades to v1 — threat-model rule b).
  if (
    treeHashVersion !== "merkle-sha256-plain-v1" &&
    treeHashVersion !== "merkle-sha256-rfc6962-v2"
  ) {
    return false;
  }
  const nodeTag = treeHashVersion === "merkle-sha256-rfc6962-v2" ? NODE_TAG_V2 : null;

  let current = fromHex(proof.leaf);
  let idx = proof.index;
  let sibIdx = 0;

  for (const layerSize of proof.layerSizes) {
    const siblingPos = idx % 2 === 0 ? idx + 1 : idx - 1;
    const hasSibling = siblingPos >= 0 && siblingPos < layerSize;

    if (hasSibling) {
      if (sibIdx >= proof.siblings.length) return false;
      const siblingBytes = fromHex(proof.siblings[sibIdx]!);
      const left = idx % 2 === 0 ? current : siblingBytes;
      const right = idx % 2 === 0 ? siblingBytes : current;
      const combined = nodeTag ? concat3(nodeTag, left, right) : concat(left, right);
      current = await sha256(combined);
      sibIdx++;
    }
    // else: promoted — current passes through unchanged

    idx = Math.floor(idx / 2);
  }

  return toHex(current) === expectedRoot;
}
