# motebit/consolidation-receipt@1.0

**Status:** Stable  
**Authors:** Daniel Hakim  
**Created:** 2026-04-20

## 1. Purpose

A motebit is a droplet of intelligence under surface tension. The interior is active: during idle windows the motebit runs a four-phase consolidation cycle (orient → gather → consolidate → prune) that reshapes its memory graph. This spec is the self-attesting evidence of that work — two artifacts that together make a motebit's proactive history independently verifiable from its public key alone, without relay contact.

**ConsolidationReceipt** — the primary, per-cycle artifact. The motebit signs a structural record of a single cycle's output (counts of memories merged, promoted, pruned; timestamps; phase list) with its Ed25519 identity key. Self-verifiable from the receipt alone.

**ConsolidationAnchor** — the batched, onchain-attestable artifact. The motebit groups N signed receipts, computes a Merkle root over their canonical-JSON SHA-256 leaves, optionally publishes the root as a Solana memo (same format as motebit/credential-anchor@1.0 §6.2: `motebit:anchor:v1:{root}:{leaf_count}`). The chain transaction — signed by the motebit's identity key, which IS its Solana address by Ed25519 curve coincidence — is the timestamp attestation.

## 2. Design Principles

**Privacy boundary is the type.** The `summary` field of `ConsolidationReceipt` is a closed set of integer counts (`orient_nodes`, `gather_clusters`, `consolidate_merged`, `pruned_decay`, etc.). No field could carry memory content, embeddings, or sensitive identifiers. Adding such a field is a protocol break — a consumer of a v1.x receipt MUST NOT be required to handle memory text to verify work was done. This constrains future evolution: any richer attestation (e.g., committing to memory-shape statistics beyond counts) requires a v2 with a fresh suite identifier.

**Sovereign Ed25519, not operator key.** The signer of a receipt is the motebit's own identity keypair. The signer of the Solana transaction carrying the anchor is the same keypair. No relay, no custodial provider, no billing relationship. A receipt issued today is verifiable in a decade with only the receipt bytes and the public key — the usual self-attesting-system property of every motebit artifact.

**Anchoring is additive, never gatekeeping.** A motebit without a Solana wallet still signs receipts; signed receipts are verifiable offline. Anchoring adds a timestamp attestation; it does not add a new trust requirement. A verifier who trusts only the motebit's public key has a complete path; a verifier who additionally trusts Solana's finality has a stronger path.

**Self-attesting.** A third party with `(publicKey, anchor, receipts)` can verify end-to-end with no network calls beyond an optional Solana RPC tx fetch. Reference verification logic: the verifier described in §4.5 — any language with JSON Schema validation, Ed25519, and SHA-256 can implement it.

## 3. ConsolidationReceipt

#### Wire format (foundation law)

Every implementation MUST emit and accept this exact shape when producing a signed receipt.

```
ConsolidationReceipt {
  receipt_id:      string                  // UUIDv4 — receipt's own identity
  motebit_id:      string                  // signer's MotebitId
  public_key?:     string                  // hex Ed25519 public key, for portable verification
  cycle_id:        string                  // matches consolidation_cycle_run event
  started_at:      number                  // ms since Unix epoch
  finished_at:     number
  phases_run:      ("orient"|"gather"|"consolidate"|"prune")[]
  phases_yielded:  ("orient"|"gather"|"consolidate"|"prune")[]
  summary: {
    orient_nodes?:          number
    gather_clusters?:       number
    gather_notable?:        number
    consolidate_merged?:    number
    pruned_decay?:          number
    pruned_notability?:     number
    pruned_retention?:      number
  }
  suite:           "motebit-jcs-ed25519-b64-v1"
  signature:       string                  // base64url Ed25519 signature
}
```

The TypeScript type `ConsolidationReceipt` in `@motebit/protocol` is the binding machine-readable form. The zod + JSON Schema is `ConsolidationReceiptSchema` in `@motebit/wire-schemas`. Verifiers reject missing or unknown `suite` values fail-closed.

#### Storage (reference convention — non-binding)

The reference runtime persists signed receipts as `consolidation_receipt_signed` events in its event log, with the full signed body in `event.payload.receipt`. Alternative implementations MAY store anywhere — what the wire format pins is the bytes of the receipt itself, not the envelope that carries them.

### 3.1 Signing

```
body      = receipt without `signature` (with `suite` and optional `public_key` set)
canonical = canonicalJson(body)   // JCS / RFC 8785
message   = UTF-8 bytes of canonical
signature = base64url(Ed25519.sign(message, motebit_private_key))
```

Reference producer: the motebit runtime's consolidation cycle (`runtime.consolidationCycle()`) signs after a cycle completes, if signing keys are configured and at least one phase ran.

### 3.2 Verification

A third party given `(receipt, publicKey)` verifies offline:

1. `receipt.suite === "motebit-jcs-ed25519-b64-v1"` (fail-closed on mismatch)
2. `body = receipt without signature`
3. `canonical = canonicalJson(body)`
4. `ok = Ed25519.verify(UTF-8 bytes of canonical, fromBase64url(receipt.signature), publicKey)`

## 4. ConsolidationAnchor

#### Wire format (foundation law)

Every implementation MUST emit and accept this exact shape when producing an anchor.

