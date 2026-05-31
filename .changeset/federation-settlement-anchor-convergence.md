---
"@motebit/protocol": minor
"@motebit/crypto": minor
---

Federation settlement anchoring becomes self-verifiable offline — the closing convergence (PR6) of the RFC 6962 §2.1 tree-hash arc (doctrine: `docs/doctrine/merkle-tree-hash-versioning.md` §8; the deferred item-4 in `spec/agent-settlement-anchor-v1.md` §9.1). The federation settlement stream was the only anchoring stream not yet self-verifiable with `@motebit/crypto` alone; this closes all three counts §9.1 named.

**`@motebit/protocol` (new types):**

- `FederationSettlementRecord` — a relay's signed record of one federation settlement (the verbatim-artifact leaf). Each relay signs its own copy; the signature commits the `(gross, fee, net, rate)` tuple so it cannot issue inconsistent records to different peers. Suite `motebit-jcs-ed25519-b64-v1`.
- `FederationSettlementAnchorProof` (+ `FederationSettlementChainAnchor`) — the self-verifiable Merkle inclusion proof, mirroring `AgentSettlementAnchorProof`: suite-bound `batch_signature`, `siblings`/`layer_sizes`, and the optional `tree_hash_version?` (absent ⇒ `merkle-sha256-plain-v1`, unknown ⇒ reject fail-closed).

**`@motebit/crypto` (new exports — the FOURTH Merkle consumer):**

- `verifyFederationSettlementAnchor(record, proof, chainVerifier?)` — the portable peer-audit verifier. A peer holding the signed record, the proof, and the relay's public key verifies offline that the relay anchored exactly that record into a Merkle root (hash → Merkle inclusion → batch signature → optional onchain), dispatching the RFC 6962 leaf/node tags on `proof.tree_hash_version`.
- `computeFederationSettlementLeaf(record)` — the leaf hash: `canonicalLeaf` over the whole signed record (never a field projection), so producer and holder derive the identical leaf.
- `signFederationSettlement` / `verifyFederationSettlement` (+ `FEDERATION_SETTLEMENT_RECORD_SUITE`) — sign/verify the record itself.
- `FEDERATION_SETTLEMENT_ANCHOR_SUITE`, `FederationSettlementAnchorProofFields`, `FederationSettlementAnchorVerifyResult`.

The convergence replaces the old hand-typed 9-field column projection (a leaf a holder could not reproduce) with the verbatim-artifact hash the per-agent and credential streams already use. The federation producer flips to `merkle-sha256-rfc6962-v2` in the same pass (relay-side change, separate ignored changeset); `relay-federation-v1.md` §7.6 is updated to the converged wire format and §7.6.9 declares the tree-hash version. Backward-compatible: a proof with no `tree_hash_version` resolves to `merkle-sha256-plain-v1`.
