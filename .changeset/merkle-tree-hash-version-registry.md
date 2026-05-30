---
"@motebit/protocol": minor
---

Add the `MerkleTreeVersion` tree-hash version registry — the agility axis for Merkle leaf/node domain separation (RFC 6962 §2.1). This is the protocol-layer foundation of the staged migration that gives anchor proofs the leaf-vs-node second-preimage resistance their RFC 6962 citation promises (doctrine: `docs/doctrine/merkle-tree-hash-versioning.md`). Additive and dormant — no consumer wires it yet; the Merkle primitives + the `tree_hash_version` wire field land next, all defaulting absent ⇒ v1 so every existing proof keeps verifying.

A `MerkleTreeVersion` is a separate axis from `SuiteId`: that names the signature recipe over a batch payload; this names the tree-hash recipe that builds the root the signature commits to. Scope is exactly `(leaf tag, node tag, hash function)` — it does NOT cover payload canonicalization, which versions independently.

New exports:

- `MerkleTreeVersion` — closed union: `"merkle-sha256-plain-v1"` (legacy, no domain separation — the original behavior) and `"merkle-sha256-rfc6962-v2"` (RFC 6962 §2.1 `0x00` leaf / `0x01` node tags).
- `MERKLE_TREE_VERSION_REGISTRY` / `ALL_MERKLE_TREE_VERSIONS` — the frozen registry + iteration array (mirrors `SUITE_REGISTRY` / `ALL_SUITE_IDS`); each entry carries `leafTag` / `nodeTag` (the RFC 6962 prefix bytes, `null` for v1), `hash`, `status`, and a description.
- `DEFAULT_MERKLE_TREE_VERSION` — `"merkle-sha256-plain-v1"`, the load-bearing downgrade-safety default: a proof with no `tree_hash_version` resolves to v1, never silently upgraded.
- `isMerkleTreeVersion` / `getMerkleTreeVersionEntry` — type guard + lookup (fail-closed on unknown IDs).
- `MerkleTreeVersionEntry` / `MerkleTreeVersionStatus` / `MerkleHashFunction` — supporting types.
