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

import { sha256 } from "./signing.js";

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
 * @param leaf - hex-encoded SHA-256 leaf hash
 * @param index - leaf position in the bottom layer (0-based)
 * @param siblings - hex-encoded sibling hashes, leaf-to-root order
 * @param layerSizes - bottom-up layer cardinalities
 * @param expectedRoot - hex-encoded SHA-256 root the proof must reconstruct
 */
export async function verifyMerkleInclusion(
  leaf: string,
  index: number,
  siblings: string[],
  layerSizes: number[],
  expectedRoot: string,
): Promise<boolean> {
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
      const combined =
        idx % 2 === 0 ? concat(current, siblingBytes) : concat(siblingBytes, current);
      current = await sha256(combined);
      sibIdx++;
    }
    // Odd promotion: current passes through unchanged

    idx = Math.floor(idx / 2);
  }

  return toHex(current) === expectedRoot;
}
