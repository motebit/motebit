/**
 * Identity-transparency log — the producer side of the anchored binding rung
 * (`docs/doctrine/identity-binding-verification.md`).
 *
 * Builds a Merkle tree over the relay's `motebit_id → current key` bindings using
 * the canonical leaf convention (`identityLogLeaf` from `@motebit/crypto`) and the
 * shared Merkle primitives (`@motebit/encryption`). The root is what the relay
 * anchors on-chain; the per-motebit inclusion proof is what a third party feeds to
 * `verifyIdentityBindingAnchored`. Producer and verifier share the leaf + tree
 * algorithm by construction, so a proof built here verifies there.
 *
 * Pure: given the bindings, it computes the tree. Reading bindings from
 * `agent_registry`, anchoring the root on Solana, and serving proofs over HTTP are
 * separate pieces (the relay wiring, the anchor submitter, the `/identity` route).
 */

import type { IdentityBinding, IdentityLogProof, MerkleTreeVersion } from "@motebit/protocol";
import { identityLogLeaf } from "@motebit/crypto";
import { buildMerkleTree, getMerkleProof } from "@motebit/encryption";

/**
 * `IdentityBinding` and `IdentityLogProof` are foundation-law wire shapes
 * (spec/identity-v1.md §7.6, #574) and live in the permissive floor so external
 * verifiers can consume them without a BSL dependency. Re-exported here because
 * this module is their producer.
 */
export type { IdentityBinding, IdentityLogProof };

export interface IdentityLog {
  /** Hex Merkle root of the binding set. Empty string when there are no bindings. */
  readonly root: string;
  readonly motebitCount: number;
  /** Inclusion proof for a motebit's binding, or `null` if it isn't in this log. */
  proofFor(motebitId: string): IdentityLogProof | null;
}

/**
 * Build the identity-transparency log over a set of `motebit_id → current key`
 * bindings. Leaves are sorted by hash (the Merkle builder's contract); the proof
 * tracks each motebit's resulting index. An empty binding set yields an empty log
 * (no root, no proofs) rather than throwing — a relay with no registered agents.
 */
export async function buildIdentityLog(
  bindings: IdentityBinding[],
  treeHashVersion: MerkleTreeVersion = "merkle-sha256-plain-v1",
): Promise<IdentityLog> {
  if (bindings.length === 0) {
    return { root: "", motebitCount: 0, proofFor: () => null };
  }

  const entries = await Promise.all(
    bindings.map(async (b) => ({
      motebit_id: b.motebit_id,
      leaf: await identityLogLeaf(b.motebit_id, b.public_key, treeHashVersion),
    })),
  );
  // buildMerkleTree requires sorted leaves; sort by leaf hash and remember the
  // resulting index per motebit so proofs point at the right position.
  entries.sort((a, b) => (a.leaf < b.leaf ? -1 : a.leaf > b.leaf ? 1 : 0));

  const tree = await buildMerkleTree(
    entries.map((e) => e.leaf),
    treeHashVersion,
  );
  const indexByMotebit = new Map<string, number>();
  entries.forEach((e, i) => indexByMotebit.set(e.motebit_id, i));

  return {
    root: tree.root,
    motebitCount: entries.length,
    proofFor(motebitId: string): IdentityLogProof | null {
      const idx = indexByMotebit.get(motebitId);
      if (idx === undefined) return null;
      const proof = getMerkleProof(tree, idx);
      return {
        index: proof.index,
        siblings: proof.siblings,
        layerSizes: proof.layerSizes,
        anchoredRoot: tree.root,
        // Omit for v1 (absent ⇒ v1, never re-emit the legacy id); stamp v2 so
        // the verifier dispatches the leaf/node tags on it.
        ...(treeHashVersion !== "merkle-sha256-plain-v1"
          ? { tree_hash_version: treeHashVersion }
          : {}),
      };
    },
  };
}
