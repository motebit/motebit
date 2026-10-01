---
"@motebit/relay": patch
---

Dispute fund actions move only what the ledger still holds (dispute-v1 §7.3).

The fund action read `amount_locked` and the allocation's status, which say what
was once held, not what is left. A failed receipt refunds the whole hold and
still closes the allocation `settled`, so a dispute filed on it paid
`amount_locked` again (a second refund, or the worker paid money never locked).
A dispute a pre-claim-table relay finalized left no claim row and its allocation
`disputed`, so a live legacy duplicate resolved and paid again after upgrade.

The fund action now derives, inside the resolving transaction, the escrow still
held (hold debits − releases − settlement credits and fee − federated forwards −
prior dispute rows) and, per account, what the worker leg was actually paid.
Pre-settlement it moves at most the remaining escrow, to the hold payer and the
allocation's worker; post-settlement it reverses at most what was paid, from the
account the ledger shows received it. Any ledger row already referenced to a
dispute of the allocation counts as a prior fund action, and migration 50
backfills `relay_dispute_fund_actions` from disputes already final.
