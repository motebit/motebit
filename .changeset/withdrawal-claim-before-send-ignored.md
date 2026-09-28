---
"@motebit/relay": patch
"@motebit/virtual-accounts": minor
---

A withdrawal payout is sent only after it CLAIMS the withdrawal, and the operator can no longer refund a payout that may still land (#921).

Before: Path 0 (Solana) and Path 1 (x402) sent the payout while the withdrawal was still `pending`. An operator's `POST /api/v1/admin/withdrawals/:id/fail` during the in-flight send refunded it; the send then confirmed and the user was paid AND refunded, with the row reading `failed` (`completeWithdrawal`'s `false` was ignored).

Now:

- `@motebit/virtual-accounts`: `claimWithdrawalForPayout` (the compare-and-set `pending → processing`, stamping `claimed_at`). `completeWithdrawal` (`from` arg), `failWithdrawal` (`from` param), and the store's `setWithdrawalCompletion` / `failWithdrawalAndRefund` name the state they move FROM (`WithdrawalOpenStatus`), checked at runtime. `noteWithdrawalPayoutUnresolved` writes only on a `processing` withdrawal. The package is private, and the relay is its only consumer.
- `@motebit/relay`: `/withdraw` claims before sending. A lost claim sends nothing. The outcome settles FROM `processing`, and a settling write that loses is logged at error level. An unknown outcome (the send threw, the process died) leaves the withdrawal `processing` rather than `pending`. Admin `/complete` and `/fail` act on `pending` only and answer 409 "payout in flight" on `processing`. The new `POST /api/v1/admin/withdrawals/:id/reconcile` (`outcome: paid | not_paid`, a required `attestation`) settles a `processing` withdrawal. It refuses while the send is awaited in-process and within `RECONCILE_MIN_AGE_MS` (15 min) of the claim. Batch-withdrawal fires that the rail has not confirmed are recorded as `processing`, not `pending`. spec/market-v1.md §10.2–§10.4 states the processing claim.
