---
"@motebit/api": patch
---

Fix: relay_credentials.anchor_batch_id column missing on fresh DBs
(latent since credential anchoring shipped 2026-04-10).

The column was added via an idempotent `ALTER TABLE` inside
`createCredentialAnchoringTables()`, but that helper runs BEFORE the
migration that creates `relay_credentials` — `createSyncRelay` calls
`createFederationTables` (which depends on pairing/data-sync tables
for later migrations) ahead of `createRelaySchema` (which runs
migrations). The ALTER silently failed; the migration then created
`relay_credentials` without the column. Result: the credential
anchor-proof endpoint was non-functional end-to-end on any fresh
relay.

Fix: migration v15 adds the column with a PRAGMA-guarded ALTER
plus the partial index on unanchored rows that mirrors the v14
index on `relay_settlements`. Surfaced by the HTTP integration
test added for the credential anchor-proof endpoint as part of
the sibling-boundary closure of the anchor-proof auth-allowlist
fix (services/api CLAUDE.md rule 6).
