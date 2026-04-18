---
"@motebit/api": minor
---

Per-agent settlement Merkle anchoring — the "ceiling" parallel to
the federation case. Closes the self-attesting trust pyramid for
per-agent settlements: signed `SettlementRecord` (floor) + Merkle
inclusion proof (middle) + onchain anchor reference (ceiling).

What ships:

- **Batching loop**: `cutAgentSettlementBatch` collects signed,
  unanchored rows from `relay_settlements`; `submitAgentAnchorOnChain`
  publishes the root via the same `OnChainAnchorSubmitter` abstraction
  as the federation path. Loop wires under `agentAnchorInterval` in
  `createSyncRelay`. New table `relay_agent_anchor_batches` keeps
  the per-agent ledger separate from the federation ledger — distinct
  audiences, identical primitives.
- **HTTP endpoints** (public, rate-limited):
  - `GET /api/v1/settlements/:settlementId/anchor-proof` — returns
    `202 {status: "pending"}` with `Retry-After: 60` for signed-but-
    unbatched settlements; `200` with leaf hash + Merkle path + batch
    metadata once anchored; `404` for unknown.
  - `GET /api/v1/settlement-anchors/:batchId` — returns the signed
    batch metadata (root, leaf count, optional chain reference).

Doctrinal sibling-fix: the catch-all `/api/v1/*` bearer-auth
middleware was gating all four anchor-proof endpoints (credential

- settlement). That contradicts services/api CLAUDE.md rule 6 —
  "every truth the relay asserts is independently verifiable onchain
  without relay contact." An external auditor doesn't hold a relay
  bearer token. Both endpoint pairs are now allowlisted as public,
  rate-limited at the same `publicLimiter` tier as `/credentials/verify`.

External verifier flow now mechanical: fetch SettlementRecord +
proof + chain tx → verify Ed25519 signature → reconstruct leaf →
walk Merkle path → compare root to chain. No relay contact needed
beyond the initial proof fetch.
