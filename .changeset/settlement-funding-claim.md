---
"@motebit/relay": patch
---

Settlement credits the worker only when the ledger actually holds the funds.

The funding claim asked whether the allocation ROW was still `'locked'`, never
whether anything had been debited for it. A priced listing with no
`pay_to_address` books an allocation with no hold, so a self-delegated task
against one credited a worker from nothing. The claim is now ledger-derived —
and, critically, the ledger is read BEFORE the status UPDATE, so an unfunded
allocation is left `'locked'` rather than marked `'settled'` with no settlement
row (which would break reconciliation invariant 3). Earmarked x402 funds are
also excluded from the escrow-hold net at submission, so a delegator who has
already paid onchain can still take a real hold.
