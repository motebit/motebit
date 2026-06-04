---
"@motebit/protocol": minor
"@motebit/state-export-client": minor
---

Settlement-summary export — the money side of the first-person trust graph (published half; the `@motebit/relay` + `@motebit/panels` half is in the sibling changeset). Doctrine: `docs/doctrine/agents-as-first-person-trust-graph.md` §6.

- `@motebit/protocol`: `settlement-summary` added to the `ContentArtifactType` registry (14th type) + the `SettlementSummaryExport` / `SettlementSummaryPeer` / `SettlementSummaryUnattributed` wire-body types. A per-peer economic projection over the relay's signed settlement ledger — a materialized projection in micro-units, never a denormalized balance.
- `@motebit/state-export-client`: `verifiedSettlementSummaryFetch` + `settlementSummaryUrl` — typed, fail-closed verified fetch for `/api/v1/agents/:motebitId/settlements`. Centralizes the URL (so surfaces can't fetch the money history without verifying it) and rejects a manifest signed for a different export (`unexpected_artifact_type`, the new fail-closed reason on `StateExportVerificationFailureReason`).
