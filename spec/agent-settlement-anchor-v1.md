# motebit/agent-settlement-anchor@1.0

**Status:** Draft  
**Authors:** Daniel Hakim  
**Created:** 2026-04-18

## 1. Purpose

Per-agent settlement anchoring closes the trust pyramid for individual workers. The signed `SettlementRecord` (settlement-v1.md §3 + delegation-v1.md §6.4) is the **floor** — a worker can verify the relay attested to their payment without trusting any sibling system. This spec adds the **ceiling**: a Merkle inclusion proof that an external auditor can resolve to an onchain transaction without contacting the relay.

A worker who holds (a) a `SettlementRecord`, (b) an `AgentSettlementAnchorProof` for it, and (c) the relay's public key can verify they were paid the correct amount. If the relay later disappears, the chain transaction proves the relay attested to the batch — the worker's evidence remains intact.

This is the per-agent analogue of inter-relay settlement anchoring (relay-federation-v1.md §7.6) and credential anchoring (credential-anchor-v1.md). Same primitive, different audience: federation = peer audit between relays; credential = portability of agent reputation; **per-agent settlement = worker audit of relay-as-counterparty**.

## 2. Design Principles

**Additive, never gatekeeping.** A relay that never anchors per-agent settlements still settles correctly — the signed `SettlementRecord` is the primary trust mechanism. The onchain anchor is non-repudiability: it prevents the relay from later denying having attested to the batch.

**Self-verifiable.** Given a `SettlementRecord`, its `AgentSettlementAnchorProof`, and the relay's public key, any party can verify offline. Onchain comparison adds non-repudiation but is not required for correctness.

**Chain-agnostic foundation law.** The reference implementation uses the same EVM contract as federation settlement anchoring (relay-federation-v1.md §7.6.5) — one anchor stream per chain reference for operator simplicity. Alternative chains comply if they offer public, immutable, attributable data publication.

**Sovereign floor honored.** The ledger_hash field on `SettlementRecord` (settlement-v1.md §3.2 — null when relay does not publish a ledger) is included in the leaf. A relay-optional settlement (sovereign rail, p2p) anchors with `ledger_hash: null` and still produces a valid proof — the worker's signed receipt stands on its own.

## 3. Per-Agent Settlement Leaf Hash

A per-agent settlement leaf is the SHA-256 hash of the canonical JSON of the **whole signed `SettlementRecord`** (signature included). The leaf commits the entire signed artifact, so reconstructing it requires only the bytes the worker already holds:

```
agent_settlement_leaf = SHA-256(canonicalJson({
  settlement_id,
  motebit_id,
  receipt_hash,
  ledger_hash,
  amount_settled,
  platform_fee,
  platform_fee_rate,
  status,
  settled_at,
  issuer_relay_id,
  suite,
  signature
}))
```

`canonicalJson` is JCS/RFC 8785 deterministic serialization, the same canonicalization the relay used to sign the record itself.

The signature is included in the leaf because the worker holds the signed artifact end-to-end. The leaf commits "the relay attested to exactly this record" rather than "the relay attested to a record with these fields." This avoids a re-signing ambiguity at verification time.

### 3.1 Verification

To verify a settlement leaf:

1. Take the full signed `SettlementRecord` the worker holds
2. Compute `SHA-256(canonicalJson(record))`
3. Compare to the claimed `settlement_hash` in the proof

This step is independent of anchoring — it verifies the record maps to the claimed leaf hash.

## 4. Anchor Batch

Per-agent settlements are batched into Merkle trees for efficient onchain anchoring. One transaction anchors many settlements.

### 4.1 — AgentSettlementAnchorBatch

#### Wire format (foundation law)

Every implementation MUST emit and accept this exact shape when publishing a batch record. Field names, types, and ordering of signed fields are binding.

```
AgentSettlementAnchorBatch {
  batch_id:          string      // UUID v4
  relay_id:          string      // MotebitId of the anchoring relay
  merkle_root:       string      // hex-encoded SHA-256 root
  leaf_count:        number      // number of settlements in batch
  first_settled_at:  number      // ms timestamp of earliest settlement
  last_settled_at:   number      // ms timestamp of latest settlement
  suite:             string      // "motebit-jcs-ed25519-hex-v1" — cryptosuite identifier (see @motebit/protocol SUITE_REGISTRY)
  signature:         string      // hex-encoded Ed25519 signature by relay
  anchor: {                      // null if signed but not yet onchain
    chain:           string      // e.g., "eip155"
    network:         string      // CAIP-2 identifier, e.g., "eip155:8453" (Base)
    tx_hash:         string      // transaction hash on the target chain
    anchored_at:     number      // ms timestamp of confirmation
  } | null
}
```

The TypeScript type `AgentSettlementAnchorBatch` in `@motebit/protocol` is the binding machine-readable form. Verifiers reject missing or unknown `suite` values fail-closed.

#### Storage (reference convention — non-binding)

