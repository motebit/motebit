---
"@motebit/relay": patch
"@motebit/encryption": patch
---

Flip the federation settlement anchor producer to the verbatim-artifact leaf under `merkle-sha256-rfc6962-v2` — PR6 (the arc-closer) of the RFC 6962 §2.1 domain-separation migration (doctrine: `docs/doctrine/merkle-tree-hash-versioning.md` §8). Verified against the bytes first: no signed federation-settlement artifact existed to hash, so this MINTS one.

`services/relay/src/`:

- `federation-callbacks.ts` — both settlement write paths (the origin/upstream booking inline in `onTaskResultReceived`'s settlement-forwarding block, and the now-async downstream `onSettlementReceived`) mint + sign a `FederationSettlementRecord` (`@motebit/crypto`'s `signFederationSettlement`) and persist its canonical bytes verbatim in the new `relay_federation_settlements.record_json` column. Each relay signs its own copy; `settled_at` is shared between the record and the row so anchor reconstruction agrees.
- `anchoring.ts` — the new private `federationSettlementLeaf(record_json, v)` hashes those bytes through `hashLeaf` (the `0x00` leaf tag under v2); `cutBatch` builds via `buildMerkleTree(leaves, v2)`, binds `suite` into the signed `anchorPayload` (cryptosuite-agility — `tree_hash_version` is NOT in the payload, bound transitively through `merkle_root`), and persists `relay_anchor_batches.tree_hash_version` (v2 ⇒ string, else NULL). `getSettlementProof` now resolves the batch's stored version and returns `{ proof, record }` — the typed `FederationSettlementAnchorProof` plus the signed record — so a peer self-verifies offline with `verifyFederationSettlementAnchor`. `FEDERATION_TREE_HASH_VERSION` emits v2.
- Migration v29 — `record_json` (on `relay_federation_settlements`) + `tree_hash_version` (on `relay_anchor_batches`), both PRAGMA-guarded ALTERs; both tables are also created with the columns in their startup `CREATE TABLE` (the v27 credential ordering — table created before migrations). Safe because no production federation-settlement-anchor data existed (the §9.1 clean window).

`@motebit/encryption`: the old projection `computeSettlementLeaf` (the hand-typed 9-field leaf a holder could not reproduce) is DELETED — it has no consumers after the convergence; the federation producer now routes through the version-dispatched primitive. The package also re-exports `signFederationSettlement` / `verifyFederationSettlement` / `FEDERATION_SETTLEMENT_RECORD_SUITE` from `@motebit/crypto` for relay consumption.

Gate: `check-merkle-tree-hash-canonical`'s `LEAF_EXCLUSIONS` loses the federation-settlement projection (the arc's terminal act for the `MerkleTreeVersion` axis — every leaf builder on that axis now routes through the primitive); its sole remaining entry becomes `computeFederationGraphAnchor` (the separate-axis federation graph anchor, raw peer-pubkey leaves on its own `algo` field — enumerated, not folded). The federation producer + crypto verifier join `LEAF_BUILDERS`, and `relay-federation-v1.md` §7.6.9 + Option-A frontmatter activates the 4th assertion-4 declaration. `check-signed-artifact-verifiers` (#107) flips federation from an untracked gap to a `verifier`. Drift #114 + #107 updated.
