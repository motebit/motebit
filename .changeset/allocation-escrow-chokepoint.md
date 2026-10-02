---
"@motebit/relay": patch
---

Every movement of allocation money goes through one chokepoint, and what an
allocation still holds is one function over explicit states.

`moveAllocationMoney` (`allocation-escrow.ts`) is now the only writer of
allocation money: the hold, a settlement's fee, payee credit and release, a
federated forward and its return, the retry-exhaustion refund, the stale sweep,
and a dispute's claw-back / worker / delegator legs. Inside the caller's
transaction it reads what the allocation holds, refuses (a typed
`AllocationMoneyRefused`, nothing written) an amount above it or a payee that is
not a party of that allocation, and stamps the ledger row with the allocation
and the movement's kind. AFTER INSERT triggers refuse, at the database, any row
that would leave an allocation's held negative.

Fixed through it:

- A federated forward was counted as moved from the moment it was recorded, so
  when delivery retries were exhausted the refund read 0 and the allocation was
  retired `released` holding the delegator's money. A forward is now `pending`
  until the peer acknowledges it (`delivered`) or its retries are exhausted
  (`failed`, its gross back in escrow); the failure and the refund run in one
  transaction. A peer that no longer exists now takes the same path.
- A legacy dispute on one allocation naming another allocation's task counted
  as that other allocation's prior fund action, which then closed `released`
  with its escrow still held. Dispute rows count for the allocation they moved.
- A round-2 verdict whose claw-back was refused rolled back to `appealed` with
  nothing ever retrying it. Its signed round-2 resolution is now persisted and
  every read of the dispute retries it.
- The exhaustion refund (and the sweep) paid the task queue's submitter, falling
  back to the allocation's worker when the queue had lost the entry. Every
  refund now pays the allocation's hold payer, read from the ledger; an
  allocation with no single hold payer is flagged, never paid or retired.

Migrations: v51 `allocation_escrow_chokepoint` adds `relay_transactions.allocation_id`
/ `allocation_kind`, `relay_federation_settlements.allocation_id` / `status`
(existing forwards: `failed` if a retry failed, `pending` if one is pending,
otherwise `delivered`), `relay_allocations.review_reason`, and the append-only
`relay_allocation_fees` journal (so a retention truncation of relay_settlements
never turns a settled fee back into escrow); it stamps existing settlement
credits and dispute rows with the allocation they moved, flags for operator
review (`review_reason`) an allocation a legacy cross-allocation dispute touched
(both allocations when a row is ambiguous) or one left released behind a failed
forward, and installs the guard triggers. Gate `check-allocation-money-chokepoint`
(invariant #168) keeps the chokepoint the only writer and the dispute
conservation harness at least as wide as its kinds.