```
ConsolidationAnchor {
  batch_id:        string        // UUIDv4 — anchor's own identity
  motebit_id:      string        // the motebit whose receipts are batched;
                                 //   also the signer of the Solana tx when submitted
  merkle_root:     string        // hex-encoded SHA-256 Merkle root
  receipt_ids:     string[]      // ordered list — commits the leaf order
  leaf_count:      number        // === receipt_ids.length (parser convenience)
  anchored_at:     number        // ms timestamp when the anchor record was produced
  tx_hash?:        string        // Solana signature (base58) if submitted onchain
  network?:        string        // CAIP-2 network id, e.g.
                                 //   "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"
}
```

The TypeScript type `ConsolidationAnchor` in `@motebit/protocol` is binding. The zod + JSON Schema is `ConsolidationAnchorSchema` in `@motebit/wire-schemas`.

The anchor itself is NOT separately signed. Its cryptographic load is carried by two things, neither requiring a batch-level signature:

1. The Ed25519 signature on each receipt it groups.
2. The Solana transaction signed by the motebit's identity key (when `tx_hash` populated). The memo text is `motebit:anchor:v1:{merkle_root}:{leaf_count}` — same format as motebit/credential-anchor@1.0 (§6.2).

### 4.1 Leaf construction

```
leaf[i] = hex(SHA-256(UTF-8 bytes of canonicalJson(receipts[i])))
```

The leaf commits the entire SIGNED receipt body (including `signature`). "The motebit published exactly this signed artifact," not "the motebit published a receipt with these fields that could be re-signed."

### 4.2 Leaf order

Receipts sort by `(finished_at ASC, receipt_id ASC)` before leaf construction. The order is deterministic and reproducible — given the same set of receipts, any verifier computes the same Merkle root. `ConsolidationAnchor.receipt_ids` commits this order; verifiers MUST preserve it.

### 4.3 Merkle tree

Binary tree with odd-leaf promotion (no duplication). Internal nodes are `SHA-256(left || right)` of raw bytes. Same algorithm as motebit/credential-anchor@1.0 and relay-federation-v1.md §7.6.2.

### 4.4 Onchain submission (optional)

When a chain-anchor submitter is configured, the runtime submits:

```
memo = "motebit:anchor:v1:" + merkle_root + ":" + leaf_count
```

to the Solana Memo Program (`MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr`) in a transaction signed by the motebit's identity key. The resulting signature becomes `anchor.tx_hash`. Reference submitter: `SolanaMemoSubmitter` in `@motebit/wallet-solana`.

A submitter failure is non-fatal; the runtime emits a local-only anchor with `tx_hash` absent. The Merkle root is still verifiable by recomputation; it just isn't timestamp-attested.

### 4.5 Verification

A third party given `(anchor, receipts, publicKey)` verifies offline:

1. `receipts.length === anchor.receipt_ids.length`
2. For each `i`: `receipts[i].receipt_id === anchor.receipt_ids[i]` (caller preserves order)
3. For each receipt: §3.2 passes
4. `leaves = receipts.map(r => hex(SHA-256(canonicalJson(r))))`
5. `recomputedRoot = merkleRoot(leaves)` equals `anchor.merkle_root`

When the verifier additionally has `anchor.tx_hash`:

6. Fetch the Solana tx by `tx_hash`
7. Parse the memo via `motebit:anchor:v1:{root}:{leaf_count}`
8. Verify the parsed root equals `anchor.merkle_root`
9. Verify the tx signer's pubkey matches `publicKey` (the motebit's identity = Solana address)

Reference verifier: third-party implementations may match the behavior of `@motebit/encryption`'s verifier; the canonical definition is this spec.

## 5. Deferred

- **Per-receipt inclusion proofs.** A Merkle proof that lets a holder of a single receipt prove membership without having the other receipts. Required if the motebit stores only receipts + proofs rather than the full anchor+receipts set. Not emitted by the reference runtime today.
- **Batch signature.** An explicit signature over the canonical anchor body, analogous to `AgentSettlementAnchorBatch` in motebit/agent-settlement-anchor@1.0. Skipped here because the receipts inside + the Solana tx signature together provide full cryptographic coverage. May be added in v1.1 if a verifier workflow emerges that has the anchor but not the tx hash.
- **Revocation.** Revoking a signed receipt after the fact is out of scope — consolidation cycles are append-only evidence. If a consumer later disputes a receipt (e.g., "the cycle ran but produced no real work"), that's a dispute-resolution concern (dispute-v1.md), not a receipt-revocation concern.
- **Non-Solana chains.** The Ed25519/Solana coincidence makes Solana the natural first rail. Any chain that supports an identity-key-signed append-only memo works as an anchoring rail; a non-Ed25519 chain would require a separate adapter plus a suite widening. Not in scope for v1.

## 6. Relationship to other specs

- **motebit/credential-anchor@1.0** — same memo format, same submitter primitive, same Merkle algorithm. Consolidation anchors are the per-motebit, proactive-work analogue of per-relay credential anchors.
- **motebit/agent-settlement-anchor@1.0** — the ancestor of this spec's anchor shape. Settlement anchors commit to the relay-attestable fact of a worker's payment; consolidation anchors commit to the self-attestable fact of a motebit's proactive interior work.
- **execution-ledger-v1.md** — execution receipts commit to the motebit's response to a user turn. Consolidation receipts commit to the motebit's self-directed work between turns. Together they cover the motebit's full activity — both reactive and proactive.

Doctrine: [`docs/doctrine/proactive-interior.md`](../docs/doctrine/proactive-interior.md).
