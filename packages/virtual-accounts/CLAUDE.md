# @motebit/virtual-accounts

Per-motebit ledger. Integer micro-units (1 USD = 1,000,000), credit/debit with transaction audit log, withdrawal lifecycle (request → link → complete | fail), dispute-window hold, Ed25519-signed withdrawal receipts.

Layer 1. BSL-1.1. Depends only on `@motebit/crypto` (Layer 0 Apache-2.0 permissive floor — `canonicalJson`, `ed25519Sign`, `toBase64Url` for receipt signing). Persistence is inverted: the package defines an `AccountStore` interface and ships `InMemoryAccountStore` for tests. Consumers (services/relay) provide their own `AccountStore` implementation — typically `SqliteAccountStore` over `@motebit/persistence`'s `DatabaseDriver`.

## Rules

1. **Money path is integer micro-units, end to end.** No `number` that represents dollars crosses an internal function boundary. Conversions happen at the outer edge (`toMicro` on API ingest, `fromMicro` on API egress). A single `0.1 + 0.2 === 0.30000000000000004` anywhere in the ledger is unacceptable.
2. **`credit` and `debit` are atomic compound operations.** The interface contract says: balance update and transaction-log append happen atomically under concurrent callers. `debit` returns `null` on insufficient funds — never a partial debit. `InMemoryAccountStore` uses synchronous JS (the event loop serializes); SQLite implementations use atomic `UPDATE ... WHERE balance >= amount` or a transaction wrapper. This is Rule 12 of the relay's doctrine expressed as an interface contract.
3. **Dispute-window hold is policy input, not dispute-domain knowledge.** `AccountStore.getUnwithdrawableHold(motebitId)` returns an amount. The store implementation computes it from whatever tables it owns (dispute window timer, active disputes, unfinalized settlements). The ledger functions in this package do not know about `relay_settlements` or `relay_disputes`.
4. **Receipt signing is canonical-JSON-over-the-record.** `signWithdrawalReceipt` takes a fixed field set; adding fields requires coordinated verification code elsewhere. Keep the signed payload small and stable — every field in the signed record is a wire commitment.
5. **No SQL, no DB types.** The package must not import from `@motebit/persistence` and must not contain SQL strings. The `AccountStore` interface is the only coupling point to storage.
6. **Withdrawals atomically return funds on failure.** `failWithdrawal` credits the amount back within the same logical operation as the status update. Partial state — "failed but not refunded" — is forbidden.

## What NOT to add

- A `withTransaction(fn)` primitive on `AccountStore`. Cross-table atomicity belongs in compound methods (`debitAndEnqueuePending` is the Phase 2 shape for aggregated withdrawals), not a generic transaction leak.
- Stripe, Bridge, or x402 knowledge. Medium plumbing sits in the consumer.
- Settlement-proof storage. That lives alongside the settlement-rail adapters that produce the proofs; the ledger only sees the rail-agnostic `WithdrawalRequest.payout_reference` field.
- Cross-table reconciliation. The ledger exports invariants about _its own_ tables only — cross-table audit is a consumer-layer concern.
- Database bootstrap. The consumer runs migrations before constructing the store; the package assumes schema exists.

## Consumers

- `services/relay` — the relay. Provides `SqliteAccountStore` against its `DatabaseDriver` and wires the ledger into deposit, withdrawal, task-settlement, and dispute-refund paths. During the shim-deprecation window, `services/relay/src/accounts.ts` re-exports this package's API with a singleton SQLite store to keep legacy imports working.
