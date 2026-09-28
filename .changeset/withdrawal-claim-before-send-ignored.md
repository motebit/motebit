---
"@motebit/relay": patch
"@motebit/virtual-accounts": minor
"@motebit/operator": patch
"@motebit/settlement-rails": minor
---

A withdrawal payout is sent only after it CLAIMS the withdrawal, and the operator can no longer refund a payout that may still land (#921).

Before: Path 0 (Solana) and Path 1 (x402) sent the payout while the withdrawal was still `pending`. An operator's `POST /api/v1/admin/withdrawals/:id/fail` during the in-flight send refunded it; the send then confirmed and the user was paid AND refunded, with the row reading `failed` (`completeWithdrawal`'s `false` was ignored).

Now:

- `@motebit/virtual-accounts`:
  - `claimWithdrawalForPayout` is the compare-and-set `pending → processing` and stamps `claimed_at`.
  - `completeWithdrawal` (`from` arg), `failWithdrawal` (`from` param), and the store's `setWithdrawalCompletion` / `failWithdrawalAndRefund` name the state they move FROM (`WithdrawalOpenStatus`), checked at runtime.
  - `noteWithdrawalPayoutUnresolved` writes only on a `processing` withdrawal.
  - The blind status setter `AccountStore.updateWithdrawalStatus` is deleted. It had no production caller.
  - The package is private, and the relay is its only consumer.
- `@motebit/relay`:
  - `/withdraw` claims before sending. A lost claim sends nothing.
  - The outcome settles FROM `processing`, and a settling write that loses is logged at error level.
  - An unknown outcome (the send threw, the process died) leaves the withdrawal `processing` rather than `pending`.
  - Admin `/complete` and `/fail` act on `pending` only and answer 409 "payout in flight" on `processing`.
  - The new `POST /api/v1/admin/withdrawals/:id/reconcile` (`outcome: paid | not_paid`, a required `attestation`) settles a `processing` withdrawal. It refuses while the send is awaited in-process and within `RECONCILE_MIN_AGE_MS` (15 min) of the claim.
  - Batch-withdrawal fires that the rail has not confirmed are recorded as `processing`, not `pending`.
  - `relay_withdrawal_claim_epoch` records the first boot of the claiming code. It is written once and never updated.
  - `/admin/withdrawals/pending` adds `payout_may_have_been_attempted` per row, plus `reconcile_min_age_ms` and `claim_epoch`.
  - The new read-only `GET /api/v1/admin/withdrawals/pre-claim` lists pending Solana and 0x withdrawals requested before that epoch.
  - spec/market-v1.md §10.2–§10.4 states the processing claim.
- `@motebit/operator` (WithdrawalsPanel):
  - A `processing` row shows as "payout in flight", with its claim time and age, and offers no complete or fail.
  - A Reconcile action takes an outcome, a required attestation, and a payout reference (required for `paid`). It enables only once the claim is older than the `reconcile_min_age_ms` the relay reports.
  - A 409 `WITHDRAWAL_PAYOUT_IN_FLIGHT` re-reads the queue and shows the row's state instead of an error.
  - A pre-claim pending row carries the warning "a payout may have been attempted — check the chain before failing", in the row and in the fail confirmation.
  - Amounts are shown as the decimal USD the relay sends; the panel had been dividing them by 10^6 a second time.

Round 3 (cold review):

- A payout stays "in flight" (reconcile refused) from its claim until its outcome is WRITTEN, not only until the send returns. Before this, a reconcile during the receipt signing could refund a payout that had landed.
- The reconcile door opens at the payout's own horizon (`payout-horizon.ts`), never at a fixed 15 minutes:
  - x402: the signed authorization's `validBefore` (1h) plus a margin.
  - Solana: the last moment this relay could have broadcast, plus a blockhash lifetime, plus a margin.
  - A batch rail that declares no horizon: 24h.
  - `RECONCILE_MIN_AGE_MS` is now only a floor. A refusal carries `reconcile_opens_at`, and `/pending` reports it per row.
- `@motebit/settlement-rails`: `X402_WITHDRAWAL_VALIDITY_SECONDS`, `isManualPayoutRail` and `payoutValidityMsOf`. Stripe declares `payoutMode: "manual"`; x402 declares `payoutMode: "sent"` and `payoutValidityMs`.
- Batch: a manual rail's fire stays `pending`, so admin `/complete` and `/fail` work (main parity).
- Pre-claim rows are marked durably (`pre_claim_review`), once, by the migration that adds `claimed_at`. The earlier wall-clock epoch is gone. A pending row with a payout reference is flagged too.
- Operator: a reconcile 409 says inline "payout still in flight — opens in Xm", keeping the form. Gating reads the relay's per-row `reconcile_opens_at`.
