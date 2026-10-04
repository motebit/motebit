---
"@motebit/settlement-rails": minor
"@motebit/relay": patch
---

Batched withdrawals no longer strand the agent's debit when a payout fails. A failure is refunded only when the payout provably never left — a new `PayoutNotSentError` (thrown by a rail only before anything is signed or broadcast; `isPayoutNotSent` reads it) or a manual rail's failure — exactly once, in one transaction with the queue row's status change, and a refund the emergency freeze refuses is retried after unfreeze. Every other failure is never refunded: it is held as a `processing` withdrawal that the operator's #921 reconcile settles. The x402 rail throws `PayoutNotSentError` for requests it rejects before contacting the facilitator.
