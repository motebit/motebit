---
"@motebit/relay": patch
---

Make every virtual-account ledger write atomic. `SqliteAccountStore.credit`, `debit` and `debitSpendable` ran the balance UPDATE and the `relay_transactions` INSERT as separate autocommit statements, so a failed ledger INSERT left the balance moved with no ledger row — and because reference dedup reads the ledger, a replayed Stripe checkout credited again (balance 10M, ledger 5M). Each now runs in one `DatabaseDriver.transaction` (nesting as a savepoint inside a caller's), `debitAndEnqueuePending` moves its replay check inside its transaction, and every check-then-credit by reference — `processStripeCheckout`, `grantFreeCreditIfEligible`, `creditX402Settlement` (raw `BEGIN` replaced), the proxy usage debit and the session-status subscription credit — commits its check with its write. Pinned by a fault-injection harness that fails each writer at every statement boundary and asserts balance == ledger and replay-applies-once.
