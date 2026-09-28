---
"@motebit/relay": patch
"@motebit/virtual-accounts": minor
---

A task is no longer admitted as funded when no money was held for it (#901).

`POST /agent/:motebitId/task` holds the budget with `debitSpendableAccount`, which returns null when the spendable balance (balance minus the dispute-escrow hold) cannot cover the hold. Submission ignored that null. On the x402 path it also sized the hold from the raw balance while the debit netted the escrow hold. When the raw balance covered the hold and the spendable balance did not, the relay booked a `locked` allocation and admitted the task with nothing debited. When no allocation was possible, it booked an unfunded "best-effort" allocation.

- **`computeSpendableAvailable(store, motebitId)`** (`@motebit/virtual-accounts`, new) is `max(0, balance − escrow hold)`. It is the number `debitSpendable` enforces and the spend-side sibling of `computeWithdrawableAvailable`. The relay reads it through `getSpendableBalance`.
- **One spendable definition for the check and the debit, on every funding path.** The relay-custody budget, the x402 path and the x402-gate bypass all read `getSpendableBalance`. The bypass used to read the raw balance, so a balance under the escrow hold skipped x402 and was then refused 402 on every retry.
- **A null debit is a 402 (`INSUFFICIENT_FUNDS`) raised inside the admission transaction.** The allocation row, the queued task and the idempotency claim binding all roll back, and the key is freed (a pre-admission refusal, `spec/delegation-v1.md` §3.3). A same-key retry after funding admits one task with one debit.
- **The unfunded "best-effort" allocation on the x402 path is removed.** A priced task whose spendable balance is below the price is refused 402 on the x402 path too. An x402 payment already credited stays in the delegator's virtual account.
- **The x402 hold may now be smaller than the 1.2× risk buffer.** When escrow-held earnings net part of the buffer, the hold is sized to what the ledger can actually debit (at least the price), rather than a larger hold that was never debited.
