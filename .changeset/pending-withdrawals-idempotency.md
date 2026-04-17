---
"@motebit/virtual-accounts": patch
"motebit": patch
---

Close the idempotency contract on `debitAndEnqueuePending`.

The `AccountStore.debitAndEnqueuePending` interface documented an
idempotency key for "external replay protection" that neither
implementation honored — a second call with the same `(motebitId,
idempotencyKey)` would silently debit the account a second time and
insert a duplicate `relay_pending_withdrawals` row. The parameter was
live wiring (plumbed through `enqueuePendingWithdrawal` and the sweep
loop) waiting for a consumer to discover the gap.

Fix mirrors the sibling `requestWithdrawal` + `insertWithdrawal`
pattern that already exists for user-initiated withdrawals: a replay
pre-check inside the compound primitive, plus a schema-level partial
UNIQUE INDEX as belt-and-suspenders.

- `packages/virtual-accounts`: both `InMemoryAccountStore` and the
  interface contract doc describe the replay semantics — on
  `idempotencyKey !== null` match, return the existing `pendingId` and
  current balance without debiting or inserting again. `null` keys are
  never deduplicated.
- `services/api`: `SqliteAccountStore.debitAndEnqueuePending` gains the
  same pre-check. Migration v12 adds
  `idx_pending_withdrawals_idempotency` — a partial UNIQUE INDEX on
  `(motebit_id, idempotency_key) WHERE idempotency_key IS NOT NULL` —
  so a direct INSERT that skips the primitive still hits the guard.
  Mirrors `idx_relay_withdrawals_idempotency` byte-for-byte.
