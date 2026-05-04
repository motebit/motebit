---
"@motebit/protocol": minor
---

Add `"skill_audit"` to `RuntimeStoreId` and register a `consolidation_flush` retention shape for it in `RUNTIME_RETENTION_REGISTRY`. Mirrors the existing `tool_audit` registration — append-only operator-act ledger with a `sensitivity` column on the `skill_consent_granted` variant; the consolidation cycle's flush phase respects sensitivity-tier retention ceilings. No min-floor resolver because skill audit doesn't gate settlement.

The new store ships with the durable consent-audit arc on web (`packages/browser-persistence/src/idb-skill-audit.ts`) and mobile (`apps/mobile/src/adapters/expo-sqlite.ts` — `ExpoSqliteSkillAuditSink` over the `skill_audit` SQLite table). Closes the consent-gate arc's runtime gap: `SkillConsentGrantedEvent` now lands in a registered, retention-aware durable store instead of the protocol-only type slot it occupied before.
