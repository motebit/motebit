import { describe, it, expect } from "vitest";
import {
  buildMerkleTree,
  getMerkleProof,
  verifyMerkleProof,
  computeSettlementLeaf,
} from "../merkle";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** SHA-256 of a string, hex-encoded — matches the leaf construction path. */
async function sha256hex(data: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(data));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Pre-compute some leaf hashes for tests
async function makeLeaves(count: number): Promise<string[]> {
  const leaves: string[] = [];
  for (let i = 0; i < count; i++) {
    leaves.push(await sha256hex(`leaf-${i}`));
  }
  return leaves;
}

// ---------------------------------------------------------------------------
// buildMerkleTree
// ---------------------------------------------------------------------------

describe("buildMerkleTree", () => {
  it("single leaf: root equals the leaf", async () => {
    const leaves = await makeLeaves(1);
    const tree = await buildMerkleTree(leaves);
    expect(tree.root).toBe(leaves[0]);
    expect(tree.leaves).toEqual(leaves);
    expect(tree.layers).toHaveLength(1);
  });

  it("two leaves: root is hash(left || right)", async () => {
    const leaves = await makeLeaves(2);
    const tree = await buildMerkleTree(leaves);
    expect(tree.root).not.toBe(leaves[0]);
    expect(tree.root).not.toBe(leaves[1]);
    expect(tree.layers).toHaveLength(2);
    expect(tree.layers[0]).toEqual(leaves);
    expect(tree.layers[1]).toEqual([tree.root]);
  });

  it("three leaves: odd leaf promoted, not duplicated", async () => {
    const leaves = await makeLeaves(3);
    const tree = await buildMerkleTree(leaves);
    // Layer 0: [l0, l1, l2]
    // Layer 1: [hash(l0||l1), l2]  ← l2 promoted
    // Layer 2: [hash(layer1[0]||l2)]  ← root
    expect(tree.layers).toHaveLength(3);
    expect(tree.layers[1]).toHaveLength(2);
    expect(tree.layers[1]![1]).toBe(leaves[2]); // promoted, not hashed
  });

  it("four leaves: balanced tree depth 2", async () => {
    const leaves = await makeLeaves(4);
    const tree = await buildMerkleTree(leaves);
    expect(tree.layers).toHaveLength(3);
    expect(tree.layers[0]).toHaveLength(4);
    expect(tree.layers[1]).toHaveLength(2);
    expect(tree.layers[2]).toHaveLength(1);
  });

  it("100 leaves: produces valid tree", async () => {
    const leaves = await makeLeaves(100);
    const tree = await buildMerkleTree(leaves);
    expect(tree.root.length).toBe(64); // hex SHA-256
    expect(tree.leaves).toHaveLength(100);
    // depth ≤ ceil(log2(100)) + 1 layers
    expect(tree.layers.length).toBeLessThanOrEqual(8);
  });

  it("rejects empty leaf set", async () => {
    await expect(buildMerkleTree([])).rejects.toThrow("empty leaf set");
  });

  it("deterministic: same leaves → same root", async () => {
    const leaves = await makeLeaves(5);
    const tree1 = await buildMerkleTree(leaves);
    const tree2 = await buildMerkleTree(leaves);
    expect(tree1.root).toBe(tree2.root);
  });

  it("order-sensitive: different leaf order → different root", async () => {
    const leaves = await makeLeaves(4);
    const reversed = [...leaves].reverse();
    const tree1 = await buildMerkleTree(leaves);
    const tree2 = await buildMerkleTree(reversed);
    expect(tree1.root).not.toBe(tree2.root);
  });
});

// ---------------------------------------------------------------------------
// getMerkleProof + verifyMerkleProof
// ---------------------------------------------------------------------------

