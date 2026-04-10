# motebit/credential-anchor@1.0

**Status:** Draft  
**Authors:** Daniel Hakim  
**Created:** 2026-04-10

## 1. Purpose

Credential anchoring makes agent reputation portable. The full credential stays at the relay (aggregation, routing, privacy). The hash goes onchain. If the relay disappears, the agent's reputation history is independently verifiable.

Settlement receipts already anchor payment proof onchain (settlement-v1.md §6). This spec extends the same principle to trust proof: credential hashes anchored via Merkle batches, self-verifiable without relay contact.

## 2. Design Principles

**Additive, never gatekeeping.** The onchain anchor is supplementary evidence. Credentials are valid with or without an anchor. A relay that never anchors still participates in the protocol. A credential that is anchored gains non-repudiability — the relay cannot later deny it existed.

**Self-verifiable.** Given a credential, its Merkle proof, and the anchor transaction, any party can verify inclusion without contacting the relay.

**Chain-agnostic foundation law.** The anchoring format is defined independently of any specific chain. The reference implementation uses Solana (Ed25519 curve coincidence), but any chain that supports data publication is compliant.

## 3. Credential Leaf Hash

A credential leaf is the SHA-256 hash of the full W3C VC 2.0 credential including its `proof` field:

```
credential_leaf = SHA-256(canonicalJson(credential))
```

Where `canonicalJson` is JCS/RFC 8785 deterministic JSON serialization (same as used by all other Motebit artifacts).

The proof field is included because it binds the credential to its issuer's signature. Without the proof, anyone could claim to have a credential with arbitrary content.

### 3.1 Verification

To verify a credential leaf:

1. Obtain the full credential (with proof)
2. Compute `SHA-256(canonicalJson(credential))`
3. Compare to the claimed leaf hash

This step is independent of anchoring — it verifies the credential maps to the claimed hash.

## 4. Anchor Batch

Credentials are batched into Merkle trees for efficient onchain anchoring. One transaction anchors many credentials.

### 4.1 Batch Format

```
CredentialAnchorBatch {
  batch_id:         string      // UUID v4
  relay_id:         string      // MotebitId of the anchoring relay
  merkle_root:      string      // hex-encoded SHA-256 root
  leaf_count:       number      // number of credentials in batch
  credential_ids:   string[]    // ordered credential IDs (for proof reconstruction)
  first_issued_at:  number      // ms timestamp of earliest credential
  last_issued_at:   number      // ms timestamp of latest credential
  signature:        string      // hex-encoded Ed25519 signature by relay
}
```

### 4.2 Batch Construction

1. Select unanchored credentials from `relay_credentials`, ordered by `(issued_at ASC, credential_id ASC)` — deterministic sort for reproducible trees
2. Compute leaf hash for each credential via §3
3. Build binary Merkle tree with odd-leaf promotion (no duplication) — same algorithm as settlement anchoring (relay-federation-v1.md §7.6)
4. Sign the batch payload:

```
batch_payload = canonicalJson({
  batch_id,
  merkle_root,
  leaf_count,
  first_issued_at,
  last_issued_at,
  relay_id
})

signature = Ed25519.sign(batch_payload, relay_private_key)
```

### 4.3 Batch Triggers

Two triggers (either fires the batch):

- **Count:** unanchored credentials ≥ `batchMaxSize` (default: 50)
- **Time:** oldest unanchored credential age ≥ `batchIntervalMs` (default: 1 hour)

Smaller default batch size than settlement anchoring (50 vs 100) because credentials accumulate faster than settlements.

## 5. Anchor Proof

A self-verifiable proof that a specific credential was included in an anchored batch.

### 5.1 Proof Format

```
CredentialAnchorProof {
  credential_id:    string      // identifies the credential
  credential_hash:  string      // hex SHA-256 leaf hash
  batch_id:         string      // which batch contains this credential
  merkle_root:      string      // hex root of the batch tree
  leaf_count:       number      // number of credentials in the batch
  first_issued_at:  number      // ms timestamp of earliest credential
  last_issued_at:   number      // ms timestamp of latest credential
  leaf_index:       number      // position in the leaf array
  siblings:         string[]    // hex Merkle proof path
  layer_sizes:      number[]    // for odd-leaf promotion detection
  relay_id:         string      // relay that created the batch
  relay_public_key: string      // hex Ed25519 public key (for signature verification)
  batch_signature:  string      // hex Ed25519 signature over batch payload
  anchor: {                     // null if batch is signed but not yet onchain
    chain:          string      // e.g., "solana"
    network:        string      // CAIP-2 identifier, e.g., "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"
    tx_hash:        string      // transaction hash on the target chain
    anchored_at:    number      // ms timestamp
  } | null
}
```

The `leaf_count`, `first_issued_at`, and `last_issued_at` fields are required in the proof because they are part of the signed batch payload (§4.2). Without them, step 3 of the verification algorithm cannot reconstruct the payload for signature verification.

### 5.2 Verification Algorithm

Given a credential `vc` and its `CredentialAnchorProof`:

