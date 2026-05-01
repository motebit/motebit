---
"@motebit/protocol": minor
---

Retention policy phase 6b — `RUNTIME_RETENTION_REGISTRY` + `check-retention-coverage` hard drift gate.

`@motebit/protocol`: new `RUNTIME_RETENTION_REGISTRY` constant — the canonical registry of runtime-side stores subject to retention doctrine, mapping each `RuntimeStoreId` (`memory` | `event_log` | `conversation_messages` | `tool_audit`) to its registered `RetentionShapeDeclaration`. Per-motebit runtimes project this registry into their published retention manifests. The relay's deployment doesn't host these stores; its retention manifest declares `out_of_deployment:` for them by design (sibling boundary preserved).

New drift gate `scripts/check-retention-coverage.ts` (invariant #67, sibling enforcement pattern to `check-consolidation-primitives` and `check-suite-declared`). Bidirectional check across the runtime-side surfaces (`apps/mobile`, `apps/desktop`, `packages/persistence`, `packages/browser-persistence`):

- **Forward**: every entry in `RUNTIME_RETENTION_REGISTRY` has a matching `CREATE TABLE` in at least one runtime-side surface; `consolidation_flush`-shape entries also carry a `sensitivity` column (in the at-rest schema or via `ALTER TABLE ADD COLUMN` migration).
- **Reverse**: every `CREATE TABLE` with a `sensitivity` column maps to a registered store. A future schema adding `sensitivity TEXT` without registering would otherwise leak past the doctrinal ceiling because the consolidation cycle's flush phase doesn't see unregistered stores.

The doctrine reserved drift-defense slot #52 in phase 1; that slot was occupied during post-doctrine renumbering, so the gate landed at the next free invariant number (#67). Doctrine prose at `docs/doctrine/retention-policy.md` §"Drift defense" updated to reflect the durable assignment.

Closes the meta-version of the original CLAUDE.md gap that motivated the entire retention-policy arc — "fail-closed privacy" claimed retention enforcement existed; phases 2–5 built the enforcement; this gate makes the doctrinal claim self-attesting at CI time.
