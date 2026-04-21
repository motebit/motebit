---
"@motebit/api": minor
---

Validate inbound wire-format bodies against `@motebit/wire-schemas` at
the relay boundary. Hand-rolled `as Type` casts are no longer the
first line of defense — schemas parse bodies (or reject 400) before
any handler touches them, fail-closed.

Handlers wired:

- `POST /agent/:motebitId/verify-receipt` — body is `ExecutionReceipt`
- `POST /agent/:motebitId/task/:taskId/result` — body is
  `ExecutionReceipt`; replaces the structural `typeof`/status
  allowlist
- `POST /federation/v1/task/result` — nested `body.receipt` is
  `ExecutionReceipt`
- `POST /api/v1/agents/accept-migration` — nested `migration_token`,
  `departure_attestation`, `credential_bundle` validated against
  `MigrationTokenSchema`, `DepartureAttestationSchema`,
  `CredentialBundleSchema` respectively

The package was already a Layer-1 BSL primitive pinned to
`@motebit/protocol` types by drift defenses #22 and #23; the relay
was the last unconsumed boundary. Non-motebit implementers (Python,
Go, Rust workers) have been able to hit the published JSON Schemas
for months — the runtime guard now matches the declared contract.

Error body keeps the existing `{ error }` convention — callers see
the zod `flatten()` shape on schema failure instead of a bespoke
"missing field X" string.

Endpoints with no matching wire schema (e.g. federation peering,
sync push, task submit, dispute filing, subscription webhooks) are
untouched — the submission shapes there are ad-hoc input bodies
that the relay uses to construct wire artifacts, not wire artifacts
themselves. If a missing schema is later identified as a wire
artifact, the fix is to add the schema in `@motebit/wire-schemas`
and wire it in here — never to inline validation in the service.
