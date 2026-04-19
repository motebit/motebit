---
"@motebit/wire-schemas": minor
---

`BalanceWaiver` becomes a first-class wire-format artifact — closes the last named loose end in the wire-schemas publication chain.

`BalanceWaiver` is the agent-signed alternative to the standard withdrawal flow for advancing migration to `departed` (spec/migration-v1.md §7.2; foundation law §7.3). The TypeScript type has lived in `@motebit/protocol` since the migration spec landed, but the runtime-validatable schema and the committed JSON Schema were tracked as the single TODO in `scripts/check-spec-wire-schemas.ts`'s `WAIVERS` table — covered by invariant #23, but only as debt, not as ship.

This pass closes it:

- **`BalanceWaiverSchema`** in `packages/wire-schemas/src/migration.ts` — five fields (`motebit_id`, `waived_amount`, `waived_at`, `suite`, `signature`) using the cluster's existing `suiteField()` and `signatureField()` factories. Forward + reverse type-parity assertion against `@motebit/protocol`'s `BalanceWaiver` interface; placed between `DepartureAttestation` (§5) and `MigrationPresentation` (§8) to mirror the spec section order.
- **`BALANCE_WAIVER_SCHEMA_ID`** + **`buildBalanceWaiverJsonSchema`** exported from the same module and re-exported from `packages/wire-schemas/src/index.ts`. Stable `$id` URL: `https://raw.githubusercontent.com/motebit/motebit/main/packages/wire-schemas/schema/balance-waiver-v1.json`.
- **`schema/balance-waiver-v1.json`** — committed JSON Schema, generated via `pnpm --filter @motebit/wire-schemas build-schemas`. Third-party Python/Go/Rust verifiers consume it at the URL with no monorepo dependency.
- **Drift gate (#22)** wired: `drift.test.ts` adds the case so the committed JSON pins to the live zod source on every CI run; the per-property description, `$id`, `$schema`, and roundtrip assertions all run against it.
- **Runtime-parse tests** (`migration.test.ts`) add the BalanceWaiver block — six assertions covering valid parse, zero-amount edge case, unknown cryptosuite rejection, strict-mode extra-key rejection, missing-signature rejection, and empty-motebit-id rejection.
- **`WAIVERS` entry removed** from `scripts/check-spec-wire-schemas.ts`. The migration cluster's wire-format coverage is now end-to-end: 5 artifacts, 5 schemas, zero waivers. The migration loop is fully verifiable from published JSON Schemas alone.

The check-spec-wire-schemas waiver list now holds exactly one entry — `CapabilityPrice` — and that one is structural (covered by the parent `AgentServiceListingSchema`), not debt. The "TODO: ship as standalone schemas" section of the waiver table is empty.