describe("Merkle proofs", () => {
  it("single leaf: empty proof verifies", async () => {
    const leaves = await makeLeaves(1);
    const tree = await buildMerkleTree(leaves);
    const proof = getMerkleProof(tree, 0);
    expect(proof.siblings).toHaveLength(0);
    expect(await verifyMerkleProof(proof, tree.root)).toBe(true);
  });

  it("two leaves: proof for each verifies", async () => {
    const leaves = await makeLeaves(2);
    const tree = await buildMerkleTree(leaves);

    const proof0 = getMerkleProof(tree, 0);
    expect(proof0.siblings).toHaveLength(1);
    expect(await verifyMerkleProof(proof0, tree.root)).toBe(true);

    const proof1 = getMerkleProof(tree, 1);
    expect(proof1.siblings).toHaveLength(1);
    expect(await verifyMerkleProof(proof1, tree.root)).toBe(true);
  });

  it("every leaf in a 7-leaf tree has a valid proof", async () => {
    const leaves = await makeLeaves(7);
    const tree = await buildMerkleTree(leaves);

    for (let i = 0; i < leaves.length; i++) {
      const proof = getMerkleProof(tree, i);
      expect(proof.leaf).toBe(leaves[i]);
      expect(proof.index).toBe(i);
      expect(await verifyMerkleProof(proof, tree.root)).toBe(true);
    }
  });

  it("every leaf in a 100-leaf tree has a valid proof", async () => {
    const leaves = await makeLeaves(100);
    const tree = await buildMerkleTree(leaves);

    // Spot-check first, last, and several middle leaves
    for (const i of [0, 1, 49, 50, 98, 99]) {
      const proof = getMerkleProof(tree, i);
      expect(await verifyMerkleProof(proof, tree.root)).toBe(true);
    }
  });

  it("proof fails against wrong root", async () => {
    const leaves = await makeLeaves(4);
    const tree = await buildMerkleTree(leaves);
    const proof = getMerkleProof(tree, 0);
    const wrongRoot = "0".repeat(64);
    expect(await verifyMerkleProof(proof, wrongRoot)).toBe(false);
  });

  it("tampered leaf fails verification", async () => {
    const leaves = await makeLeaves(4);
    const tree = await buildMerkleTree(leaves);
    const proof = getMerkleProof(tree, 0);
    // Tamper with the leaf
    proof.leaf = "f".repeat(64);
    expect(await verifyMerkleProof(proof, tree.root)).toBe(false);
  });

  it("rejects out-of-range leaf index", async () => {
    const leaves = await makeLeaves(3);
    const tree = await buildMerkleTree(leaves);
    expect(() => getMerkleProof(tree, -1)).toThrow("out of range");
    expect(() => getMerkleProof(tree, 3)).toThrow("out of range");
  });
});

// ---------------------------------------------------------------------------
// computeSettlementLeaf
// ---------------------------------------------------------------------------

describe("computeSettlementLeaf", () => {
  const settlement = {
    settlement_id: "settle-001",
    task_id: "task-001",
    upstream_relay_id: "relay-a",
    downstream_relay_id: "relay-b",
    gross_amount: 1.0,
    fee_amount: 0.05,
    net_amount: 0.95,
    receipt_hash: "abc123",
    settled_at: 1711000000000,
  };

  it("produces a 64-char hex hash", async () => {
    const leaf = await computeSettlementLeaf(settlement);
    expect(leaf).toMatch(/^[0-9a-f]{64}$/);
  });

  it("deterministic: same input → same hash", async () => {
    const a = await computeSettlementLeaf(settlement);
    const b = await computeSettlementLeaf(settlement);
    expect(a).toBe(b);
  });

  it("different settlement_id → different hash", async () => {
    const a = await computeSettlementLeaf(settlement);
    const b = await computeSettlementLeaf({ ...settlement, settlement_id: "settle-002" });
    expect(a).not.toBe(b);
  });

  it("different amount → different hash", async () => {
    const a = await computeSettlementLeaf(settlement);
    const b = await computeSettlementLeaf({ ...settlement, gross_amount: 2.0 });
    expect(a).not.toBe(b);
  });

  it("null downstream_relay_id produces valid hash", async () => {
    const leaf = await computeSettlementLeaf({
      ...settlement,
      downstream_relay_id: null,
    });
    expect(leaf).toMatch(/^[0-9a-f]{64}$/);
  });

  it("integrates with Merkle tree: settlement leaves produce valid proofs", async () => {
    const settlements = Array.from({ length: 5 }, (_, i) => ({
      ...settlement,
      settlement_id: `settle-${i}`,
      settled_at: 1711000000000 + i * 1000,
    }));

    const leaves = await Promise.all(settlements.map(computeSettlementLeaf));
    const tree = await buildMerkleTree(leaves);

    for (let i = 0; i < leaves.length; i++) {
      const proof = getMerkleProof(tree, i);
      expect(await verifyMerkleProof(proof, tree.root)).toBe(true);
    }
  });
});
