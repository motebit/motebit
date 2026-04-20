/**
 * verifyConsolidationAnchor — third-party verification of a
 * ConsolidationAnchor end-to-end against the motebit's public key.
 */
import { describe, it, expect } from "vitest";
import { canonicalSha256, generateKeypair, signConsolidationReceipt } from "@motebit/crypto";
import type { ConsolidationAnchor, ConsolidationReceipt } from "@motebit/protocol";
import { buildMerkleTree } from "../merkle.js";
import { verifyConsolidationAnchor } from "../consolidation-anchor.js";

async function signReceipt(
  idx: number,
  finishedAt: number,
  motebitId: string,
  kp: { privateKey: Uint8Array; publicKey: Uint8Array },
): Promise<ConsolidationReceipt> {
  const body = {
    receipt_id: `receipt-${idx.toString().padStart(4, "0")}`,
    motebit_id: motebitId,
    cycle_id: `cycle-${idx}`,
    started_at: finishedAt - 1000,
    finished_at: finishedAt,
    phases_run: ["orient", "gather", "consolidate", "prune"] as const,
    phases_yielded: [] as ReadonlyArray<"orient" | "gather" | "consolidate" | "prune">,
    summary: {
      orient_nodes: idx * 10,
      consolidate_merged: idx,
      pruned_decay: 1,
    },
  };
  return signConsolidationReceipt(body, kp.privateKey, kp.publicKey);
}

async function buildAnchor(
  receipts: ReadonlyArray<ConsolidationReceipt>,
  motebitId: string,
  txHash?: string,
): Promise<ConsolidationAnchor> {
  const sorted = [...receipts].sort((a, b) => {
    if (a.finished_at !== b.finished_at) return a.finished_at - b.finished_at;
    return a.receipt_id.localeCompare(b.receipt_id);
  });
  const leaves: string[] = [];
  for (const r of sorted) leaves.push(await canonicalSha256(r));
  const tree = await buildMerkleTree(leaves);
  return {
    batch_id: "batch-00000000-0000-4000-8000-000000000001",
    motebit_id: motebitId,
    merkle_root: tree.root,
    receipt_ids: sorted.map((r) => r.receipt_id),
    leaf_count: sorted.length,
    anchored_at: 1_700_000_010_000,
    ...(txHash !== undefined ? { tx_hash: txHash, network: "solana:devnet" } : {}),
  };
}

describe("verifyConsolidationAnchor", () => {
  it("verifies a valid anchor end-to-end", async () => {
    const kp = await generateKeypair();
    const receipts = [
      await signReceipt(1, 1_700_000_000_000, "mote-alice", kp),
      await signReceipt(2, 1_700_000_001_000, "mote-alice", kp),
      await signReceipt(3, 1_700_000_002_000, "mote-alice", kp),
    ];
    const anchor = await buildAnchor(receipts, "mote-alice");
    const result = await verifyConsolidationAnchor(anchor, receipts, kp.publicKey);
    expect(result.ok).toBe(true);
    expect(result.recomputedMerkleRoot).toBe(anchor.merkle_root);
  });

  it("fails on count mismatch", async () => {
    const kp = await generateKeypair();
    const r1 = await signReceipt(1, 1_700_000_000_000, "mote-bob", kp);
    const r2 = await signReceipt(2, 1_700_000_001_000, "mote-bob", kp);
    const anchor = await buildAnchor([r1, r2], "mote-bob");
    const result = await verifyConsolidationAnchor(anchor, [r1], kp.publicKey);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("count mismatch");
    expect(result.recomputedMerkleRoot).toBeNull();
  });

  it("fails on id mismatch (wrong order / substitution)", async () => {
    const kp = await generateKeypair();
    const receipts = [
      await signReceipt(1, 1_700_000_000_000, "mote-carol", kp),
      await signReceipt(2, 1_700_000_001_000, "mote-carol", kp),
    ];
    const anchor = await buildAnchor(receipts, "mote-carol");
    const reversed = [receipts[1]!, receipts[0]!];
    const result = await verifyConsolidationAnchor(anchor, reversed, kp.publicKey);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("id mismatch");
  });

  it("fails on invalid signature (wrong key)", async () => {
    const kpA = await generateKeypair();
    const kpB = await generateKeypair();
    const receipts = [
      await signReceipt(1, 1_700_000_000_000, "mote-dave", kpA),
      await signReceipt(2, 1_700_000_001_000, "mote-dave", kpA),
    ];
    const anchor = await buildAnchor(receipts, "mote-dave");
    const result = await verifyConsolidationAnchor(anchor, receipts, kpB.publicKey);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("invalid signature");
  });

  it("fails on Merkle root tampering", async () => {
    const kp = await generateKeypair();
    const receipts = [
      await signReceipt(1, 1_700_000_000_000, "mote-eve", kp),
      await signReceipt(2, 1_700_000_001_000, "mote-eve", kp),
    ];
    const anchor = await buildAnchor(receipts, "mote-eve");
    const tampered: ConsolidationAnchor = {
      ...anchor,
      merkle_root: "deadbeef".repeat(8),
    };
    const result = await verifyConsolidationAnchor(tampered, receipts, kp.publicKey);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("Merkle root mismatch");
    expect(result.recomputedMerkleRoot).toBe(anchor.merkle_root);
  });

  it("fails when a receipt body is tampered (signature still verifies but leaf hash changes)", async () => {
    // Tampering the body AFTER signing would break the signature check
    // first. Instead, construct a receipt with a MUTATED body + intact
    // signature — impossible via the sign function (Object.freeze), but
    // we can clone and force. The signature check catches it.
    const kp = await generateKeypair();
    const receipts = [
      await signReceipt(1, 1_700_000_000_000, "mote-frank", kp),
      await signReceipt(2, 1_700_000_001_000, "mote-frank", kp),
    ];
    const anchor = await buildAnchor(receipts, "mote-frank");
    // Clone receipt[0] to bypass the freeze, then mutate a field.
    const mutated = {
      ...receipts[0]!,
      summary: { ...receipts[0]!.summary, consolidate_merged: 999 },
    };
    const result = await verifyConsolidationAnchor(anchor, [mutated, receipts[1]!], kp.publicKey);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("invalid signature");
  });

  it("verifies a single-receipt anchor", async () => {
    const kp = await generateKeypair();
    const r = await signReceipt(1, 1_700_000_000_000, "mote-grace", kp);
    const anchor = await buildAnchor([r], "mote-grace", "fake-tx-sig");
    expect(anchor.tx_hash).toBe("fake-tx-sig");
    expect(anchor.leaf_count).toBe(1);
    const result = await verifyConsolidationAnchor(anchor, [r], kp.publicKey);
    expect(result.ok).toBe(true);
  });

  it("the caller is responsible for order — anchor.receipt_ids is the commitment", async () => {
    // Two receipts with the same finished_at to trigger the receipt_id
    // lexicographic tiebreaker. The caller must match that order.
    const kp = await generateKeypair();
    const receipts = [
      await signReceipt(1, 1_700_000_000_000, "mote-heidi", kp),
      await signReceipt(2, 1_700_000_000_000, "mote-heidi", kp),
    ];
    const anchor = await buildAnchor(receipts, "mote-heidi");
    // receipt-0001 lexicographically before receipt-0002 → same as finish-time order here.
    expect(anchor.receipt_ids[0]).toBe("receipt-0001");
    expect(anchor.receipt_ids[1]).toBe("receipt-0002");
    const result = await verifyConsolidationAnchor(anchor, receipts, kp.publicKey);
    expect(result.ok).toBe(true);
  });
});