1. **Hash verification:** `SHA-256(canonicalJson(vc)) === proof.credential_hash`
2. **Merkle inclusion:** Verify `(leaf=credential_hash, index=leaf_index, siblings, layer_sizes)` reconstructs to `merkle_root`
3. **Relay attestation:** `Ed25519.verify(batch_signature, canonicalJson({batch_id, merkle_root, leaf_count, first_issued_at, last_issued_at, relay_id}), relay_public_key)` — proves the relay signed this batch
4. **Onchain anchor** (if `anchor` is non-null): Look up `anchor.tx_hash` on `anchor.chain` — the transaction's data field contains the Merkle root, proving the relay published it at `anchored_at`

Steps 1-3 are verifiable offline with only the credential, proof, and relay's public key.  
Step 4 additionally proves the root was made immutable and public.

Without step 4, the relay's signature still provides accountability — the relay signed the batch with its Ed25519 key, and that signature is non-repudiable. The onchain anchor prevents the relay from later claiming it never signed the batch (the private key could theoretically be rotated and the old batch denied).

### 5.3 Reference Implementation

The canonical implementation is `verifyCredentialAnchor` in `@motebit/crypto` (MIT). It takes a credential, a `CredentialAnchorProofFields` struct, and an optional `ChainAnchorVerifier` callback for step 4. Returns `CredentialAnchorVerifyResult` with per-step breakdown (`hash_valid`, `merkle_valid`, `relay_signature_valid`, `chain_verified`) and error messages.

```ts
import { verifyCredentialAnchor } from "@motebit/crypto";

const result = await verifyCredentialAnchor(credential, proof);
if (result.valid) {
  // All offline steps passed — credential was anchored by this relay
}
```

The Merkle proof verification is inlined in `@motebit/crypto` (same algorithm as `@motebit/encryption/merkle.ts`) so the package maintains zero monorepo dependencies. Any implementation can verify anchor proofs using only `@motebit/crypto` and the relay's public key.

## 6. Chain Submission

### 6.1 Foundation Law

The protocol requires only that the Merkle root is published to a publicly readable, append-only data store. The specific chain, transaction format, and program/contract are implementation details.

Required properties:

- **Public readability:** Any party can look up the anchor by transaction hash
- **Immutability:** The anchor cannot be modified or deleted after publication
- **Attribution:** The transaction is attributable to the relay's identity

### 6.2 Reference Implementation: Solana Memo

The reference implementation uses the Solana Memo Program (MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr).

**Why Solana:** The relay's Ed25519 identity key is natively a valid Solana address (same curve coincidence used by sovereign payment in settlement-v1.md §6.1). No second key, no custodial provider.

**Transaction format:**

- Signer: Relay's Ed25519 keypair (identity key = Solana address)
- Program: Memo v2 (`MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr`)
- Memo data: `motebit:credential-anchor:v1:{merkle_root_hex}:{leaf_count}`

The memo is human-readable and machine-parseable. The relay's signature is the Solana transaction signature. The transaction hash is the permanent reference.

**Verification:** Given `tx_hash`, call `getTransaction(tx_hash)` on any Solana RPC. Parse the memo instruction data. Extract the Merkle root. Compare to the proof's `merkle_root`.

### 6.3 Alternative Implementations

Compliant alternatives include:

- EVM chains via calldata or event logs
- IPFS with onchain CID anchoring
- Any append-only ledger with Ed25519 signature support
- Arweave permanent storage

The anchor format in the proof (`{chain, network, tx_hash, anchored_at}`) is chain-agnostic.

## 7. Relay API

### 7.1 Proof Retrieval

```
GET /api/v1/credentials/{credentialId}/anchor-proof
```

Returns `CredentialAnchorProof` (§5.1) or:

- `404` if credential not found
- `202` with `Retry-After: 60` if credential exists but is not yet batched

### 7.2 Batch Query

```
GET /api/v1/credential-anchors/{batchId}
```

Returns batch metadata including anchor status.

## 8. Security Considerations

**Credential privacy.** Only hashes go onchain. The full credential content stays at the relay. An observer who sees the onchain anchor learns only that N credentials were batched at time T — not their content, subjects, or issuers.

**Batch manipulation.** The relay could theoretically omit credentials from a batch. Agents can detect this by requesting their anchor proof after the batch window. Missing credentials are evidence of censorship. Federation peers can cross-check batch leaf counts against expected credential volumes.

**Relay impersonation.** The batch signature binds to the relay's Ed25519 identity. A forged batch would require the relay's private key. Key succession (identity-v1.md §4) extends chain of custody to anchor verification.

**Stale anchors.** Anchors prove existence at a point in time. A revoked credential's anchor remains valid — it proves the credential existed before revocation. Revocation status is orthogonal to anchoring (check revocation separately per credential-v1.md §7).

## 9. Relationship to Settlement Anchoring

Settlement anchoring (relay-federation-v1.md §7.6) and credential anchoring share the Merkle tree infrastructure but are separate batch streams:

| Property           | Settlement Anchoring                         | Credential Anchoring               |
| ------------------ | -------------------------------------------- | ---------------------------------- |
| Source table       | `relay_federation_settlements`               | `relay_credentials`                |
| Leaf hash          | Settlement fields → canonical JSON → SHA-256 | Full VC → canonical JSON → SHA-256 |
| Default batch size | 100                                          | 50                                 |
| Reference chain    | EVM (Base)                                   | Solana                             |
| Batch table        | `relay_anchor_batches`                       | `relay_credential_anchor_batches`  |

Both use the same `buildMerkleTree`, `getMerkleProof`, `verifyMerkleProof` functions from the shared Merkle library.
