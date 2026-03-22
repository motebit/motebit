/**
 * Merkle tree for settlement batch anchoring.
 *
 * Binary tree with odd-leaf promotion (no duplication).
 * Leaves are SHA-256 hashes; internal nodes are SHA-256(left || right).
 * Used by federation settlement anchoring (relay-federation-v1.md §7.6).
 */

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
export async function buildMerkleTree(leaves: string[]): Promise<MerkleTree> {
  if (leaves.length === 0) {
    throw new Error("Cannot build Merkle tree from empty leaf set");
  }

  const layers: string[][] = [leaves];

  let current = leaves;
  while (current.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < current.length; i += 2) {
      if (i + 1 < current.length) {
        // Pair: hash(left || right)
        const combined = concat(fromHex(current[i]!), fromHex(current[i + 1]!));
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
): Promise<boolean> {
  let current = fromHex(proof.leaf);
  let idx = proof.index;
  let sibIdx = 0;

  for (const layerSize of proof.layerSizes) {
    const siblingPos = idx % 2 === 0 ? idx + 1 : idx - 1;
    const hasSibling = siblingPos >= 0 && siblingPos < layerSize;

    if (hasSibling) {
      if (sibIdx >= proof.siblings.length) return false;
      const siblingBytes = fromHex(proof.siblings[sibIdx]!);
      const combined =
        idx % 2 === 0 ? concat(current, siblingBytes) : concat(siblingBytes, current);
      current = await sha256(combined);
      sibIdx++;
    }
    // else: promoted — current passes through unchanged

    idx = Math.floor(idx / 2);
  }

  return toHex(current) === expectedRoot;
}

/**
 * Compute a settlement leaf hash from settlement fields.
 * Matches relay-federation-v1.md §7.6.1 — canonicalJson → SHA-256.
 */
export async function computeSettlementLeaf(settlement: {
  settlement_id: string;
  task_id: string;
  upstream_relay_id: string;
  downstream_relay_id: string | null;
  gross_amount: number;
  fee_amount: number;
  net_amount: number;
  receipt_hash: string;
  settled_at: number;
}): Promise<string> {
  // Import canonicalJson inline to avoid circular dependency issues
  // (this module is part of @motebit/crypto which defines canonicalJson)
  const { canonicalJson } = await import("./index.js");

  const canonical = canonicalJson({
    settlement_id: settlement.settlement_id,
    task_id: settlement.task_id,
    upstream_relay_id: settlement.upstream_relay_id,
    downstream_relay_id: settlement.downstream_relay_id,
    gross_amount: settlement.gross_amount,
    fee_amount: settlement.fee_amount,
    net_amount: settlement.net_amount,
    receipt_hash: settlement.receipt_hash,
    settled_at: settlement.settled_at,
  });

  const h = await sha256(new TextEncoder().encode(canonical));
  return toHex(h);
}
