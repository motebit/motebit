---
"@motebit/relay": patch
---

Flip the per-agent settlement anchor producer to `merkle-sha256-rfc6962-v2` — PR2 of the RFC 6962 domain-separation migration, the first real v2 producer (doctrine: `docs/doctrine/merkle-tree-hash-versioning.md` §8). The portable verifier accepted v2 from PR1 part 2b (deploy-verifier-first ordering, threat-model §4(d)); this flips the producer.

`services/relay/src/anchoring.ts`: `agentSettlementLeaf` now routes through `@motebit/encryption`'s re-exported `hashLeaf` (the canonical leaf primitive — the `0x00` leaf tag is never inlined; `check-merkle-tree-hash-canonical` enforces this), and `cutAgentSettlementBatch` / `getAgentSettlementProof` thread the version into both the leaf hash and `buildMerkleTree` (the `0x01` node tag). New batches emit `tree_hash_version: "merkle-sha256-rfc6962-v2"` on every proof (threat-model rule c).

Per-batch version persistence is the load-bearing correctness detail: a new `relay_agent_anchor_batches.tree_hash_version` column (migration v26) records the version each batch was hashed under. Already-anchored pre-PR2 batches read NULL ⇒ `merkle-sha256-plain-v1`, so their on-chain-committed v1 roots still reconstruct under v1; the proof endpoint reconstructs each batch under ITS stored version and omits the field for legacy v1 (absent ⇒ v1; the legacy id is never re-emitted). The signed batch payload is unchanged — the version binds transitively through `merkle_root`, so a flipped version fails the Merkle or signature step.

`spec/agent-settlement-anchor-v1.md` gains §5.3 (Tree-hash version) + the `tree_hash_version?` proof field + the Option-A machine-readable declaration (`tree_hash_version:` / `tree_hash_producer:`) that activates `check-merkle-tree-hash-canonical`'s spec-claim→producer arm. `@motebit/encryption` re-exports `hashLeaf` / `canonicalLeaf` / `resolveTreeHashVersion`. Tests: the producer→verifier round-trip now runs v2 end-to-end (the anchored leaf equals the worker's v2 leaf and differs from the v1 leaf), plus a legacy v1 batch (NULL column) verifies with the field absent.