The reference relay persists batch rows in `relay_agent_anchor_batches` keyed by `batch_id`. Membership is recorded by setting `relay_settlements.anchor_batch_id` on each included row. Alternative implementations MAY use any shape so long as the wire format above is preserved on egress.

### 4.2 Batch Construction

1. Select unanchored signed settlements from `relay_settlements`, ordered by `(settled_at ASC, settlement_id ASC)` — deterministic sort for reproducible trees. **Pre-signing legacy rows (`signature IS NULL`) are NOT eligible** — the leaf would not match anything the relay attested to.
2. Compute leaf hash for each settlement via §3
3. Build binary Merkle tree with odd-leaf promotion (no duplication) — same algorithm as settlement anchoring (relay-federation-v1.md §7.6.2)
4. Sign the batch payload:

```
batch_payload = canonicalJson({
  batch_id,
  merkle_root,
  leaf_count,
  first_settled_at,
  last_settled_at,
  relay_id
})

signature = Ed25519.sign(batch_payload, relay_private_key)
```

### 4.3 Batch Triggers

Two triggers (either fires the batch):

- **Count:** unanchored signed settlements ≥ `batchMaxSize` (default: 100)
- **Time:** oldest unanchored signed settlement age ≥ `batchIntervalMs` (default: 1 hour)

Same defaults as federation settlement anchoring. Per-agent and federation streams batch independently — a relay running both has two parallel loops, one per source table.

## 5. Anchor Proof

A self-verifiable proof that a specific per-agent settlement was included in an anchored batch.

### 5.1 — AgentSettlementAnchorProof

#### Wire format (foundation law)

Every implementation MUST emit and accept this exact shape on the `GET /api/v1/settlements/{settlementId}/anchor-proof` response boundary. The proof is self-verifiable offline from this document plus the signed `SettlementRecord` and the relay's public key.

```
AgentSettlementAnchorProof {
  settlement_id:     string      // identifies the settlement
  settlement_hash:   string      // hex SHA-256 leaf hash (§3)
  batch_id:          string      // which batch contains this settlement
  merkle_root:       string      // hex root of the batch tree
  leaf_count:        number      // number of settlements in the batch
  first_settled_at:  number      // ms timestamp of earliest settlement
  last_settled_at:   number      // ms timestamp of latest settlement
  leaf_index:        number      // position in the leaf array
  siblings:          string[]    // hex Merkle proof path
  layer_sizes:       number[]    // for odd-leaf promotion detection
  relay_id:          string      // relay that created the batch
  relay_public_key:  string      // hex Ed25519 public key (for signature verification)
  suite:             string      // "motebit-jcs-ed25519-hex-v1" — cryptosuite identifier for batch_signature (see @motebit/protocol SUITE_REGISTRY)
  batch_signature:   string      // hex Ed25519 signature over batch payload
  anchor: {                      // null if batch is signed but not yet onchain
    chain:           string      // e.g., "eip155"
    network:         string      // CAIP-2 identifier, e.g., "eip155:8453"
    tx_hash:         string      // transaction hash on the target chain
    anchored_at:     number      // ms timestamp
  } | null
}
```

The `leaf_count`, `first_settled_at`, and `last_settled_at` fields are required in the proof because they are part of the signed batch payload (§4.2). Without them, step 3 of the verification algorithm cannot reconstruct the payload for signature verification.

### 5.2 Verification Algorithm

Given a signed `SettlementRecord` and its `AgentSettlementAnchorProof`:

1. **Record signature:** `Ed25519.verify(record.signature, canonicalJson(record_without_signature), relay_public_key)` — proves the relay attested to this exact settlement (settlement-v1.md §3.3 floor)
2. **Leaf hash:** `SHA-256(canonicalJson(record_with_signature)) === proof.settlement_hash`
3. **Merkle inclusion:** Verify `(leaf=settlement_hash, index=leaf_index, siblings, layer_sizes)` reconstructs to `proof.merkle_root`
4. **Batch signature:** `Ed25519.verify(batch_signature, canonicalJson({batch_id, merkle_root, leaf_count, first_settled_at, last_settled_at, relay_id}), relay_public_key)` — proves the relay signed the batch
5. **Onchain anchor** (if `anchor` is non-null): Look up `anchor.tx_hash` on `anchor.chain` — the transaction's data field contains the Merkle root, proving the relay published it at `anchored_at`

Steps 1–4 are verifiable offline with only the signed record, proof, and relay's public key.  
Step 5 additionally proves the root was made immutable and public.

Without step 5, the relay's batch signature still provides accountability — the relay signed the batch with its Ed25519 key, and that signature is non-repudiable at any later time the verifier holds the proof. The onchain anchor prevents the relay from later claiming it never signed the batch (the private key could theoretically be rotated and the old batch denied).

#### Storage (reference convention — non-binding)

