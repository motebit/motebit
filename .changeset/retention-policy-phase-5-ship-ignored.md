---
"@motebit/runtime": patch
"@motebit/persistence": patch
"@motebit/privacy-layer": patch
"@motebit/relay": patch
"@motebit/desktop": patch
"@motebit/mobile": patch
---

Retention policy phase 5-ship — runtime flush phase + per-surface adapter implementations + relay manifest split.

`@motebit/runtime`: new `flush` phase in `consolidation-cycle.ts`, registered as the fifth phase after `prune`. Per `docs/doctrine/retention-policy.md` §"Consolidation flush", the flush phase iterates the conversation store and tool-audit sink for records past `max(sensitivity_floor, obligation_floor)`, lazy-classifies on read per decision 6b when sensitivity is missing, and signs a `consolidation_flush` cert per arm before erasing the row. Sibling discipline to `prunePhase`: same retention-floor calculation pattern, same `self_enforcement` / `retention_enforcement_post_classification` reason discipline (decision 5), same fail-soft per-record behavior. New `ConsolidationCycleDeps` fields: `conversationStore`, `toolAuditSink`, `toolAuditObligationFloorMs`, `preClassificationDefaultSensitivity`. `ConversationManager` threads a default sensitivity (operator manifest's `pre_classification_default_sensitivity`, defaulting to `personal`) onto every persisted message.

`@motebit/persistence`: `conversation_messages.sensitivity` and `tool_audit_log.sensitivity` columns added to the at-rest schema and via migration v34 (sibling entries land in mobile v19 and desktop v1 the same release). `SqliteConversationStore` gains `enumerateForFlush` + `eraseMessage`; `SqliteToolAuditSink` gains `enumerateForFlush` + `erase`. Persistence's `ConversationMessage` row type carries the sensitivity field through the sync path.

`@motebit/privacy-layer`: new `signFlushCert(args)` primitive on the `PrivacyLayer` facade, backed by `DeleteManager.flushRecord` (sibling to `deleteMemory`). Constructs and signs a `consolidation_flush` deletion certificate, writes the audit trail. Cert is signed by the subject's identity key per decision 5; the consolidation cycle is the primary caller. Caller is responsible for the underlying erase — privacy-layer signs the cert and audits.

`services/relay`: phase 6a follow-up — `RETENTION_MANIFEST_CONTENT.honest_gaps` split into three discriminator-prefixed categories per the doctrine's three-category split:

- `pending:` — operational ledgers + onchain-anchor concerns this operator WILL run once enforcement lands (phase 4b-3).
- `out_of_deployment:` — `conversation_messages` + `tool_audit` are runtime-side (per-motebit, on the user's device) and never appear in this operator-level manifest. Each motebit's runtime publishes its own retention manifest.
- `different_mechanism:` — presence data governed by the operator-transparency manifest, not this one.

The original phase-6a manifest conflated these — pending and out-of-deployment were both written as "phase X will fill this in," falsely implying the relay would eventually own conversation retention. The split makes the deployment boundary legible to verifiers.

`apps/desktop`: tauri-storage's `TauriConversationStore` gains `preloadFlushCandidates` + sync `enumerateForFlush` (renderer-cache-backed, same IPC-async-to-sync pattern as `loadMessages`) and `eraseMessage`. tauri-system-adapters' `TauriToolAuditSink` gains the same shape. `tauri-migrations.ts` registers v1 — first entry to land here, applied via `runMigrationsAsync`. Desktop SQLite at-rest schema in `apps/desktop/src-tauri/src/main.rs` carries the `sensitivity` column on fresh installs.

`apps/mobile`: `ExpoSqliteConversationStore` and `ExpoToolAuditSink` gain `enumerateForFlush` + `erase{Message}`. `expo-sqlite-migrations.ts` registers v19. The SCHEMA constant carries the `sensitivity` column for fresh installs.
