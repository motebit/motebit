/**
 * Third-party-verifiable consolidation anchor — composes the receipt
 * signature check, the receipt-order commitment, and the Merkle root
 * computation into a single end-to-end verification.
 *
 * The producer side (signing receipts, batching them, submitting the
 * Merkle root to Solana) lives in `@motebit/runtime`. The consumer
 * side is here. A third party — auditor, federation peer, another
 * motebit — provides only what's observable:
 *
 *   1. The anchor record (from the motebit's `ConsolidationReceiptsAnchored`
 *      event log, or from any mirror that replicates it).
 *   2. The signed receipts the anchor groups (from the motebit's
 *      `ConsolidationReceiptSigned` events).
 *   3. The motebit's Ed25519 public key (the Solana address itself on
 *      mainnet — curve coincidence).
 *
 * Optionally, when the caller has the Solana transaction hash from
 * `anchor.tx_hash`, they fetch the memo directly from Solana RPC and
 * check that the parsed `merkle_root` matches — that's the timestamp
 * attestation layer. This function does not fetch the chain; the tx
 * fetch is an orthogonal concern and would couple the verifier to a
 * specific RPC adapter. Keep the offline verification portable.
 *
 * The anchor commits to `receipt_ids` in a specific order (stable sort
 * by `finished_at`, then `receipt_id` lexicographic — runtime's
 * `anchorPendingConsolidationReceipts` emits them that way). Callers
 * MUST preserve that order when passing receipts in. Re-ordering will
 * surface as an "id mismatch" result, not a silent acceptance of
 * different bytes.
 */

import { canonicalSha256, verifyConsolidationReceipt } from "@motebit/crypto";
import type { ConsolidationAnchor, ConsolidationReceipt } from "@motebit/protocol";
import { buildMerkleTree } from "./merkle.js";

export interface ConsolidationAnchorVerifyResult {
  /** True iff every check passes. Short-circuits on the first failure. */
  readonly ok: boolean;
  /** One-line reason when `ok === false`. Omitted on success. */
  readonly reason?: string;
  /** The Merkle root recomputed from the provided receipts. Populated on
   *  both success and merkle-mismatch failure so callers can log the
   *  diff. Null when verification short-circuited before root
   *  computation (count mismatch, id mismatch, or invalid signature). */
  readonly recomputedMerkleRoot: string | null;
}

/**
 * Verify an anchor end-to-end against the motebit's public key:
 *
 *   1. Receipt count matches `anchor.receipt_ids.length`.
 *   2. Each `receipts[i].receipt_id` equals `anchor.receipt_ids[i]`
 *      (caller preserves order).
 *   3. Each receipt's Ed25519 signature verifies against `publicKey`.
 *   4. The Merkle root over `canonicalSha256(receipt)` leaves equals
 *      `anchor.merkle_root`.
 *
 * Resolves with a structured result; never throws past the function
 * boundary (caller gets a clean true/false + reason).
 */
export async function verifyConsolidationAnchor(
  anchor: ConsolidationAnchor,
  receipts: ReadonlyArray<ConsolidationReceipt>,
  publicKey: Uint8Array,
): Promise<ConsolidationAnchorVerifyResult> {
  if (receipts.length !== anchor.receipt_ids.length) {
    return {
      ok: false,
      reason: `receipt count mismatch: anchor claims ${anchor.receipt_ids.length}, got ${receipts.length}`,
      recomputedMerkleRoot: null,
    };
  }

  for (let i = 0; i < receipts.length; i++) {
    const receipt = receipts[i]!;
    const expectedId = anchor.receipt_ids[i]!;
    if (receipt.receipt_id !== expectedId) {
      return {
        ok: false,
        reason: `receipt id mismatch at index ${i}: anchor expects "${expectedId}", got "${receipt.receipt_id}"`,
        recomputedMerkleRoot: null,
      };
    }
  }

  for (const receipt of receipts) {
    const valid = await verifyConsolidationReceipt(receipt, publicKey);
    if (!valid) {
      return {
        ok: false,
        reason: `invalid signature on receipt "${receipt.receipt_id}"`,
        recomputedMerkleRoot: null,
      };
    }
  }

  const leaves: string[] = [];
  for (const r of receipts) {
    leaves.push(await canonicalSha256(r));
  }
  const tree = await buildMerkleTree(leaves);

  if (tree.root !== anchor.merkle_root) {
    return {
      ok: false,
      reason: `Merkle root mismatch: anchor claims "${anchor.merkle_root}", recomputed "${tree.root}"`,
      recomputedMerkleRoot: tree.root,
    };
  }

  return { ok: true, recomputedMerkleRoot: tree.root };
}