The reference relay stores `merkle_root`, `leaf_count`, `first_settled_at`, `last_settled_at`, `signature`, and `suite` on the `relay_agent_anchor_batches` row; `siblings` and `layer_sizes` are reconstructed from the ordered settlement IDs at proof-serve time. Alternative implementations MAY precompute and persist every proof, or compute them lazily. The wire format above is what crosses the boundary.

## 6. Chain Submission

Per-agent settlement anchoring uses the same chain-submission contract as federation settlement anchoring — see relay-federation-v1.md §7.6.5 for the reference EVM contract on Base, the gas characteristics, and asynchronous semantics. The same `ChainAnchorSubmitter` interface (`@motebit/protocol`) is satisfied by the same implementations.

A relay running both federation and per-agent anchoring shares one submitter; each batching loop calls `submitMerkleRoot` independently. The chain transactions are distinct (different `merkle_root` values) and do not need any cross-stream coordination.

## 7. Relay API

### 7.1 Proof Retrieval

```
GET /api/v1/settlements/{settlementId}/anchor-proof
```

Returns `AgentSettlementAnchorProof` (§5.1) or:

- `404` if settlement not found, or settlement is unsigned legacy (cannot be anchored)
- `202` with `Retry-After: 60` if settlement is signed but not yet batched

This endpoint is **public** — no bearer auth required, per services/api/CLAUDE.md rule 6 ("every truth the relay asserts is independently verifiable onchain without relay contact"). An external auditor will not hold a relay-issued bearer token. Rate-limited at the public tier (same as `/api/v1/credentials/{credentialId}/anchor-proof`).

### 7.2 Batch Query

```
GET /api/v1/settlement-anchors/{batchId}
```

Returns `AgentSettlementAnchorBatch` (§4.1) metadata including anchor status. Public, rate-limited identically.

## 8. Security Considerations

**Worker privacy.** Only the leaf hash goes onchain. The full `SettlementRecord` (including `motebit_id`, amounts, `receipt_hash`, `ledger_hash`) stays at the relay. An observer who sees the onchain anchor learns only that N settlements were batched at time T — not the workers, amounts, or counterparties.

**Batch manipulation.** The relay could theoretically omit a worker's settlement from a batch. The worker detects this by requesting their proof after the batch window — a missing proof for a known settlement is evidence of censorship. Federation peers can cross-check batch leaf counts against per-relay settlement volume.

**Relay impersonation.** The batch signature binds to the relay's Ed25519 identity. A forged batch would require the relay's private key. Key succession (identity-v1.md §4) extends chain of custody to anchor verification.

**Stale anchors.** Anchors prove existence at a point in time. A refunded or disputed settlement's anchor remains valid — it proves the settlement existed before the dispute window expired. Refund and dispute status are orthogonal to anchoring (check via settlement-v1.md §7 dispute state and `relay_settlements.status`).

**Ledger-hash null.** A relay running on a sovereign rail (settlement-v1.md §6) does not publish a separate ledger; `ledger_hash` is null. The leaf canonicalization preserves the null — `canonicalJson({ledger_hash: null, ...})` is bit-identical across implementations. Verifiers must accept null `ledger_hash` as valid; rejecting it would break the sovereign-floor doctrine.

## 9. Relationship to Other Anchoring

Three anchoring streams use the same Merkle primitive but serve distinct audiences:

| Property               | Federation Settlement (relay-federation-v1.md §7.6) | Per-Agent Settlement (this spec)            | Credential (credential-anchor-v1.md)              |
| ---------------------- | --------------------------------------------------- | ------------------------------------------- | ------------------------------------------------- |
| **Audience**           | Inter-relay peer audit                              | Worker audit of relay-as-counterparty       | External verifier of agent reputation portability |
| **Source table**       | `relay_federation_settlements`                      | `relay_settlements` (signed rows only)      | `relay_credentials`                               |
| **Leaf content**       | Federation settlement subset                        | Whole signed `SettlementRecord`             | Full W3C VC 2.0 with proof                        |
| **Default batch size** | 100                                                 | 100                                         | 50                                                |
| **Reference chain**    | EVM (Base)                                          | EVM (Base) — shared submitter               | Solana                                            |
| **Batch table**        | `relay_anchor_batches`                              | `relay_agent_anchor_batches`                | `relay_credential_anchor_batches`                 |
| **Proof endpoint**     | `GET /federation/v1/settlement/proof?...`           | `GET /api/v1/settlements/{id}/anchor-proof` | `GET /api/v1/credentials/{id}/anchor-proof`       |
| **Batch endpoint**     | (federation API, peer-only)                         | `GET /api/v1/settlement-anchors/{id}`       | `GET /api/v1/credential-anchors/{id}`             |
| **Public access**      | Federation peer (auth)                              | Public (no auth) — rule 6                   | Public (no auth) — rule 6                         |

All three use the same `buildMerkleTree`, `getMerkleProof`, and `verifyMerkleProof` primitives from the shared Merkle library, and the same `ChainAnchorSubmitter` interface (`@motebit/protocol`).
