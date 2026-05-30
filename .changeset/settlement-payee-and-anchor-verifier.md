---
"@motebit/protocol": major
"@motebit/crypto": major
---

Name the payee in the settlement receipt, and ship the portable per-agent settlement-anchor verifier that closes the self-attesting loop.

**Why.** A `SettlementRecord` is the proof a worker holds that it was paid. It named the relay-internal `allocation_id` but not the payee — so the receipt could not stand on its own; a verifier had to ask the relay to resolve the allocation. And the per-agent settlement anchor (`AgentSettlementAnchorProof`, served publicly at `/api/v1/settlements/:id/anchor-proof`) had every piece shipped — producer, endpoint, wire types, spec — except the verifier. The verifier was a tracked gap in `check-signed-artifact-verifiers` because it could not be written honestly: the producer's Merkle leaf was a hand-typed field projection that swapped `allocation_id`→`motebit_id` and dropped the optional `x402_*` fields, so it did not equal the hash of the signed record a worker holds. A spec-faithful verifier would have rejected every real proof; a producer-faithful one would have required a field absent from the worker's record. The leaf must be the hash of the exact signed object — the SCITT / RFC 6962 invariant — never a re-typed subset.

**What changed.**

- `SettlementRecord` gains a required `motebit_id` — the payee, equal to the executing agent's `ExecutionReceipt.motebit_id`. The receipt now names who was paid in its signed body. (`@motebit/protocol`, major.)
- `signSettlement` therefore requires `motebit_id` in its input. (`@motebit/crypto`, major.)
- New portable verifier `verifyAgentSettlementAnchor(record, proof, chainVerifier?)` plus `computeAgentSettlementLeaf(record)` and `AGENT_SETTLEMENT_ANCHOR_SUITE` — a worker verifies offline, with only the signed record, the inclusion proof, and the relay's public key, that the relay anchored exactly that record. The leaf is `SHA-256(canonicalJson(record))` over the whole signed object, never a projection. Third Merkle consumer of the canonical `verifyMerkleInclusion` primitive. (`@motebit/crypto`, additive.)
- The anchor batch payload now binds `suite` inside the signed bytes (cryptosuite-agility), matching the sibling credential-anchor.

`check-signed-artifact-verifiers` moves `AgentSettlementAnchorProof` from a tracked gap to a portable verifier (and `AgentSettlementAnchorBatch` to `within`) — one fewer hole in the self-attesting moat.

## Migration

Constructing a `SettlementRecord` (or calling `signSettlement`) now requires the `motebit_id` payee field:

```ts
const record: SettlementRecord = {
  settlement_id,
  allocation_id,
  motebit_id, // NEW — the payee (the executing agent's motebit_id)
  receipt_hash,
  // …unchanged…
};
```

Relays derive it from the receipt that earned the settlement (`receipt.motebit_id`); `settleOnReceipt` does this automatically. Per-surface SQLite stores add a nullable `motebit_id` column (relay, agent persistence, desktop, mobile migrations included); legacy rows read back an empty payee and fail wire-schema validation, the intended fail-closed signal that the row predates the field.
