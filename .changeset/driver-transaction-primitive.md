---
"motebit": patch
---

Close H3 from the `cd70d3d8..HEAD` security audit — add a
`transaction<T>(fn): T` primitive to `DatabaseDriver` and migrate the
two raw-`BEGIN`/`ROLLBACK` call sites off hand-rolled strings.

The prior pattern in `SqliteAccountStore.debitAndEnqueuePending` and
in `buildCreditOnDepositCallback` issued `db.exec("BEGIN")` /
`db.exec("COMMIT")` / `db.exec("ROLLBACK")` directly. That's brittle
under nesting (a second BEGIN throws), under ROLLBACK-after-BEGIN-fail
(masks the original error), and under driver swap (sql.js has no
native helper; better-sqlite3 does).

The new primitive lives at the persistence boundary — one layer below
`@motebit/virtual-accounts`'s `AccountStore`, where the rule
"no `withTransaction(fn)` on the ledger interface" still stands.
Services that need multi-statement atomicity no longer reinvent
BEGIN/COMMIT.

Driver implementations:

- **BetterSqliteDriver** delegates to native `inner.transaction(fn)()`,
  which handles savepoint-based nesting automatically.
- **SqlJsDriver** runs `BEGIN`/`COMMIT`/`ROLLBACK` on the outer call
  and `SAVEPOINT`/`RELEASE`/`ROLLBACK TO` for nested calls, matching
  the better-sqlite3 shape exactly.

Call-site migration:

- `SqliteAccountStore.debitAndEnqueuePending`: wraps the three-statement
  debit + ledger + pending insert in `db.transaction`. The
  insufficient-funds path now returns `null` from the fn (empty
  transaction commits harmlessly); any other throw rolls back.
- `buildCreditOnDepositCallback` in `services/api/src/deposit-detector.ts`:
  same shape — the credit + dedup-insert pair runs inside `db.transaction`.

Tests: 10 new in `packages/persistence/src/__tests__/transaction.test.ts`
covering commit-on-return, rollback-on-throw, null-return semantics,
nesting (inner throw vs outer throw), and sequential top-level
independence. Exercised against **both** driver implementations. All
862 services/api tests and 165 persistence tests still pass. 15 drift
gates green.
