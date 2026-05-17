---
"@motebit/wire-schemas": minor
"@motebit/persistence": patch
---

Mirror the `SettlementRecord.settlement_mode` field landed in `@motebit/protocol` across the wire-schema validator and the agent-side SQLite store. Sibling of the `@motebit/protocol` major bump in `settlement-mode-on-receipt-body.md`; documented separately because both packages are configured as ignored (their changelogs surface in deploy notes only).

**`@motebit/wire-schemas`** — `SettlementRecordSchema` adds a required `settlement_mode` field with closed-enum validation against `ALL_SETTLEMENT_MODES`. Strict mode rejects unknown values (`"treasury"`, `"managed_relay"`, etc.) so an audit-shaped vocabulary cannot leak into the settlement-lane registry. JSON schema regenerated at `spec/schemas/settlement-record-v1.json`. The type-parity assertion `_SETTLEMENT_RECORD_TYPE_PARITY` keeps the zod and protocol shapes in lockstep — protocol's interface change forces this package to land the matching field in the same release.

**`@motebit/persistence`** — migration v37 adds the `settlements.settlement_mode` column (TEXT, default `'relay'` for backward-compat with rows persisted before the field existed). `rowToSettlement` COALESCEs to `"relay"` on read so pre-v37 rows surface a defensible default; new writes set the column explicitly. The `SqliteSettlementStore.stmtCreate` INSERT statement adds the column to its parameter list. The persistence consumer is the agent-side SQLite store; the relay's `relay_settlements` table already had a `settlement_mode` column (introduced in the relay's own migration ladder for the p2p audit path) — this change only widens the persistence-package store to match.

Doctrine touchpoints: [`docs/doctrine/settlement-rails.md`](../docs/doctrine/settlement-rails.md) § "Lanes for external readers" lands a translation table mapping motebit-native names (`treasury` / `relay` / `p2p`) to the FinCEN-shaped vocabulary external readers will recognize. The root `CLAUDE.md` "Economic loop" principle gains one sentence: "The relay records all settlement; it custodies only guest-rail settlement; it coordinates regardless of custody."
