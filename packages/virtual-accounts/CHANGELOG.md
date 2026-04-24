# @motebit/virtual-accounts

## 0.2.0

### Minor Changes

- 1690469: Wire `BalanceWaiver` producer + verifier (spec/migration-v1.md §7.2). `@motebit/crypto` adds `signBalanceWaiver` / `verifyBalanceWaiver` / `BALANCE_WAIVER_SUITE` alongside the existing artifact signers; `@motebit/encryption` re-exports them so apps stay on the product-vocabulary surface. `@motebit/virtual-accounts` gains a `"waiver"` `TransactionType` so the debit carries a dedicated audit-trail category. The relay's `/migrate/depart` route now accepts an optional `balance_waiver` body — balance > 0 requires either a confirmed withdrawal (prior behavior) or a valid signed waiver for at least the current balance; the persisted waiver JSON is stored verbatim on the migration row for auditor reverification. The `motebit migrate` CLI gains a `--waive` flag that signs the waiver with the identity key and attaches it to the depart call, with a destructive-action confirmation prompt. Closes the one-pass-delivery gap left over from commit `7afce18c` (wire artifact without consumers).

### Patch Changes

- a792355: Close the idempotency contract on `debitAndEnqueuePending`.

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

- Updated dependencies [bce38b7]
- Updated dependencies [9dc5421]
- Updated dependencies [1690469]
- Updated dependencies [d969e7c]
- Updated dependencies [009f56e]
- Updated dependencies [25b14fc]
- Updated dependencies [3539756]
- Updated dependencies [28c46dd]
- Updated dependencies [2d8b91a]
- Updated dependencies [f69d3fb]
- Updated dependencies [e17bf47]
- Updated dependencies [58c6d99]
- Updated dependencies [3747b7a]
- Updated dependencies [db5af58]
- Updated dependencies [1e07df5]
  - @motebit/crypto@1.0.0
