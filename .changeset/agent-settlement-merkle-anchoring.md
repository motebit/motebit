---
"@motebit/api": minor
---

Per-agent settlement Merkle anchoring — the "ceiling" alongside
the signing "floor" (audit follow-up #1 part C). Brings per-agent
settlements to feature parity with federation settlements
(relay-federation-v1.md §7.6, already shipped).

## What this delivers

A worker can now verify they were paid the right amount **without
contacting the relay** — by holding their signed SettlementRecord,
the inclusion proof, and the chain transaction reference. Three
levels of self-attestation now stack:

1. **Signature** (v13): commits the relay to its claimed amounts.
   "Trust the relay's word" → "trust the relay's commitment."
2. **Anchor** (this commit): commits the relay to its claimed
   history. Even an issuer-key compromise cannot retroactively
   rewrite anchored records — the chain transaction is immutable.
3. **External chain verifier** (consumer-side): independent
   confirmation of the Merkle root onchain.

`services/api/CLAUDE.md` rule 6 — "Every truth the relay asserts
is independently verifiable onchain without relay contact" — is
now mechanically delivered for per-agent settlements at parity
with federation.

## What's in this commit

- **Migration v14** (`agent_settlement_anchor_batches`):
  - Creates `relay_agent_anchor_batches` table (mirrors
    `relay_anchor_batches` for federation; separate table because
    audiences differ — federation = peer audit, agent = worker audit).
  - Adds `anchor_batch_id` column to `relay_settlements` (nullable;
    set when batched).
  - Index on `(settled_at, settlement_id) WHERE anchor_batch_id IS
NULL AND signature IS NOT NULL` — selection is constant-time per
    batch cut.

- **`anchoring.ts`**:
  - `cutAgentSettlementBatch(db, relayIdentity, maxSize?)` — selects
    unanchored signed settlements, computes leaves via
    `SHA-256(canonicalJson(signed_record))`, builds Merkle tree,
    signs the anchor record, persists batch + assigns `batch_id` to
    each row. Mirrors `cutBatch` (federation).
  - `submitAgentAnchorOnChain(db, batchId, submitter)` — submits
    Merkle root onchain via existing `ChainAnchorSubmitter`.
    Idempotent: only acts on `status = 'signed'` batches.
  - `getAgentSettlementProof(db, settlementId)` — returns inclusion
    proof + anchor record for a settlement. Sufficient for an
    external verifier to recompute the leaf from their held
    SettlementRecord, walk the Merkle path, and compare against
    the onchain root.

- **Legacy-row safety**: only signed settlements are batched.
  Pre-v13 unsigned rows skip selection (`signature IS NOT NULL`
  filter) — they cannot be anchored because the leaf would not
  match what the relay signed (it didn't).

8 new tests (cutAgentSettlementBatch + getAgentSettlementProof
covering happy path, batch_id assignment, legacy-row filter,
maxSize, proof reconstruction, missing-batch). 870 relay tests
total (was 862).

## Architectural symmetry

| Audience        | Table                        | Cut function              | Proof function            |
| --------------- | ---------------------------- | ------------------------- | ------------------------- |
| Federation peer | `relay_anchor_batches`       | `cutBatch`                | `getSettlementProof`      |
| Agent (worker)  | `relay_agent_anchor_batches` | `cutAgentSettlementBatch` | `getAgentSettlementProof` |

Same `ChainAnchorSubmitter` adapter (Solana Memo by default; EVM
contract via legacy submitter). Same Merkle primitives
(`buildMerkleTree`, `getMerkleProof` from `@motebit/encryption`).
Different leaf computations, different aggregation, but the trust
shape is identical.

## Out of scope (future work)

- Wire-format `AgentSettlementAnchorProof` schema in
  `@motebit/wire-schemas` (would parallel `CredentialAnchorProof`).
- HTTP endpoint to fetch a proof for an agent settlement.
- CLI subcommand `motebit verify agent-settlement-proof <path>`
  to run end-to-end verification offline.
- Periodic batching loop hook for per-agent settlements (today
  callable manually; production deployment can wire it into
  `startBatchAnchorLoop` parallel).
